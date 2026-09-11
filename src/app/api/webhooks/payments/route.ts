import { createHash } from "node:crypto";
import { getPaymentEvent, isProdDatastore, recordPaymentEvent, markPaymentEventStatus, reconcileRefundProviderEvent } from "@/lib/repo";
import { expectedSettlementCurrency, getConfiguredProviderName, getPaymentProvider, recordPaymentDispute } from "@/lib/payments";
import { processSucceededPayment } from "@/lib/takeover";
import { logEvent } from "@/lib/logger";
import { isUniqueViolation } from "@/lib/db-errors";

export const dynamic = "force-dynamic";

/**
 * Signed webhook endpoint. Redirects are never proof of payment (§24).
 * Processing is idempotent on (provider, event id) and on payment id via the
 * sales unique constraint inside finalize_takeover.
 *
 * Retry contract (provider-agnostic, required for Dodo):
 * - 200 = terminally handled (processed / duplicate / refunded / intentional
 *   ignore). The provider must NOT retry.
 * - 500 = transient failure (DB outage, refund-provider outage). The provider
 *   MUST retry the delivery.
 * Only a unique-constraint violation on payment_events is treated as a
 * duplicate; every other DB error returns 500.
 *
 * DEPLOY: the Dodo endpoint must be subscribed to the three payment events,
 * `refund.succeeded`, `refund.failed`, AND the `dispute.*` events. Without the
 * refund filter, asynchronous provider refunds cannot reconcile the durable
 * ledger; without the dispute filter, chargebacks never reach this handler.
 * The Stripe adapter needs `charge.dispute.*` for the same reason.
 */
export async function POST(req: Request) {
  // A real provider must never be allowed to finalize against the in-memory
  // adapter if a deployment is missing either Supabase production variable.
  if (getConfiguredProviderName() !== "demo" && !isProdDatastore) {
    return Response.json({ error: "payment_datastore_not_configured", retryable: false }, { status: 503 });
  }

  const provider = getPaymentProvider();
  const raw = await req.text(); // raw body required for signature verification
  // Webhook payload guard: Dodo/Stripe events are < 64 KiB; reject oversized bodies.
  if (raw.length > 64 * 1024) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  const signature =
    req.headers.get("stripe-signature") ??
    req.headers.get("dodo-signature") ??
    req.headers.get("webhook-signature") ??
    req.headers.get("x-demo-signature") ??
    null;

  // Standard Webhooks (Dodo) carries the event id + timestamp as headers.
  const verification = provider.verifyWebhook(raw, signature, {
    webhookId: req.headers.get("webhook-id"),
    webhookTimestamp: req.headers.get("webhook-timestamp"),
  });
  if (!verification.ok) {
    logEvent("webhook_signature_invalid", "warn", { provider: provider.name, reason: verification.reason });
    return Response.json({ error: "invalid_signature", reason: verification.reason }, { status: 400 });
  }

  const event = verification.event;

  // Event-level idempotency: duplicate deliveries are recorded once.
  // ONLY a unique violation means "already seen". Any other DB error is a
  // real failure and must return 500 so the provider retries.
  // payloadHash (SHA-256, no secrets) lets operators correlate retries and
  // detect tampered replays without ever storing full payment payloads.
  const payloadHash = createHash("sha256").update(raw, "utf8").digest("hex");
  try {
    await recordPaymentEvent({
      provider: provider.name,
      providerEventId: event.id,
      providerPaymentId: event.paymentId,
      eventType: event.type,
      payloadHash,
      status: "received",
    });
  } catch (e) {
    if (!isUniqueViolation(e)) {
      logEvent("webhook_store_failed", "error", {
        provider: provider.name,
        event_id: event.id,
        detail: e instanceof Error ? e.message : String(e),
      });
      return Response.json({ error: "store_failed", retryable: true }, { status: 500 });
    }
    try {
      const existing = await getPaymentEvent(provider.name, event.id);
      if (!existing) {
        logEvent("webhook_duplicate_lookup_failed", "error", { provider: provider.name, event_id: event.id });
        return Response.json({ error: "duplicate_lookup_failed", retryable: true }, { status: 500 });
      }
      // Terminal rows are safe to acknowledge. An error row is explicitly
      // retryable: re-enter processing so a failed finalize/refund can
      // converge on a later provider delivery instead of being lost forever.
      if (existing.status === "processed" || existing.status === "ignored") {
        logEvent("webhook_duplicate_event", "info", { provider: provider.name, event_id: event.id, status: existing.status });
        return Response.json({ received: true, duplicate: true });
      }
      if (existing.status === "received") {
        // The first delivery is still processing. Acknowledge this concurrent
        // duplicate so it cannot run the same refund/finalize operation twice.
        logEvent("webhook_duplicate_in_progress", "info", { provider: provider.name, event_id: event.id });
        return Response.json({ received: true, duplicate: true, inProgress: true });
      }
      if (existing.status !== "error") {
        logEvent("webhook_duplicate_unknown_status", "error", { provider: provider.name, event_id: event.id, status: existing.status });
        return Response.json({ error: "duplicate_status_invalid", retryable: true }, { status: 500 });
      }
      logEvent("webhook_retry_event", "info", { provider: provider.name, event_id: event.id });
    } catch (lookupError) {
      logEvent("webhook_duplicate_lookup_failed", "error", {
        provider: provider.name,
        event_id: event.id,
        detail: lookupError instanceof Error ? lookupError.message : String(lookupError),
      });
      return Response.json({ error: "duplicate_lookup_failed", retryable: true }, { status: 500 });
    }
  }

  // Disputes / chargebacks: record and alert, never auto-reverse.
  // Reversing a takeover is an owner business decision that has not been made,
  // so this path deliberately does not touch domains, sales or refunds.
  if (event.status === "disputed") {
    logEvent("payment_disputed", "error", {
      provider: provider.name,
      event_id: event.id,
      event_type: event.type,
      payment_id: event.paymentId,
      dispute_id: event.dispute?.disputeId ?? null,
      dispute_stage: event.dispute?.stage ?? null,
      dispute_status: event.dispute?.status ?? null,
      amount_cents: event.dispute?.amountCents ?? null,
      currency: event.dispute?.currency ?? null,
    });
    const recorded = await recordPaymentDispute({
      provider: provider.name,
      providerEventId: event.id,
      providerPaymentId: event.paymentId,
      providerDisputeId: event.dispute?.disputeId ?? null,
      eventType: event.type,
      stage: event.dispute?.stage ?? null,
      status: event.dispute?.status ?? null,
      amountCents: event.dispute?.amountCents ?? null,
      currency: event.dispute?.currency ?? null,
    });
    if (!recorded.ok) {
      // A lost dispute row means a chargeback with no trace. Treat it as a
      // transient store failure so the provider redelivers (the ledger upserts
      // on the event id, so the retry converges).
      logEvent("webhook_dispute_store_failed", "error", {
        provider: provider.name,
        event_id: event.id,
        payment_id: event.paymentId,
        detail: recorded.error,
      });
      // The event row MUST be moved off "received" before returning 500.
      // The duplicate handler above answers any "received" row with a
      // terminal 200 (`duplicate: true, inProgress: true`), so without this
      // the very redelivery this 500 asks for is acknowledged and dropped —
      // and only at info level. Marking "error" is what makes a retry
      // re-enter processing; every other 500 path here already does it.
      try {
        await markPaymentEventStatus(provider.name, event.id, "error", "dispute_store_failed");
      } catch {
        // Status write itself failed — still 500 so the provider retries.
      }
      return Response.json({ error: "dispute_store_failed", retryable: true }, { status: 500 });
    }
    try {
      await markPaymentEventStatus(provider.name, event.id, "ignored", event.type);
    } catch {
      return Response.json({ error: "store_failed", retryable: true }, { status: 500 });
    }
    return Response.json({ received: true, disputed: true, eventType: event.type });
  }

  // Refund requests can settle asynchronously after the original payment
  // webhook has been acknowledged. Reconcile these events independently of
  // the claim token used by the initiating request; this is what turns a
  // pending/review refund into a durable succeeded state without issuing a
  // second refund.
  if (event.status === "refunded") {
    try {
      await reconcileRefundProviderEvent({
        provider: provider.name,
        paymentId: event.paymentId,
        eventId: event.id,
        status: event.type === "refund.succeeded" ? "succeeded" : "manual_review",
        amountCents: event.amountCents,
        error: event.type === "refund.failed" ? "provider_refund_failed" : undefined,
      });
      await markPaymentEventStatus(provider.name, event.id, "ignored", event.type);
    } catch (e) {
      logEvent("refund_event_reconcile_failed", "error", {
        provider: provider.name,
        event_id: event.id,
        payment_id: event.paymentId,
        event_type: event.type,
        detail: e instanceof Error ? e.message : String(e),
      });
      // Same reason as the dispute branch: a "received" row is answered with a
      // terminal 200 by the duplicate handler, so a 500 that leaves the row in
      // "received" silently discards its own retry. Only an "error" row
      // re-enters processing.
      try {
        await markPaymentEventStatus(provider.name, event.id, "error", "refund_event_reconcile_failed");
      } catch {
        // Status write itself failed — still 500 so the provider retries.
      }
      return Response.json({ error: "refund_event_reconcile_failed", retryable: true }, { status: 500 });
    }
    logEvent(event.type === "refund.succeeded" ? "refund_provider_succeeded" : "refund_provider_failed", event.type === "refund.succeeded" ? "info" : "error", {
      provider: provider.name,
      event_id: event.id,
      payment_id: event.paymentId,
    });
    return Response.json({ received: true, refund: event.type });
  }

  if (event.status === "succeeded") {
    // Settlement currency is part of the amount: minor units of another
    // currency are not comparable to a quote priced in ours. The verifier has
    // already replaced the amount with a sentinel that cannot match any quote,
    // so this lands in takeover.ts's amount-mismatch branch → refunded →
    // terminal 200. It is NOT retryable: redelivering would never change the
    // currency of a settled payment.
    if (event.amountRejection) {
      logEvent("payment_currency_rejected", "error", {
        provider: provider.name,
        event_id: event.id,
        payment_id: event.paymentId,
        quote_id: event.quoteId,
        reason: event.amountRejection,
        currency: event.currency,
        expected_currency: expectedSettlementCurrency(),
      });
    } else if (event.taxAssumedZero) {
      // The provider sent a tax-inclusive total with no `tax` field. We compared
      // it as zero-tax (see dodoAmountFromPayload for why that is fail-safe).
      // Surfaced so an operator can tell a jurisdiction-dependent refund apart
      // from a genuine wrong-amount payment: if this is followed by
      // `payment_amount_mismatch`, the payment was almost certainly taxed in a
      // geography the integration has not been exercised against.
      logEvent("payment_tax_field_missing", "warn", {
        provider: provider.name,
        event_id: event.id,
        payment_id: event.paymentId,
        quote_id: event.quoteId,
        assumed_tax_cents: 0,
        amount_cents: event.amountCents,
      });
    }

    let result: Awaited<ReturnType<typeof processSucceededPayment>>;
    try {
      result = await processSucceededPayment({
        provider: provider.name,
        eventId: event.id,
        paymentId: event.paymentId,
        quoteId: event.quoteId,
        paidCents: event.amountCents,
      });
    } catch (e) {
      // DB outage / unexpected throw mid-processing: leave the event as
      // "received" and ask the provider to retry.
      logEvent("webhook_processing_failed", "error", {
        provider: provider.name,
        event_id: event.id,
        detail: e instanceof Error ? e.message : String(e),
      });
      try {
        await markPaymentEventStatus(provider.name, event.id, "error", "processing_exception");
      } catch {
        // Status write itself failed — still 500 so the provider retries.
      }
      return Response.json({ error: "processing_failed", retryable: true }, { status: 500 });
    }

    if (result.outcome === "processed") {
      try {
        await markPaymentEventStatus(provider.name, event.id, "processed");
      } catch (e) {
        // Sale is committed but the observability write failed. The money
        // state is deterministic; return 500 so a duplicate delivery
        // idempotently converges the status row via the sales lookup.
        logEvent("webhook_store_failed", "error", { provider: provider.name, event_id: event.id, detail: e instanceof Error ? e.message : String(e) });
        return Response.json({ error: "store_failed", retryable: true }, { status: 500 });
      }
      return Response.json({ received: true, result });
    }

    if (result.outcome === "duplicate") {
      // A different event id for the same paymentId that finalizeTakeover
      // resolved idempotently. Successful delivery — do not retry.
      try {
        await markPaymentEventStatus(provider.name, event.id, "processed", result.reason);
      } catch (e) {
        logEvent("webhook_store_failed", "error", { provider: provider.name, event_id: event.id, detail: e instanceof Error ? e.message : String(e) });
        return Response.json({ error: "store_failed", retryable: true }, { status: 500 });
      }
      return Response.json({ received: true, result });
    }

    if (result.outcome === "failed") {
      // IDEMPOTENCY_CONFLICT must NOT be refunded (the payment already funded
      // its original sale) and must NOT be retried. Ack + alert.
      if (result.reason === "IDEMPOTENCY_CONFLICT") {
        logEvent("webhook_idempotency_conflict", "error", {
          provider: provider.name,
          event_id: event.id,
          payment_id: event.paymentId,
        });
        try {
          await markPaymentEventStatus(provider.name, event.id, "error", result.reason);
        } catch {
          return Response.json({ error: "store_failed", retryable: true }, { status: 500 });
        }
        return Response.json({ received: true, result });
      }
      // A failed refund (or any failed path with refunded === false) leaves
      // money in a non-deterministic state → 500 so the provider retries and
      // the next delivery re-attempts finalize + refund.
      if (!result.refunded) {
        if (result.manualReview) {
          // The refund ledger has exhausted safe automatic attempts (or lost
          // certainty after a provider/database ambiguity). Acknowledge the
          // webhook so it cannot loop forever; the durable ledger is now an
          // operator queue for reconciliation.
          try {
            await markPaymentEventStatus(provider.name, event.id, "ignored", result.reason ?? "refund_manual_review");
          } catch {
            return Response.json({ error: "store_failed", retryable: true }, { status: 500 });
          }
          return Response.json({ received: true, result, retryable: false });
        }
        try {
          await markPaymentEventStatus(provider.name, event.id, "error", result.reason);
        } catch {
          // Fall through to the 500 below.
        }
        return Response.json({ received: true, result, retryable: true }, { status: 500 });
      }
      // Refunded paths (stale/expired/unknown/wrong_price/already_holder/
      // FINALIZE_ERROR) are terminally handled — the money was returned.
      const ignoredRefundReasons = new Set(["quote_expired", "missing_quote_metadata", "unknown_quote"]);
      const isIgnoredRefund =
        result.reason !== undefined && ignoredRefundReasons.has(result.reason);
      try {
        await markPaymentEventStatus(
          provider.name,
          event.id,
          isIgnoredRefund ? "ignored" : "processed",
          result.reason,
        );
      } catch (e) {
        logEvent("webhook_store_failed", "error", { provider: provider.name, event_id: event.id, detail: e instanceof Error ? e.message : String(e) });
        return Response.json({ error: "store_failed", retryable: true }, { status: 500 });
      }
      return Response.json({ received: true, result });
    }

    // Fallback: legacy ignored outcomes.
    try {
      await markPaymentEventStatus(provider.name, event.id, "ignored", result.reason);
    } catch {
      return Response.json({ error: "store_failed", retryable: true }, { status: 500 });
    }
    return Response.json({ received: true, result });
  }

  // failed / refunded / other events: recorded for observability, no action.
  // (disputed is handled above — it is never silently ignored.)
  try {
    await markPaymentEventStatus(provider.name, event.id, "ignored", event.type);
  } catch {
    return Response.json({ error: "store_failed", retryable: true }, { status: 500 });
  }
  return Response.json({ received: true, ignored: event.type });
}
