// Payment provider abstraction (execution plan §20).
// Market logic never imports a provider SDK directly.
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isProdDatastore } from "./repo.ts";
import { demoWebhookSecret } from "./demo-secret.ts";

export type CheckoutResult = {
  checkoutUrl: string | null;
  providerPaymentId: string; // payment intent / checkout session id
  mode: "authorize" | "charge";
};

export type RefundProviderStatus = "succeeded" | "failed" | "pending" | "review";

export type RefundResult = {
  ok: boolean;
  status?: RefundProviderStatus;
  refundId?: string;
  error?: string;
};

export type WebhookVerification = { ok: true; event: ProviderEvent } | { ok: false; reason: string };

/**
 * Sentinel "we cannot value this settlement in our own currency" amount.
 *
 * WHY a negative sentinel instead of `null`: downstream, `null` means "the
 * provider did not assert an amount", which SKIPS the amount comparison in
 * takeover.ts entirely. Using `null` for a foreign-currency settlement would
 * therefore silently accept it — the exact bug this guards against. Quote
 * prices are always > 0, so a negative amount can never equal
 * `quote.nextPriceCents`; it deterministically lands in the existing
 * amount-mismatch branch, which refunds the payment and lets the webhook
 * return a terminal 200. A currency problem is a refundable business outcome,
 * never a retryable transport failure.
 */
export const UNVERIFIABLE_AMOUNT_CENTS = -1;

/** Why `amountCents` could not be established in the settlement currency. */
export type AmountRejection = "currency_missing" | "currency_mismatch" | null;

export type ProviderDispute = {
  disputeId: string | null;
  stage: string | null;
  status: string | null;
  amountCents: number | null;
  currency: string | null;
};

export type ProviderEvent = {
  id: string;
  type: string;
  paymentId: string;
  quoteId: string | null;
  amountCents: number | null;
  status: "succeeded" | "failed" | "refunded" | "disputed" | "other";
  /** Settlement currency reported by the provider, ISO-4217 uppercase. */
  currency: string | null;
  /**
   * Non-null only on succeeded events. When set, `amountCents` is
   * `UNVERIFIABLE_AMOUNT_CENTS` so the payment is refunded terminally.
   */
  amountRejection: AmountRejection;
  /**
   * True when a succeeded payment carried a provider total but no `tax` field
   * and we compared the total as if tax were zero. See `dodoAmountFromPayload`
   * for why that assumption is fail-safe, and why it is still alerted on.
   */
  taxAssumedZero: boolean;
  /** Populated only for dispute/chargeback events. */
  dispute: ProviderDispute | null;
};

/**
 * The one currency Priced settles in. Quotes, market prices and the amount
 * check are all integer minor units of THIS currency, so a settlement in any
 * other currency is not comparable and must never fund a takeover.
 */
export function expectedSettlementCurrency(): string {
  return (process.env.DODO_PAYMENTS_CURRENCY?.trim() || "USD").toUpperCase();
}

function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/**
 * Fail closed: a succeeded payment with no currency is as unusable as one in
 * the wrong currency. Both are terminal + refundable, never retryable.
 */
function rejectionFor(currency: string | null): AmountRejection {
  if (!currency) return "currency_missing";
  return currency === expectedSettlementCurrency() ? null : "currency_mismatch";
}

/**
 * Constant-time string compare that cannot throw on malformed input.
 * Length is not secret (it is fixed by the digest), so an early length exit is
 * safe and is required — timingSafeEqual throws on differing lengths.
 */
function timingSafeEqualStrings(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  try {
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");
    if (left.length === 0 || left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export type WebhookVerifyHeaders = {
  webhookId?: string | null;
  webhookTimestamp?: string | null;
};

export type RefundRequest = {
  paymentId: string;
  reason: string;
  /** Idempotency scope: one ledger claim maps to one provider refund call. */
  idempotencyKey: string;
};

export interface PaymentProvider {
  readonly name: string;
  createCheckout(args: {
    quoteId: string;
    domain: string;
    buyerUserId: string;
    buyerHandle: string;
    amountCents: number;
    successUrl: string;
    cancelUrl: string;
    /** Idempotency scope: retries for the same quote reuse one provider session. */
    idempotencyKey: string;
  }): Promise<CheckoutResult>;
  verifyWebhook(payload: string, signature: string | null, headers?: WebhookVerifyHeaders): WebhookVerification;
  refundPayment(request: RefundRequest): Promise<RefundResult>;
}

export class ProviderNotConfiguredError extends Error {
  constructor(name: string) {
    super(`PAYMENT_PROVIDER_NOT_CONFIGURED: ${name}`);
  }
}

// ------------------------------------------------------------- demo provider
/**
 * Simulated provider for local dev / preview only. The checkout URL points at
 * /checkout/mock, which drives the same webhook path with signed payloads.
 */
class DemoProvider implements PaymentProvider {
  readonly name = "demo";

  async createCheckout(args: { quoteId: string; amountCents: number; domain: string; buyerUserId: string }): Promise<CheckoutResult> {
    const params = new URLSearchParams({
      quote_id: args.quoteId,
      domain: args.domain,
      amount_cents: String(args.amountCents),
    });
    return {
      checkoutUrl: `/checkout/mock?${params.toString()}`,
      providerPaymentId: `demo_pi_${args.quoteId}`,
      mode: "charge",
    };
  }

  sign(payload: string): string {
    return createHmac("sha256", demoWebhookSecret()).update(payload).digest("hex");
  }

  verifyWebhook(payload: string, signature: string | null): WebhookVerification {
    if (!signature) return { ok: false, reason: "missing_signature" };
    if (!timingSafeEqualStrings(signature, this.sign(payload))) return { ok: false, reason: "invalid_signature" };
    try {
      const body = JSON.parse(payload) as {
        id: string;
        type: string;
        payment_intent: string;
        currency?: unknown;
        metadata: Record<string, string>;
      };
      const status: ProviderEvent["status"] =
        body.type === "payment_intent.payment_failed"
          ? "failed"
          : body.type === "charge.refunded"
            ? "refunded"
            : body.type?.startsWith("charge.dispute.")
              ? "disputed"
              : "succeeded";
      // The mock checkout signs its own payloads with the dev secret and does
      // not carry a currency, so an absent currency here means "our own
      // settlement currency" rather than an untrusted foreign settlement. A
      // payload that DOES declare one is still validated, so the demo path can
      // exercise the same fail-closed branch as the real providers.
      const currency = normalizeCurrency(body.currency) ?? expectedSettlementCurrency();
      const rejection = status === "succeeded" ? rejectionFor(currency) : null;
      const metaCents = Number(body.metadata?.amount_cents ?? 0) || null;
      return {
        ok: true,
        event: {
          id: body.id,
          type: body.type,
          paymentId: body.payment_intent,
          quoteId: body.metadata?.quote_id ?? null,
          amountCents: rejection ? UNVERIFIABLE_AMOUNT_CENTS : metaCents,
          status,
          currency,
          amountRejection: rejection,
          taxAssumedZero: false,
          dispute:
            status === "disputed"
              ? { disputeId: body.id ?? null, stage: null, status: body.type ?? null, amountCents: metaCents, currency }
              : null,
        },
      };
    } catch {
      return { ok: false, reason: "invalid_payload" };
    }
  }

  async refundPayment(): Promise<RefundResult> {
    return { ok: true };
  }
}

// ------------------------------------------------------------ stripe provider
type StripeLike = {
  checkout: {
    sessions: {
      create(args: Record<string, unknown>, opts?: Record<string, unknown>): Promise<{ id: string; url: string | null }>;
    };
  };
  paymentIntents: {
    get(id: string): Promise<{ id: string; status: string; amount: number; metadata: Record<string, string> }>;
    refund?: never;
  };
  refunds: { create(args: { payment_intent: string; reason?: string }, opts?: Record<string, unknown>): Promise<{ id: string }> };
  webhooks: { constructEvent(payload: string, sig: string, secret: string): { id: string; type: string; data: { object: Record<string, unknown> } } };
};

async function loadStripe(): Promise<StripeLike> {
  const mod = (await import("stripe")) as unknown as { default: new (key: string) => StripeLike };
  return new mod.default(process.env.STRIPE_SECRET_KEY!);
}

class StripeProvider implements PaymentProvider {
  readonly name = "stripe";

  async createCheckout(args: {
    quoteId: string;
    domain: string;
    buyerUserId: string;
    buyerHandle: string;
    amountCents: number;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<CheckoutResult> {
    const stripe = await loadStripe();
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            // Must be the same currency the webhook validates against, or
            // every Stripe payment would be refunded as a currency mismatch.
            currency: expectedSettlementCurrency().toLowerCase(),
            unit_amount: args.amountCents,
            product_data: {
              name: `Take ${args.domain}`,
              description: "Temporary symbolic holder status on Priced. Not the actual domain.",
            },
          },
        },
      ],
      // Metadata travels with every webhook event for matching + idempotency.
      metadata: {
        quote_id: args.quoteId,
        domain: args.domain,
        buyer_user_id: args.buyerUserId,
        buyer_handle: args.buyerHandle,
        amount_cents: String(args.amountCents),
      },
      payment_intent_data: { metadata: { quote_id: args.quoteId, amount_cents: String(args.amountCents) } },
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      },
      // One quote maps to one provider session: a timed-out create that the
      // client retries must not mint a second payable session.
      { idempotencyKey: `checkout:${args.idempotencyKey}` },
    );
    return { checkoutUrl: session.url, providerPaymentId: session.id, mode: "charge" };
  }

  verifyWebhook(payload: string, signature: string | null): WebhookVerification {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return { ok: false, reason: "webhook_secret_missing" };
    if (!signature) return { ok: false, reason: "missing_signature" };
    return verifyStripeWebhookSync(payload, signature, secret);
  }

  async refundPayment(request: RefundRequest): Promise<RefundResult> {
    try {
      const stripe = await loadStripe();
      await stripe.refunds.create(
        { payment_intent: request.paymentId, reason: "requested_by_customer" },
        // A timeout-after-success at the provider must not double-refund on retry.
        { idempotencyKey: `refund:${request.idempotencyKey}` },
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

function verifyStripeWebhookSync(payload: string, signature: string, secret: string): WebhookVerification {
  return verifyStripeWebhookInternal(payload, signature, secret, true);
}

/**
 * Shared Stripe verifier. enforceFreshness=false is ONLY for the
 * stale-but-signed path: the caller already proved the HMAC over the
 * timestamped content, and only the age gate is being waived so a delayed
 * but paid delivery flows through the money pipeline instead of a 400 drop.
 */
function verifyStripeWebhookInternal(
  payload: string,
  signature: string,
  secret: string,
  enforceFreshness: boolean,
): WebhookVerification {
  // Stripe sends "t=<unix>,v1=<hex>"; verify HMAC of "t.payload".
  // Parsed defensively: a malformed header must produce a rejection, never a
  // throw, because a throw here would surface as a 500 and ask the provider to
  // retry a delivery we can never accept.
  let timestamp: string | undefined;
  let v1: string | undefined;
  for (const part of signature.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t" && timestamp === undefined) timestamp = value;
    else if (key === "v1" && v1 === undefined) v1 = value;
  }
  if (!timestamp || !v1) return { ok: false, reason: "malformed_signature" };
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age)) return { ok: false, reason: "malformed_signature" };
  if (enforceFreshness && age > 60 * 10) return { ok: false, reason: "stale_timestamp" };
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  if (!timingSafeEqualStrings(v1, expected)) return { ok: false, reason: "invalid_signature" };

  try {
    const body = JSON.parse(payload) as {
      id: string;
      type: string;
      data: { object: Record<string, unknown> };
    };
    const obj = body.data.object as {
      id?: string;
      object?: string;
      status?: string;
      payment_status?: string;
      payment_intent?: string;
      charge?: string;
      currency?: unknown;
      amount?: number;
      amount_total?: number;
      metadata?: Record<string, string>;
    };
    const type = typeof body.type === "string" ? body.type : "";
    if (!type) return { ok: false, reason: "missing_event_type" };

    // Stripe recommends listening to `checkout.session.completed` for Checkout
    // and/or `payment_intent.succeeded|payment_failed` for PaymentIntents.
    // We accept both so DEPLOY.md's webhook setup works without extra steps.
    // DEPLOY: the Stripe endpoint must ALSO subscribe to `charge.dispute.*`
    // (created / updated / closed / funds_withdrawn / funds_reinstated) or
    // chargebacks are invisible to Priced.
    const isDispute = type.startsWith("charge.dispute.");
    const isCheckoutComplete =
      type === "checkout.session.completed" && (obj.status === "complete" || obj.payment_status === "paid");
    const isPiSucceeded = type === "payment_intent.succeeded";
    const isFailed = type === "payment_intent.payment_failed" || type.includes("failed");
    const isRefunded = type.includes("refunded");

    // Disputes are checked first: a dispute event is never a payment outcome,
    // and some dispute types would otherwise fall into the substring matches.
    const status: ProviderEvent["status"] = isDispute
      ? "disputed"
      : isRefunded
        ? "refunded"
        : isFailed
          ? "failed"
          : isCheckoutComplete || isPiSucceeded
            ? "succeeded"
            : "other";

    // Payment identifier: prefer the PaymentIntent id; a dispute object carries
    // `charge`, so fall back to that before the dispute/session id itself.
    const paymentId =
      (typeof obj.payment_intent === "string" && obj.payment_intent) ||
      (typeof obj.charge === "string" && obj.charge) ||
      (typeof obj.id === "string" && obj.id) ||
      "";
    if (!paymentId) return { ok: false, reason: "missing_payment_id" };

    // Amount: the provider-charged total is authoritative for our quotes.
    // Echoed metadata is only a fallback for event variants that omit the
    // provider amount; trusting metadata first would hide a wrong-amount
    // payment (e.g. tax/fees changing the charged total).
    const metaCents = obj.metadata?.amount_cents ? Number(obj.metadata.amount_cents) : null;
    const stripeAmount =
      typeof obj.amount_total === "number"
        ? obj.amount_total
        : typeof obj.amount === "number"
          ? obj.amount
          : null;
    const amountCents =
      typeof stripeAmount === "number" && Number.isFinite(stripeAmount)
        ? stripeAmount
        : Number.isFinite(metaCents) && (metaCents as number) > 0
          ? (metaCents as number)
          : null;

    // Stripe reports currency lowercase ("usd"); normalize before comparing.
    const currency = normalizeCurrency(obj.currency);
    const rejection = status === "succeeded" ? rejectionFor(currency) : null;

    return {
      ok: true,
      event: {
        id: body.id,
        type,
        paymentId,
        quoteId: obj.metadata?.quote_id ?? null,
        amountCents: rejection ? UNVERIFIABLE_AMOUNT_CENTS : (amountCents ?? null),
        status,
        currency,
        amountRejection: rejection,
        // Stripe's `amount`/`amount_total` are the charged totals and Stripe Tax
        // is not enabled for Priced, so there is no tax component to subtract.
        taxAssumedZero: false,
        dispute: isDispute
          ? {
              disputeId: typeof obj.id === "string" ? obj.id : null,
              stage: null,
              status: typeof obj.status === "string" ? obj.status : type,
              amountCents: typeof obj.amount === "number" ? obj.amount : null,
              currency,
            }
          : null,
      },
    };
  } catch {
    return { ok: false, reason: "invalid_payload" };
  }
}

// -------------------------------------------------------------- dodo provider
/**
 * Dodo Payments — the launch provider.
 *
 * One-time dynamic pricing via a single Pay-What-You-Want product
 * (DODO_PAYMENTS_PRODUCT_ID): each quote passes its exact next price as
 * `product_cart[0].amount` in minor units, so no per-domain product is needed.
 * Webhooks follow the Standard Webhooks spec
 * (webhook-id / webhook-timestamp / webhook-signature headers, HMAC-SHA256
 * over "<id>.<timestamp>.<raw body>").
 */
export class DodoPaymentsProvider implements PaymentProvider {
  readonly name = "dodo";

  private get apiKey(): string {
    const key = process.env.DODO_PAYMENTS_API_KEY;
    if (!key) throw new ProviderNotConfiguredError("dodo");
    return key;
  }

  private get baseUrl(): string {
    const override = process.env.DODO_PAYMENTS_BASE_URL?.trim();
    if (override) return override.replace(/\/+$/, "");
    const mode = (process.env.DODO_PAYMENTS_MODE ?? "test").toLowerCase();
    return mode === "live" ? "https://live.dodopayments.com" : "https://test.dodopayments.com";
  }

  private get productId(): string {
    const id = process.env.DODO_PAYMENTS_PRODUCT_ID?.trim();
    if (!id) throw new Error("DODO_PRODUCT_NOT_CONFIGURED: create a Pay-What-You-Want one-time product and set DODO_PAYMENTS_PRODUCT_ID");
    return id;
  }

  async createCheckout(args: {
    quoteId: string;
    domain: string;
    buyerUserId: string;
    buyerHandle: string;
    amountCents: number;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<CheckoutResult> {
    // Dodo uses a single return_url for success/failure/cancel and appends
    // ?payment_id=&status= — the webhook (never the redirect) finalizes.
    // Idempotency-Key keeps a timed-out create from minting a second payable
    // session on client retry (Dodo honors the standard header).
    // Timeout is load-bearing: without it a hung socket holds the checkout
    // route until the platform kills it, and the caller cannot distinguish
    // "never created" from "created but unacknowledged".
    const res = await fetch(`${this.baseUrl}/checkouts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "Idempotency-Key": `checkout:${args.idempotencyKey}`,
      },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        product_cart: [{ product_id: this.productId, quantity: 1, amount: args.amountCents }],
        // Dodo may have no region-specific methods available in a test
        // checkout. Keep card methods as the guaranteed fallback.
        allowed_payment_method_types: ["credit", "debit"],
        return_url: args.successUrl,
        cancel_url: args.cancelUrl,
        // Same source of truth the webhook validates against — see
        // expectedSettlementCurrency(). Checkout and verification must never
        // disagree, or every payment would be refunded as a mismatch.
        billing_currency: expectedSettlementCurrency(),
        metadata: {
          quote_id: args.quoteId,
          domain: args.domain,
          buyer_user_id: args.buyerUserId,
          buyer_handle: args.buyerHandle,
          amount_cents: String(args.amountCents),
        },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`DODO_CHECKOUT_FAILED: http ${res.status} ${detail.slice(0, 300)}`);
    }
    const session = (await res.json()) as { session_id?: string; checkout_url?: string | null };
    if (!session.session_id) throw new Error("DODO_CHECKOUT_FAILED: missing session_id");
    return { checkoutUrl: session.checkout_url ?? null, providerPaymentId: session.session_id, mode: "charge" };
  }

  verifyWebhook(payload: string, signature: string | null, headers?: WebhookVerifyHeaders): WebhookVerification {
    const secret = process.env.DODO_PAYMENTS_WEBHOOK_KEY;
    if (!secret) return { ok: false, reason: "webhook_secret_missing" };
    return verifyDodoWebhookSync(payload, signature, headers?.webhookId ?? null, headers?.webhookTimestamp ?? null, secret);
  }

  async refundPayment(request: RefundRequest): Promise<RefundResult> {
    try {
      // Timeout is load-bearing here too: an abort is INDTERMINATE (the
      // provider may have executed), so the caller must keep the ledger
      // lease / manual-review path, never treat it as a clean "not done".
      const res = await fetch(`${this.baseUrl}/refunds`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          // A timeout-after-success at the provider must not double-refund on
          // retry: the same ledger claim replays the same key.
          "Idempotency-Key": `refund:${request.idempotencyKey}`,
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ payment_id: request.paymentId, reason: request.reason.slice(0, 500) }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return { ok: false, error: `dodo refund http ${res.status}: ${detail.slice(0, 300)}` };
      }
      const body = (await res.json().catch(() => null)) as {
        status?: unknown;
        refund_id?: unknown;
      } | null;
      const status = body?.status;
      const refundId = typeof body?.refund_id === "string" ? body.refund_id : undefined;
      if (status === "succeeded") return { ok: true, status, refundId };
      if (status === "pending" || status === "review" || status === "failed") {
        return { ok: false, status, refundId, error: `dodo refund status: ${status}` };
      }
      return { ok: false, error: "dodo refund response missing a recognized status" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/**
 * Parse a Dodo dispute amount for the reconciliation record only. Dodo sends
 * these as decimal strings (unlike payment minor units), so accept numeric
 * strings and round half-up to the nearest minor unit. Never funds anything.
 */
function parseDisputeAmountCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return Math.round(n);
  }
  return null;
}

function dodoWebhookKeyBytes(secret: string): Buffer {
  // Dodo issues Standard-Webhooks secrets, commonly "whsec_<base64>".
  const stripped = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  try {
    const decoded = Buffer.from(stripped, "base64");
    // Only use the decoded form if it round-trips (i.e. it really was base64).
    if (decoded.length >= 16 && decoded.toString("base64").replace(/=+$/, "") === stripped.replace(/=+$/, "")) {
      return decoded;
    }
  } catch {
    // Fall through to raw bytes.
  }
  return Buffer.from(secret, "utf8");
}

function verifyDodoWebhookSync(
  payload: string,
  signature: string | null,
  webhookId: string | null,
  webhookTimestamp: string | null,
  secret: string,
): WebhookVerification {
  return verifyDodoWebhookInternal(payload, signature, webhookId, webhookTimestamp, secret, true);
}

/**
 * Shared Dodo verifier. enforceFreshness=false is ONLY for the
 * stale-but-signed path: the caller already proved the HMAC over the
 * timestamped content, and only the age gate is being waived so a delayed
 * but paid delivery flows through the money pipeline instead of a 400 drop.
 */
function verifyDodoWebhookInternal(
  payload: string,
  signature: string | null,
  webhookId: string | null,
  webhookTimestamp: string | null,
  secret: string,
  enforceFreshness: boolean,
): WebhookVerification {
  if (!signature) return { ok: false, reason: "missing_signature" };
  if (!webhookId) return { ok: false, reason: "missing_webhook_id" };
  if (!webhookTimestamp) return { ok: false, reason: "missing_webhook_timestamp" };
  const ts = Number(webhookTimestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "malformed_timestamp" };
  const ageSec = Math.abs(Date.now() / 1000 - ts);
  if (enforceFreshness && ageSec > 60 * 10) return { ok: false, reason: "stale_timestamp" };

  // Standard Webhooks: one or more space/comma-separated "v1,<base64>" entries.
  const candidates = signature
    .split(/[\s,]+/)
    .map((part) => part.replace(/^v1[=:]/, "").trim())
    .filter(Boolean);
  if (candidates.length === 0) return { ok: false, reason: "malformed_signature" };
  const signedContent = `${webhookId}.${webhookTimestamp}.${payload}`;
  const expected = createHmac("sha256", dodoWebhookKeyBytes(secret)).update(signedContent, "utf8").digest("base64");
  if (!candidates.some((candidate) => timingSafeEqualStrings(candidate, expected))) {
    return { ok: false, reason: "invalid_signature" };
  }

  try {
    const body = JSON.parse(payload) as {
      business_id?: string;
      id?: string;
      type?: string;
      timestamp?: string;
      data?: Record<string, unknown> & {
        payload_type?: string;
        payment_id?: unknown;
        dispute_id?: unknown;
        dispute_stage?: unknown;
        dispute_status?: unknown;
        id?: unknown;
        metadata?: unknown;
        currency?: unknown;
        total_amount?: unknown;
        amount?: unknown;
        tax?: unknown;
      };
    };
    const type = typeof body.type === "string" ? body.type : "";
    if (!type) return { ok: false, reason: "missing_event_type" };
    const data = body.data ?? {};

    // DEPLOY: the Dodo endpoint is configured for the three payment events,
    // refund.succeeded / refund.failed, plus `dispute.*` (opened, challenged,
    // accepted, cancelled, expired, won, lost). Without the refund filter,
    // asynchronous refunds cannot reconcile; without the dispute filter,
    // chargebacks never reach this handler and a buyer can keep both the tag
    // and the money.
    const isDispute = type.startsWith("dispute.");
    const isRefund = type === "refund.succeeded" || type === "refund.failed";
    const status: ProviderEvent["status"] = isDispute
      ? "disputed"
      : type === "payment.succeeded"
        ? "succeeded"
        : type === "payment.failed" || type === "payment.cancelled"
          ? "failed"
          : type.startsWith("refund.")
            ? "refunded"
            : "other";

    const paymentId =
      (typeof data.payment_id === "string" && data.payment_id) ||
      (!isRefund && typeof data.id === "string" && data.id) ||
      "";
    // payment.failed may arrive without a payment object in edge cases;
    // failed/other events are observability-only, so allow empty payment id.
    // Succeeded events must carry one — otherwise finalization is impossible.
    // Disputes must too: provider_payment_id is the ONLY key joining a dispute
    // back to its sale and payment_events row, and "" satisfies the not-null
    // constraint while being unjoinable — a chargeback recorded in a way that
    // cannot be traced to what it reverses is barely better than none.
    if (!paymentId && (status === "succeeded" || status === "disputed" || isRefund)) {
      return { ok: false, reason: "missing_payment_id" };
    }

    const meta = (data.metadata ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
    const quoteId = str(meta.quote_id);

    // `currency` (not `settlement_currency`) is the denomination of
    // total_amount/tax, which is what we compare against the quote. Reading
    // settlement_currency here would validate one currency while comparing
    // minor units of another.
    const currency = normalizeCurrency(data.currency);
    const rejection = status === "succeeded" ? rejectionFor(currency) : null;

    const { amountCents, taxAssumedZero } = dodoAmountFromPayload(data, meta, status);

    return {
      ok: true,
      event: {
        id: webhookId,
        type,
        paymentId,
        quoteId,
        amountCents: rejection ? UNVERIFIABLE_AMOUNT_CENTS : amountCents,
        status,
        currency,
        amountRejection: rejection,
        taxAssumedZero: rejection ? false : taxAssumedZero,
        dispute: isDispute
          ? {
              disputeId: str(data.dispute_id) ?? str(data.id),
              stage: str(data.dispute_stage),
              status: str(data.dispute_status) ?? type,
              // Dodo sends dispute amounts as decimal strings, unlike payment
              // minor units, so parse permissively for the record only. This
              // value never funds or reverses anything.
              amountCents: parseDisputeAmountCents(data.amount),
              currency,
            }
          : null,
      },
    };
  } catch {
    return { ok: false, reason: "invalid_payload" };
  }
}

/**
 * Derive the pre-tax market amount from a Dodo payment payload.
 *
 * Dodo's `total_amount` is TAX-INCLUSIVE while the market price is the pre-tax
 * product amount, so the validated amount is `total_amount - tax`.
 *
 * Missing-`tax` decision (jurisdiction-dependent; the integration was only
 * exercised against one buyer geography): a `payment.succeeded` that carries a
 * total but no `tax` field is treated as ZERO TAX, and `taxAssumedZero` is set
 * so the webhook route can alert on it.
 *
 * WHY zero rather than "unverifiable": the downstream check is exact equality
 * against the quote price, so the assumption can only ever over-reject, never
 * under-collect.
 *   - genuinely untaxed payment -> total === price -> correctly accepted.
 *   - taxed payment with `tax` omitted -> total > price -> amount_mismatch ->
 *     refunded, money returned, no takeover.
 * Declaring it unverifiable instead would refund every legitimate payment from
 * a zero-tax jurisdiction, which is strictly worse. The assumption is therefore
 * safe but still *visible*: `taxAssumedZero` is logged, so an operator sees
 * "we guessed" next to any resulting `payment_amount_mismatch` refund rather
 * than a silent, unexplained refund of a valid payment.
 */
function dodoAmountFromPayload(
  data: { total_amount?: unknown; amount?: unknown; tax?: unknown },
  meta: Record<string, unknown>,
  status: ProviderEvent["status"],
): { amountCents: number | null; taxAssumedZero: boolean } {
  const totalCents =
    typeof data.total_amount === "number" && Number.isFinite(data.total_amount)
      ? data.total_amount
      : typeof data.amount === "number" && Number.isFinite(data.amount)
        ? data.amount
        : null;

  // Metadata remains only a fallback for event variants that omit the provider
  // amount; trusting echoed metadata first would hide a wrong-amount payment.
  if (totalCents == null) {
    const metaCents = Number(meta.amount_cents);
    return { amountCents: Number.isFinite(metaCents) && metaCents > 0 ? metaCents : null, taxAssumedZero: false };
  }

  const taxCents = typeof data.tax === "number" && Number.isFinite(data.tax) && data.tax >= 0 ? data.tax : null;
  if (taxCents != null) return { amountCents: totalCents - taxCents, taxAssumedZero: false };
  return { amountCents: totalCents, taxAssumedZero: status === "succeeded" };
}

// ------------------------------------------------------- dispute / chargeback
export type DisputeRecord = {
  provider: string;
  providerEventId: string;
  providerPaymentId: string;
  providerDisputeId: string | null;
  eventType: string;
  stage: string | null;
  status: string | null;
  amountCents: number | null;
  currency: string | null;
};

// Demo/in-memory datastore mirror so the dispute path is exercisable without
// Supabase. Never used when isProdDatastore is true.
const memDisputes = new Map<string, DisputeRecord>();

/** Test/demo visibility into the in-memory dispute mirror. */
export function listMemoryDisputes(): DisputeRecord[] {
  return [...memDisputes.values()];
}

export function resetMemoryDisputes(): void {
  memDisputes.clear();
}

let disputeClient: SupabaseClient | null = null;
function disputeStore(): SupabaseClient | null {
  if (!isProdDatastore) return null;
  if (disputeClient) return disputeClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  disputeClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return disputeClient;
}

/**
 * Persist a dispute/chargeback against its payment id.
 *
 * Deliberately NOT best-effort (unlike analytics): a lost dispute row means a
 * buyer keeps both the tag and the money with no trace, so the caller turns a
 * failure here into a 500 and the provider retries the delivery. Upserted on
 * (provider, provider_event_id) so a retried delivery converges instead of
 * duplicating.
 *
 * This records and alerts only. Reversing a takeover is an owner business
 * decision that has not been made, so nothing here touches domains or sales.
 */
export async function recordPaymentDispute(rec: DisputeRecord): Promise<{ ok: boolean; error?: string }> {
  const key = `${rec.provider}:${rec.providerEventId}`;
  const store = disputeStore();
  if (!store) {
    memDisputes.set(key, rec);
    return { ok: true };
  }
  try {
    const { error } = await store.from("payment_disputes").upsert(
      {
        provider: rec.provider,
        provider_event_id: rec.providerEventId,
        provider_payment_id: rec.providerPaymentId,
        provider_dispute_id: rec.providerDisputeId,
        event_type: rec.eventType,
        stage: rec.stage,
        status: rec.status,
        amount_cents: rec.amountCents,
        currency: rec.currency,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "provider,provider_event_id" },
    );
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ------------------------------------------------------------------- factory
export function getPaymentProvider(): PaymentProvider {
  // Dodo is the launch default; Stripe stays as an optional adapter.
  if (process.env.DODO_PAYMENTS_API_KEY) return new DodoPaymentsProvider();
  if (process.env.STRIPE_SECRET_KEY) return new StripeProvider();
  if (isProdDatastore) throw new ProviderNotConfiguredError("dodo");
  return new DemoProvider();
}

/**
 * Resolve the provider implementation that owns a given payment event.
 * Refund execution MUST use this, never getPaymentProvider(): a provider
 * switch (Dodo<->Stripe, test<->live key rotation) between payment and
 * refund would otherwise send a payment id to the wrong provider, where it
 * fails, burns a ledger attempt, and parks the payment in manual_review
 * even though the owning provider would have refunded it.
 */
export function getProviderForEvent(providerName: string): PaymentProvider {
  if (providerName === "dodo") {
    if (!process.env.DODO_PAYMENTS_API_KEY) throw new ProviderNotConfiguredError("dodo");
    return new DodoPaymentsProvider();
  }
  if (providerName === "stripe") {
    if (!process.env.STRIPE_SECRET_KEY) throw new ProviderNotConfiguredError("stripe");
    return new StripeProvider();
  }
  if (providerName === "demo") return new DemoProvider();
  throw new Error(`UNKNOWN_PAYMENT_PROVIDER: ${providerName}`);
}

export function getConfiguredProviderName(): "dodo" | "stripe" | "demo" {
  if (process.env.DODO_PAYMENTS_API_KEY) return "dodo";
  if (process.env.STRIPE_SECRET_KEY) return "stripe";
  return "demo";
}

/**
 * Re-verify a stale-but-signed delivery with the age gate waived.
 * The caller MUST have already proven the HMAC: this replays the SAME
 * signature verification with enforceFreshness=false, so a forged payload
 * still fails invalid_signature here. Only the provider that owns the
 * delivery is consulted (signature scheme + secret differ per provider).
 */
export function parseStaleWebhookEvent(
  providerName: string,
  payload: string,
  signature: string | null,
  headers: WebhookVerifyHeaders,
): WebhookVerification {
  if (providerName === "dodo") {
    const secret = process.env.DODO_PAYMENTS_WEBHOOK_KEY;
    if (!secret) return { ok: false, reason: "webhook_secret_missing" };
    const first = verifyDodoWebhookInternal(
      payload,
      signature,
      headers?.webhookId ?? null,
      headers?.webhookTimestamp ?? null,
      secret,
      true,
    );
    // CAREFUL: `stale_timestamp` does NOT mean the HMAC matched. The freshness
    // check runs BEFORE the digest is computed, so this first pass returns
    // "stale" having proved nothing about the signature. It is only a cheap
    // pre-filter that tells us which reason to waive.
    //
    // The signature is proved by the SECOND call below, which recomputes the
    // full HMAC with freshness disabled. That re-verification is the entire
    // security of this path — never "optimise" it away by trusting
    // `first.reason`, and never return `ok` derived from this first pass.
    // Any other reason (including invalid_signature) is returned unchanged.
    if (first.ok || first.reason !== "stale_timestamp") return first;
    return verifyDodoWebhookInternal(
      payload,
      signature,
      headers?.webhookId ?? null,
      headers?.webhookTimestamp ?? null,
      secret,
      false,
    );
  }
  if (providerName === "stripe") {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return { ok: false, reason: "webhook_secret_missing" };
    if (!signature) return { ok: false, reason: "missing_signature" };
    const first = verifyStripeWebhookInternal(payload, signature, secret, true);
    if (first.ok || first.reason !== "stale_timestamp") return first;
    return verifyStripeWebhookInternal(payload, signature, secret, false);
  }
  return { ok: false, reason: "stale_timestamp_unsupported_provider" };
}
