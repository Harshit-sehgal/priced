import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { updateProfileExtras } from "@/lib/repo";
import { validateBio, validateCta } from "@/lib/cta";
import { rateLimit } from "@/lib/ratelimit";
import { persistAnalyticsEvent } from "@/lib/analytics-server";

export const dynamic = "force-dynamic";

/**
 * Holder profile extras: bio + CTA. The handle is immutable (ledger identity),
 * so this route only accepts the optional fields. Own-profile only: the
 * session user id must match the profile row being written.
 */
export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/json")) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
  }

  let user;
  try {
    ({ user } = await getViewer());
    if (!user) {
      const { isAuthConfigured } = await import("@/lib/auth");
      if (!isAuthConfigured) {
        const { demoViewer } = await import("@/lib/auth");
        user = demoViewer().user;
      }
    }
  } catch {
    return NextResponse.json({ error: "auth unavailable" }, { status: 500 });
  }
  if (!user) return NextResponse.json({ error: "login_required" }, { status: 401 });

  const rl = await rateLimit(`profile:${user.id}`, 10, 60_000);
  if (!rl) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  // Same 4 KiB body guard as every other mutating route: the raw text is read
  // and capped BEFORE JSON.parse, so an oversized body cannot be parsed at all.
  const rawBody = await req.text().catch(() => "");
  if (rawBody.length > 4_096) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  let body: { bio?: unknown; ctaLabel?: unknown; ctaUrl?: unknown };
  try {
    body = JSON.parse(rawBody || "{}") as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const bio = validateBio(body.bio);
  if (!bio.ok) return NextResponse.json({ code: "BIO_TOO_LONG", error: "bio_too_long" }, { status: 422 });

  const hasCta = body.ctaLabel != null || body.ctaUrl != null;
  let cta: { label: string | null; url: string | null };
  if (hasCta) {
    if (body.ctaLabel == null && body.ctaUrl != null) {
      return NextResponse.json({ code: "CTA_LABEL_REQUIRED", error: "cta_label_required" }, { status: 422 });
    }
    // Pass the host this request actually arrived on: NEXT_PUBLIC_APP_URL is a
    // build-time constant and goes stale whenever the deployment moves.
    const servedHost = req.headers.get("host") ?? new URL(req.url).host;
    const v = validateCta(body.ctaLabel, body.ctaUrl, [servedHost]);
    if (!v.ok) {
      return NextResponse.json({ code: `CTA_${v.reason.toUpperCase()}`, error: v.reason }, { status: 422 });
    }
    cta = { label: v.label, url: v.url };
  } else {
    cta = { label: null, url: null }; // cleared
  }

  try {
    const updated = await updateProfileExtras({
      id: user.id,
      bio: bio.bio,
      ctaLabel: cta.label,
      ctaUrl: cta.url,
    });
    if (!updated) return NextResponse.json({ error: "profile_missing" }, { status: 404 });
    await persistAnalyticsEvent({
      event: "profile_updated",
      userId: user.id,
      handle: updated.handle,
      props: { cta: cta.label ? "set" : "cleared" },
    });
    return NextResponse.json({ ok: true, profile: { handle: updated.handle, bio: updated.bio, ctaLabel: updated.ctaLabel, ctaUrl: updated.ctaUrl } });
  } catch {
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }
}
