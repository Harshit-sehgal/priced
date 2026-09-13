import { NextResponse } from "next/server";
import { isAllowedAnalyticsEvent } from "@/lib/analytics";
import { rateLimit } from "@/lib/ratelimit";
import { clientIp } from "@/lib/client-ip";
import {
  ANALYTICS_IP_LIMIT,
  ANALYTICS_SESSION_LIMIT,
  ANALYTICS_WINDOW_MS,
  sanitizeAnalyticsProps,
  withinLocalTelemetryBudget,
} from "@/lib/view-events";

export const dynamic = "force-dynamic";

// Accepts analytics events from both server fetch (track()) and client
// beacons (homepage_viewed, domain_searched, share_visit, etc.). Validates
// against the shared taxonomy in analytics.ts and best-effort persists to the
// analytics_events table. Never throws — callers must not fail on tracking.
//
// Abuse posture: this endpoint is unauthenticated by design (anonymous funnel
// measurement) and every accepted request writes a row (~2 KB with indexes) to
// a 500 MB free-tier database, so it is rate limited on IP and on the
// client-supplied session id. A limited request is answered, never thrown from:
// the response carries `ok: true` with a 429 so a naive caller sees success and
// the funnel keeps working, while honest clients/proxies still see the signal.
// Nothing is logged per dropped request on purpose — logging a request flood
// just converts it into a log flood.
export async function POST(req: Request) {
  const ip = clientIp(req.headers);

  const ct = req.headers.get("content-type") ?? "";
  if (!ct.startsWith("application/json")) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
  }

  // In-process budget FIRST, before any network call. The Redis limiter below
  // shares one free-tier Upstash database with the quote/checkout/handle
  // limiters, which fail CLOSED — so an unauthenticated flood that exhausts
  // the command quota would 429 the money path. Even a rejected request costs
  // a command, so the cheap local gate has to come first.
  if (!withinLocalTelemetryBudget("analytics", ip)) {
    return NextResponse.json({ ok: true, dropped: "rate_limited" }, { status: 429 });
  }

  // IP limit before the body is read: shed load as cheaply as possible.
  if (!(await rateLimit(`analytics:ip:${ip}`, ANALYTICS_IP_LIMIT, ANALYTICS_WINDOW_MS))) {
    return NextResponse.json({ ok: true, dropped: "rate_limited" }, { status: 429 });
  }

  // 10 KiB payload limit — analytics events are small; this prevents abuse.
  const raw = await req.text().catch(() => "");
  if (raw.length === 0) return NextResponse.json({ error: "empty_body" }, { status: 400 });
  if (raw.length > 10_240) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const ev = (body as { event?: unknown; props?: unknown; session_id?: unknown }) ?? {};

  const event = typeof ev.event === "string" ? ev.event : "";
  if (!isAllowedAnalyticsEvent(event)) {
    return NextResponse.json({ error: "unknown_event" }, { status: 422 });
  }

  const props = ev.props && typeof ev.props === "object" && !Array.isArray(ev.props)
    ? (ev.props as Record<string, unknown>)
    : {};

  const sessionId = typeof ev.session_id === "string" ? ev.session_id.slice(0, 128) : null;

  // Session dimension: a client-supplied id is not a trust boundary (an
  // attacker rotates it freely), but it bounds one real tab and it stops a
  // single session behind a shared NAT/proxy IP from consuming the IP budget.
  if (sessionId) {
    const okSession = await rateLimit(
      `analytics:session:${sessionId}`,
      ANALYTICS_SESSION_LIMIT,
      ANALYTICS_WINDOW_MS,
    );
    if (!okSession) {
      return NextResponse.json({ ok: true, dropped: "rate_limited" }, { status: 429 });
    }
  }

  const domain = typeof props.domain === "string" ? props.domain.slice(0, 253) : null;
  const handle = typeof props.handle === "string" ? props.handle.slice(0, 64) : null;
  // Drops secret/PII-shaped keys, caps each value at 512 chars, and caps the
  // NUMBER of keys — a 10 KiB body otherwise fits ~200 keys of jsonb per row.
  // `domain`/`handle` are read above, so capping never loses a real column.
  const { props: safeProps } = sanitizeAnalyticsProps(props);

  // Best-effort persist — never fail the request on a DB error.
  try {
    const { persistAnalyticsEvent } = await import("@/lib/analytics-server");
    await persistAnalyticsEvent({
      event,
      sessionId,
      domain,
      handle,
      props: safeProps,
      userId: null, // enriched server-side when known; client calls are anonymous
    });
  } catch {
    // swallow — analytics must never break checkout or navigation
  }

  return NextResponse.json({ ok: true });
}
