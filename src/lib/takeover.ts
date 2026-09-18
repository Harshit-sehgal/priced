// Takeover orchestration: the single trusted path from payment to holder change.
// Server-only. Combines quotes, payments and the atomic database finalizer.
import "server-only";
import {
  getQuote,
  getSaleByProviderPaymentId,
  finalizeTakeover,
  getProfileById,
  markQuoteStatus,
  claimRefundAttempt,
  completeRefundAttempt,
  MAX_REFUND_ATTEMPTS,
  type RepoQuote,
  type TakeoverOutcome,
} from "./repo.ts";
import { logEvent } from "./logger.ts";
import { persistAnalyticsEvent } from "./analytics-server.ts";
// Static: payments.ts imports repo/demo-secret only, never takeover, so there
// is no cycle to break here. The heavy Stripe SDK is still lazy — payments.ts
// dynamically imports it inside loadStripe().
import { getProviderForEvent, refundIdempotencyKey } from "./payments.ts";

export type WebhookProcessingResult = {
  outcome: "processed" | "ignored" | "duplicate" | "failed";
  saleId?: string;
  refunded?: boolean;
  manualReview?: boolean;
  reason?: string;
};

type RefundOutcome = { refunded: boolean; manualReview?: boolean };

function failedAfterRefund(reason: string, refund: RefundOutcome): WebhookProcessingResult {
  return { outcome: "failed", ...refund, reason };
}

/**
 * Grace window for a payment that lands just after its quote's 5-minute TTL.
 *
 * WHY THIS EXISTS: the TTL protects against a stale *price*, not against a
 * slow payer. Real payments routinely exceed five minutes — 3-D Secure with an
 * SMS OTP, app-switching to a banking app, a declined card followed by a retry.
 * UPI and Indian netbanking redirects (this deployment is ap-south-1) blow past
 * it regularly. Before this window, such a buyer was charged, auto-refunded,
 * and never got the tag — despite nobody having outbid them. They simply paid
 * slowly, and it cost us a refund fee and a support ticket each time.
 *
 * WHY IT IS SAFE: nothing here bypasses a price check. A late payment still
 * goes through finalizeTakeover, which re-validates version AND price under
 * the row lock. It is honoured ONLY when the market has not moved at all — in
 * which case the buyer paid exactly the right amount for exactly the state
 * they quoted. If anything moved, it becomes STALE_QUOTE and is refunded
 * exactly as before.
 *
 * WHY IT DEFAULTS TO ZERO: `AGENTS.md` lists the 5-minute quote TTL under
 * "Locked market mechanics" and forbids changing product rules without the
 * owner's say-so. Default 0 therefore preserves today's behaviour byte for
 * byte. Set QUOTE_LATE_PAYMENT_GRACE_MS (e.g. 900000 for 15 minutes) to turn
 * it on — that is the owner's decision to make, not this module's.
 */
export function latePaymentGraceMs(): number {
  const raw = Number(process.env.QUOTE_LATE_PAYMENT_GRACE_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, 24 * 60 * 60 * 1000); // never unbounded
}

export async function processSucceededPayment(args: {
  provider: string;
  eventId: string;
  paymentId: string;
  quoteId: string | null;
  paidCents: number | null;
}): Promise<WebhookProcessingResult> {
  // IDEMPOTENCY BEFORE DISPOSITION. A payment id that already funded a sale is
  // never refundable, no matter what the quote now says, who the buyer is now,
  // or how this delivery re-derived its amount. Checking it only inside
  // finalizeTakeover (and gating the amount check on the caller's quote
  // snapshot) is not enough: a simultaneous challenger that loses marks the
  // quote `stale`, and if that write lands after the winner's `consumed` write,
  // the next duplicate delivery of the winner's payment reads a terminal quote
  // and refunds a sale that exists — buyer keeps the tag AND the money.
  //
  // The same lookup also covers: a buyer suspended after purchase, a profile
  // deleted after purchase, a payload variant that drops the metadata/amount,
  // and a currency-rejected duplicate — all of which previously reached a
  // refund branch before the sales-idempotency lookup ran.
  const existingSale = await getSaleByProviderPaymentId(args.paymentId);

  if (!args.quoteId) {
    if (existingSale) {
      logEvent("webhook_payment_duplicate_sale", "info", {
        provider: args.provider,
        event_id: args.eventId,
        payment_id: args.paymentId,
        sale_id: existingSale.id,
        reason: "metadata_missing_on_duplicate",
      });
      return { outcome: "duplicate", saleId: existingSale.id, reason: "payment_already_finalized" };
    }
    logEvent("webhook_payment_missing_quote", "warn", { provider: args.provider, event_id: args.eventId, payment_id: args.paymentId });
    return failedAfterRefund(
      "missing_quote_metadata",
      await refundPaymentWithLedger(args.provider, args.eventId, args.paymentId, null, "missing_quote_metadata"),
    );
  }

  const quote = await getQuote(args.quoteId);
  if (!quote) {
    if (existingSale) {
      logEvent("webhook_payment_duplicate_sale", "info", {
        provider: args.provider,
        event_id: args.eventId,
        payment_id: args.paymentId,
        sale_id: existingSale.id,
        reason: "quote_missing_on_duplicate",
      });
      return { outcome: "duplicate", saleId: existingSale.id, reason: "payment_already_finalized" };
    }
    logEvent("webhook_payment_unknown_quote", "warn", { provider: args.provider, event_id: args.eventId, payment_id: args.paymentId, quote_id: args.quoteId });
    return failedAfterRefund(
      "unknown_quote",
      await refundPaymentWithLedger(args.provider, args.eventId, args.paymentId, null, "unknown_quote"),
    );
  }

  if (existingSale) {
    // Same idempotency semantics finalize_takeover applies under its lock:
    // matching args are a duplicate delivery; different args are a critical
    // conflict to alert on, never to refund (the payment funded its original
    // sale).
    const expectedCents = args.paidCents ?? quote.nextPriceCents;
    const conflict =
      existingSale.domain !== quote.domain ||
      existingSale.buyerUserId !== quote.buyerUserId ||
      existingSale.priceCents !== expectedCents;
    if (conflict) {
      logEvent("takeover_finalization_error", "error", {
        provider: args.provider,
        payment_id: args.paymentId,
        quote_id: quote.id,
        code: "IDEMPOTENCY_CONFLICT",
      });
      return { outcome: "failed", refunded: false, reason: "IDEMPOTENCY_CONFLICT" };
    }
    // The sale proves this quote was consumed, even if a concurrent loser's
    // `stale` write (or any other terminal write) landed on top. Repair it.
    if (quote.status !== "consumed") {
      await markQuoteStatus(quote.id, "consumed");
    }
    return { outcome: "duplicate", saleId: existingSale.id, reason: "payment_already_finalized" };
  }

  // Terminal quote states must never create a sale — cover the webhook race
  // where Stripe retries arrive after we already marked the quote.
  // Note: "consumed" is intentionally excluded here — a duplicate webhook for
  // the same paymentId on a consumed quote is legitimate (Stripe retries the
  // same event) and is handled idempotently via finalizeTakeover + the
  // alreadyConsumed duplicate path below. Expiry for consumed quotes is also
  // ignored: the sale already happened, the TTL no longer matters.
  // Every terminal status is handled identically — log, refund, report
  // `quote_<status>`. This used to branch on expired/stale/cancelled first,
  // but both arms were byte-for-byte identical, so the condition only chose
  // between two indistinguishable paths. Enumerating the statuses here would
  // also be a list that rots: a status added later would silently fall to the
  // other arm. Handling them uniformly is both the existing behaviour and the
  // one that cannot drift.
  if (quote.status !== "active" && quote.status !== "checkout_created" && quote.status !== "consumed") {
    logEvent("webhook_payment_terminal_quote", "warn", {
      provider: args.provider,
      payment_id: args.paymentId,
      quote_id: quote.id,
      quote_status: quote.status,
    });
    const reason = `quote_${quote.status}`;
    return failedAfterRefund(reason, await refundPaymentWithLedger(args.provider, args.eventId, args.paymentId, quote, reason));
  }
  // Only non-consumed quotes expire — consumed quotes already produced a sale
  // and must not be refunded on TTL expiry (that would refund a valid sale).
  if (quote.status !== "consumed" && new Date(quote.expiresAt).getTime() < Date.now()) {
    const lateBy = Date.now() - new Date(quote.expiresAt).getTime();
    if (lateBy <= latePaymentGraceMs()) {
      // Inside the grace window: do NOT refund yet. Fall through to
      // finalizeTakeover, which re-validates version AND price atomically
      // under the row lock. If the market moved, it returns STALE_QUOTE and
      // the existing branch below refunds exactly as before. If it did not
      // move, the buyer paid the correct price for the exact market state
      // they quoted and simply paid slowly — honouring that is financially
      // neutral and strictly better for them. See latePaymentGraceMs().
      logEvent("webhook_payment_late_within_grace", "warn", {
        provider: args.provider,
        payment_id: args.paymentId,
        quote_id: quote.id,
        late_by_ms: lateBy,
      });
    } else {
      await markQuoteStatus(quote.id, "expired");
      logEvent("webhook_payment_expired_quote", "warn", { provider: args.provider, payment_id: args.paymentId, quote_id: quote.id, late_by_ms: lateBy });
      return failedAfterRefund(
        "quote_expired",
        await refundPaymentWithLedger(args.provider, args.eventId, args.paymentId, quote, "quote_expired"),
      );
    }
  }

  // Do not short-circuit on consumed: a duplicate webhook for the same
  // paymentId will be handled idempotently by finalizeTakeover's sales
  // lookup, while a reused quote with a new paymentId correctly becomes
  // STALE_QUOTE and is refunded.

  const profile = await getProfileById(quote.buyerUserId);
  if (!profile) {
    logEvent("takeover_failed_buyer_profile_missing", "error", { provider: args.provider, payment_id: args.paymentId, quote_id: quote.id });
    return failedAfterRefund(
      "buyer_profile_missing",
      await refundPaymentWithLedger(args.provider, args.eventId, args.paymentId, quote, "buyer_profile_missing"),
    );
  }
  if (profile.suspendedAt) {
    logEvent("takeover_blocked_buyer_suspended", "warn", { provider: args.provider, payment_id: args.paymentId, quote_id: quote.id });
    return failedAfterRefund(
      "buyer_suspended",
      await refundPaymentWithLedger(args.provider, args.eventId, args.paymentId, quote, "buyer_suspended"),
    );
  }

  const alreadyConsumed = quote.status === "consumed";

  // The amount check exists to stop a wrong-priced payment MINTING a sale. On
  // an already-consumed quote it cannot do that: finalizeTakeover resolves
  // this payment id against the existing sales row and either returns that
  // sale or raises IDEMPOTENCY_CONFLICT. Running the check first therefore
  // does no good and real harm — a duplicate delivery whose amount is
  // re-derived differently (a payload variant that omits `tax`, say, which
  // dodoAmountFromPayload explicitly tolerates) refunds a sale that is already
  // funded, so the buyer keeps the tag AND gets their money back.
  //
  // This is the same defect migration 20260912000001 closed in SQL, on the
  // TypeScript side of the lock: a check taken before the idempotency lookup
  // is not a safe check. First deliveries still fail closed below.
  if (!alreadyConsumed) {
    if (args.paidCents == null) {
      // A succeeded payment that asserts no amount is not payable: without the
      // amount comparison there is no proof the buyer paid the quoted price.
      // Fail closed into the mismatch branch (refund, terminal) rather than
      // defaulting to the quote price and minting a sale on an unverified sum.
      logEvent("payment_amount_missing", "error", { provider: args.provider, payment_id: args.paymentId, quote_id: quote.id, expected_cents: quote.nextPriceCents });
      return failedAfterRefund(
        "amount_mismatch",
        await refundPaymentWithLedger(args.provider, args.eventId, args.paymentId, quote, "amount_mismatch"),
      );
    }
    if (args.paidCents !== quote.nextPriceCents) {
      // Never apply a payment toward a different price (§50).
      logEvent("payment_amount_mismatch", "error", { provider: args.provider, payment_id: args.paymentId, quote_id: quote.id, paid_cents: args.paidCents, expected_cents: quote.nextPriceCents });
      return failedAfterRefund(
        "amount_mismatch",
        await refundPaymentWithLedger(args.provider, args.eventId, args.paymentId, quote, "amount_mismatch"),
      );
    }
  }

  const outcome: TakeoverOutcome = await finalizeTakeover({
    domain: quote.domain,
    buyerUserId: quote.buyerUserId,
    buyerHandle: profile.handle,
    expectedVersion: quote.expectedVersion,
    // On a consumed quote the amount is only a lookup key: the SQL idempotency
    // check compares it against the committed sale and raises
    // IDEMPOTENCY_CONFLICT (alert, never refund) if it genuinely disagrees.
    paidCents: args.paidCents ?? quote.nextPriceCents,
    providerPaymentId: args.paymentId,
  });

  if (outcome.ok) {
    // Detect idempotent replay via sales lookup so duplicate webhooks
    // surface as duplicate rather than processed. Without this, a re-delivered
    // Stripe event would re-emit takeover_succeeded and confuse monitoring.
    // finalizeTakeover returns the same sale for the same paymentId.
    // Do not mark a duplicate delivery as consumed again — the quote already
    // is, and touching it again would be a redundant write.
    if (alreadyConsumed) {
      return { outcome: "duplicate", saleId: outcome.sale.id, reason: "quote_already_consumed" };
    }
    await markQuoteStatus(quote.id, "consumed");
    // Product measurement only: the sale and quote are already authoritative
    // above. This best-effort funnel write must never turn a successful money
    // operation into a webhook failure or affect retry/idempotency behavior.
    await persistAnalyticsEvent({
      event: "takeover_succeeded",
      domain: quote.domain,
      handle: outcome.sale.buyerHandle,
      userId: quote.buyerUserId,
      props: {
        price_cents: outcome.sale.priceCents,
        previous_holder: outcome.sale.previousHolderHandle,
      },
    });
    logEvent("takeover_succeeded", "info", { provider: args.provider, payment_id: args.paymentId, quote_id: quote.id, domain: quote.domain, price_cents: outcome.sale.priceCents, buyer: outcome.sale.buyerHandle, sale_id: outcome.sale.id });
    return { outcome: "processed", saleId: outcome.sale.id };
  }

  if (outcome.code === "STALE_QUOTE") {
    // Never clobber a consumed quote: a duplicate delivery for a different
    // paymentId on an already-consumed quote must keep its consumed state
    // so later retries take the idempotent replay path, not the terminal
    // quote_stale pre-check path.
    if (quote.status !== "consumed") {
      await markQuoteStatus(quote.id, "stale");
    }
    logEvent("payment_succeeded_takeover_stale", "warn", { provider: args.provider, payment_id: args.paymentId, quote_id: quote.id, domain: quote.domain });
    return failedAfterRefund(
      "stale_quote",
      await refundPaymentWithLedger(args.provider, args.eventId, args.paymentId, quote, "stale_quote"),
    );
  }
  if (outcome.code === "WRONG_PRICE") {
    logEvent("payment_wrong_price", "error", { provider: args.provider, payment_id: args.paymentId, quote_id: quote.id });
    return failedAfterRefund(
      "wrong_price",
      await refundPaymentWithLedger(args.provider, args.eventId, args.paymentId, quote, "wrong_price"),
    );
  }
  if (outcome.code === "ALREADY_HOLDER") {
    logEvent("payment_already_holder", "warn", { provider: args.provider, payment_id: args.paymentId, quote_id: quote.id });
    return failedAfterRefund(
      "already_holder",
      await refundPaymentWithLedger(args.provider, args.eventId, args.paymentId, quote, "already_holder"),
    );
  }
  if (outcome.code === "FINALIZE_ERROR") {
    // RESERVED_DOMAIN surfaces as FINALIZE_ERROR via repo.ts; refund the stale payment.
    logEvent("takeover_finalization_error", "error", { provider: args.provider, payment_id: args.paymentId, quote_id: quote.id, code: outcome.code, domain: quote.domain });
    return failedAfterRefund(
      outcome.code,
      await refundPaymentWithLedger(args.provider, args.eventId, args.paymentId, quote, "finalize_error"),
    );
  }
  if (outcome.code === "PAYMENT_ALREADY_REFUNDED") {
    // The database refused the sale because this payment already has a refund
    // intent (one payment id = one outcome). Do NOT refund again and do NOT
    // retry: ack the webhook, alert, and let the refund ledger converge.
    logEvent("takeover_blocked_payment_refunded", "error", {
      provider: args.provider,
      payment_id: args.paymentId,
      quote_id: quote.id,
      domain: quote.domain,
    });
    return { outcome: "failed", refunded: false, reason: "PAYMENT_ALREADY_REFUNDED" };
  }
  // IDEMPOTENCY_CONFLICT: critical alert condition (§56) — mismatched reuse
  // of a payment id. Do NOT refund: the payment already funded its original
  // sale, and refunding here would undo a legitimate takeover. Ack the webhook
  // (caller returns 200) and alert for manual review.
  logEvent("takeover_finalization_error", "error", { provider: args.provider, payment_id: args.paymentId, quote_id: quote.id, code: outcome.code });
  return { outcome: "failed", refunded: false, reason: outcome.code };
}

async function refundPaymentWithLedger(
  provider: string,
  eventId: string,
  paymentId: string,
  quote: RepoQuote | null,
  reason: string,
): Promise<RefundOutcome> {
  const claim = await claimRefundAttempt({
    provider,
    paymentId,
    eventId,
    reason,
    amountCents: quote?.nextPriceCents ?? null,
  });

  if (claim.status === "succeeded") return { refunded: true };
  if (claim.status === "manual_review") {
    logEvent("refund_manual_review", "error", {
      provider,
      payment_id: paymentId,
      quote_id: quote?.id ?? null,
      reason,
      attempts: claim.attempts,
      detail: claim.lastError,
    });
    return { refunded: false, manualReview: true };
  }
  if (claim.status === "already_finalized") {
    // Cross-check from claim_refund_attempt: a sale already exists for this
    // payment id, so it is not refundable. This is the race half of the
    // one-payment-one-outcome invariant (the top-of-function sale lookup
    // handles the sequential half). Ack, alert, never retry.
    logEvent("refund_blocked_sale_exists", "error", {
      provider,
      payment_id: paymentId,
      quote_id: quote?.id ?? null,
      reason,
      detail: claim.lastError,
    });
    return { refunded: false, manualReview: true };
  }
  if (!claim.claimed || !claim.claimToken) {
    logEvent("refund_attempt_in_progress", "warn", {
      provider,
      payment_id: paymentId,
      quote_id: quote?.id ?? null,
      reason,
      attempts: claim.attempts,
    });
    return { refunded: false };
  }

  try {
    // Pin execution to the event's owning provider, never the env-selected
    // one: a Dodo<->Stripe switch (or key rotation) between payment and
    // refund would otherwise send this payment id to the wrong provider,
    // where it fails, burns a ledger attempt, and parks the payment in
    // manual_review even though the owner would have refunded it.
    const providerImpl = getProviderForEvent(provider);
    const res = await providerImpl.refundPayment({
      paymentId,
      reason,
      // Deterministic per payment, NOT per attempt: the refund ledger mints a
      // fresh claim token on every granted attempt, so keying on the token
      // defeats idempotency across retries. Per Dodo's contract ("one key per
      // logical intent, reused across retries"), all attempts for one payment
      // share one key and converge at the provider instead of double-refunding
      // on timeout-after-success. See refundIdempotencyKey().
      idempotencyKey: refundIdempotencyKey(provider, paymentId),
    });
    if (!res.ok) {
      // Dodo can accept a refund request while it is still pending/review.
      // Do not issue another refund while the first one may still settle;
      // the provider's refund webhook will reconcile the durable ledger.
      // `indeterminate` (timeout/abort/unreadable body) is ALSO terminal: the
      // provider may have executed the refund, and retrying could double it.
      const providerPending = res.status === "pending" || res.status === "review";
      const indeterminate = res.indeterminate === true;
      const terminal = providerPending || indeterminate || claim.attempts >= MAX_REFUND_ATTEMPTS;
      const completed = await completeRefundAttempt({
        provider,
        paymentId,
        claimToken: claim.claimToken,
        status: terminal ? "manual_review" : "failed",
        error: res.error,
      });
      const event = indeterminate
        ? "refund_indeterminate"
        : providerPending
          ? "refund_pending"
          : terminal
            ? "refund_manual_review"
            : "refund_failed";
      logEvent(event, "error", {
        provider,
        payment_id: paymentId,
        quote_id: quote?.id ?? null,
        reason,
        attempts: claim.attempts,
        detail: res.error,
      });
      return terminal || !completed ? { refunded: false, manualReview: true } : { refunded: false };
    }
    const completed = await completeRefundAttempt({
      provider,
      paymentId,
      claimToken: claim.claimToken,
      status: "succeeded",
    });
    if (!completed) {
      logEvent("refund_completion_unknown", "error", { provider, payment_id: paymentId, quote_id: quote?.id ?? null, reason });
      return { refunded: false, manualReview: true };
    }
    logEvent("stale_payment_refunded", "info", { provider, payment_id: paymentId, quote_id: quote?.id ?? null, reason });
    return { refunded: true };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const terminal = claim.attempts >= MAX_REFUND_ATTEMPTS;
    try {
      const completed = await completeRefundAttempt({
        provider,
        paymentId,
        claimToken: claim.claimToken,
        status: terminal ? "manual_review" : "failed",
        error: "provider_error",
      });
      if (!completed) return { refunded: false, manualReview: true };
    } catch {
      return { refunded: false, manualReview: true };
    }
    logEvent(terminal ? "refund_manual_review" : "refund_failed", "error", {
      provider,
      payment_id: paymentId,
      quote_id: quote?.id ?? null,
      reason,
      attempts: claim.attempts,
      detail,
    });
    return terminal ? { refunded: false, manualReview: true } : { refunded: false };
  }
}
