import { NextResponse } from "next/server";
import { getQuote, isProdDatastore, markQuoteStatus, setQuoteCheckout } from "@/lib/repo";
import { getViewer, demoViewer } from "@/lib/auth";
import { getConfiguredProviderName, getPaymentProvider } from "@/lib/payments";
import { verifyTurnstile } from "@/lib/turnstile";
import { rateLimitAll } from "@/lib/ratelimit";
import { persistAnalyticsEvent } from "@/lib/analytics-server";
import { logEvent } from "@/lib/logger";
import { clientIp } from "@/lib/client-ip";

export async function POST(req: Request) {
  // JSON-only: cross-origin form posts cannot produce this content type (§46 CSRF).
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/json")) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
  }

  let user;
  try {
    ({ user } = await getViewer());
    if (!user) {
      const { isAuthConfigured } = await import("@/lib/auth");
      if (!isAuthConfigured) user = demoViewer().user;
    }
  } catch {
    return NextResponse.json({ error: "auth unavailable" }, { status: 500 });
  }
  if (!user) return NextResponse.json({ error: "login_required" }, { status: 401 });

  const ip = clientIp(req.headers);
  // Both dimensions were already awaited unconditionally before either result
  // was tested, so batching them is behaviour-identical — one round-trip, two
  // counters, same verdict.
  const allowed = await rateLimitAll([
    { key: `checkout:${user.id}`, limit: 20, windowMs: 60_000 },
    { key: `checkout:ip:${ip}`, limit: 30, windowMs: 60_000 },
  ]);
  if (!allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  // Body size guard before JSON parse (abuse/DoS).
  const rawBody = await req.text().catch(() => "");
  if (rawBody.length > 4_096) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  let body: { quoteId?: string; turnstileToken?: unknown } = {};
  try {
    body = JSON.parse(rawBody || "{}") as { quoteId?: string; turnstileToken?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const quoteId: string | undefined = body.quoteId;
  const turnstileToken: unknown = body.turnstileToken;
  if (!quoteId) return NextResponse.json({ error: "quoteId_required" }, { status: 400 });

  // Suspended buyers can still reach this endpoint after the quote was created;
  // enforce here too so the provider never receives a tainted checkout.
  const { getProfileById: getProfileForCheckout } = await import("@/lib/repo");
  const viewerProfile = await getProfileForCheckout(user.id);
  if (viewerProfile?.suspendedAt) {
    return NextResponse.json({ code: "SUSPENDED", error: "account suspended" }, { status: 403 });
  }

  // Bot protection (§45): fail closed when Turnstile is configured.
  const turnstile = await verifyTurnstile(turnstileToken, ip === "unknown" ? null : ip);
  if (!turnstile.ok) {
    await persistAnalyticsEvent({ event: "checkout_blocked_bot", userId: user.id, props: { reason: turnstile.reason } });
    return NextResponse.json({ error: "bot_check_failed", detail: turnstile.reason }, { status: 403 });
  }

  const quote = await getQuote(quoteId);
  if (!quote) return NextResponse.json({ error: "unknown_quote" }, { status: 404 });
  if (quote.buyerUserId !== user.id) return NextResponse.json({ error: "not_your_quote" }, { status: 403 });
  if (quote.status !== "active" && quote.status !== "checkout_created") {
    return NextResponse.json({ error: `quote_${quote.status}` }, { status: 409 });
  }
  if (new Date(quote.expiresAt).getTime() < Date.now()) {
    await markQuoteStatus(quote.id, "expired");
    return NextResponse.json({ error: "quote_expired" }, { status: 409 });
  }

  // Reuse the profile just fetched above.
  const checkoutHandle = viewerProfile?.handle ?? `user_${user.id.slice(0, 8)}`;

  // Idempotent retry: a double-click or network retry reuses the stored
  // provider session instead of opening a second payment session.
  if (quote.status === "checkout_created" && quote.checkoutPaymentId) {
    await persistAnalyticsEvent({
      event: "checkout_started",
      domain: quote.domain,
      userId: user.id,
      props: { reused: true },
    });
    return NextResponse.json({ checkoutUrl: quote.checkoutUrl, providerPaymentId: quote.checkoutPaymentId, reused: true });
  }

  // Never accept a real payment while the authoritative datastore is only
  // partially configured. Without this guard a deployment with a Dodo key
  // but no service-role key could charge money against the in-memory adapter.
  if (getConfiguredProviderName() !== "demo" && !isProdDatastore) {
    return NextResponse.json({ error: "payment_datastore_not_configured" }, { status: 503 });
  }

  const provider = getPaymentProvider();
  const base = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
  try {
    const checkout = await provider.createCheckout({
      quoteId: quote.id,
      domain: quote.domain,
      buyerUserId: user.id,
      buyerHandle: checkoutHandle,
      amountCents: quote.nextPriceCents,
      successUrl: `${base}/checkout/return?quote_id=${quote.id}`,
      cancelUrl: `${base}/domain/${quote.domain}?checkout=cancelled`,
      // One quote maps to one provider session: retries for the same quote
      // replay the same key so a timed-out create cannot mint an orphan.
      idempotencyKey: quote.id,
    });
    // First writer wins — a concurrent second request reuses this session.
    const stored = await setQuoteCheckout({
      quoteId: quote.id,
      provider: provider.name,
      paymentId: checkout.providerPaymentId,
      checkoutUrl: checkout.checkoutUrl,
    });
    await persistAnalyticsEvent({
      event: "checkout_started",
      domain: quote.domain,
      userId: user.id,
      props: { provider: provider.name, reused: stored.reused },
    });
    return NextResponse.json({ checkoutUrl: stored.checkoutUrl, providerPaymentId: stored.paymentId, reused: stored.reused });
  } catch (e) {
    logEvent("checkout_provider_failed", "error", {
      provider: provider.name,
      quote_id: quote.id,
      domain: quote.domain,
      detail: (e instanceof Error ? e.message : String(e)).slice(0, 500),
    });
    return NextResponse.json(
      { error: "checkout_failed" },
      { status: 502 },
    );
  }
}
