import { NextResponse } from "next/server";
import { createQuote } from "@/lib/repo";
import { getViewer, demoViewer } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";
import { persistAnalyticsEvent } from "@/lib/analytics-server";
import { clientIp } from "@/lib/client-ip";

export async function POST(req: Request) {
  const ip = clientIp(req.headers);

  // JSON-only: cross-origin form posts cannot produce this content type (§46 CSRF).
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/json")) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
  }

  let user;
  try {
    ({ user } = await getViewer());
    // Demo mode: unauthenticated local visitors act as the demo buyer.
    if (!user) {
      const { isAuthConfigured } = await import("@/lib/auth");
      if (!isAuthConfigured) user = demoViewer().user;
    }
  } catch {
    return NextResponse.json({ error: "auth unavailable" }, { status: 500 });
  }

  if (!user) return NextResponse.json({ error: "login_required" }, { status: 401 });

  const rlUser = await rateLimit(`quote:${user.id}`, 30, 60_000);
  const rlIp = await rateLimit(`quote:ip:${ip}`, 60, 60_000);
  if (!rlUser || !rlIp) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  let domain: string | undefined;
  try {
    const raw = await req.text();
    if (raw.length > 4_096) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    const body = JSON.parse(raw || "{}") as { domain?: string };
    domain = body.domain;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!domain) return NextResponse.json({ error: "domain_required" }, { status: 400 });
  // Layered domain abuse guard (§46): shared Upstash counter, generous so
  // in-memory/C I tests never flap; production throttles hot domains.
  const { normalizeDomain } = await import("@/lib/game.ts");
  const normalizedDomain = normalizeDomain(domain);
  if (normalizedDomain) {
    const rlDomain = await rateLimit(`quote:domain:${normalizedDomain}`, 30, 60_000);
    const rlUserDomain = await rateLimit(`quote:user-domain:${user.id}:${normalizedDomain}`, 8, 60_000);
    if (!rlDomain || !rlUserDomain) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  try {
    const quote = await createQuote(domain, user.id);
    await persistAnalyticsEvent({
      event: "quote_created",
      domain: quote.domain,
      userId: user.id,
      props: { next_price_cents: quote.nextPriceCents },
    });
    return NextResponse.json({ quoteId: quote.id, nextPriceCents: quote.nextPriceCents });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "PROFILE_REQUIRED" || msg.startsWith("PROFILE")) {
      return NextResponse.json({ code: "NO_HANDLE", error: "handle_required" }, { status: 409 });
    }
    if (msg === "ALREADY_HOLDER") {
      return NextResponse.json({ code: "ALREADY_HOLDER", error: "you already hold this tag" }, { status: 409 });
    }
    if (msg.startsWith("DOMAIN_INELIGIBLE")) {
      return NextResponse.json({ code: "INELIGIBLE", error: msg }, { status: 422 });
    }
    if (msg === "ACCOUNT_SUSPENDED") {
      return NextResponse.json({ code: "SUSPENDED", error: "account suspended" }, { status: 403 });
    }
    return NextResponse.json({ error: "quote_failed" }, { status: 500 });
  }
}
