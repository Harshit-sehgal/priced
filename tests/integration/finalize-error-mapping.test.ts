// The finalize_takeover error mapping decides whether a payment is refunded
// (FINALIZE_ERROR) or merely alerted on (IDEMPOTENCY_CONFLICT). A duplicate-key
// violation on sales.provider_payment_id means the payment ALREADY funded a
// sale in a racing transaction, so it must land on the alert side; mapping it
// to FINALIZE_ERROR would refund and leave the buyer holding the tag.
import assert from "node:assert/strict";
import test from "node:test";
import { mapFinalizeRpcError } from "../../src/lib/repo/supabase.ts";

test("known finalize failures map to their published codes", () => {
  assert.deepEqual(mapFinalizeRpcError({ message: "STALE_QUOTE" }), { ok: false, code: "STALE_QUOTE" });
  assert.deepEqual(mapFinalizeRpcError({ message: "ALREADY_HOLDER" }), { ok: false, code: "ALREADY_HOLDER" });
  assert.deepEqual(mapFinalizeRpcError({ message: 'WRONG_PRICE expected 500, got 400' }), { ok: false, code: "WRONG_PRICE" });
  assert.deepEqual(mapFinalizeRpcError({ message: "IDEMPOTENCY_CONFLICT" }), { ok: false, code: "IDEMPOTENCY_CONFLICT" });
  assert.deepEqual(mapFinalizeRpcError({ message: "RESERVED_DOMAIN" }), { ok: false, code: "FINALIZE_ERROR" });
  // One payment id = one outcome: the SQL exclusion's refusal must not be
  // mistaken for a refundable FINALIZE_ERROR (that would double-refund).
  assert.deepEqual(mapFinalizeRpcError({ message: "PAYMENT_REFUNDING" }), {
    ok: false,
    code: "PAYMENT_ALREADY_REFUNDED",
  });
});

test("a duplicate payment-id unique violation is an idempotency conflict, never a refundable error", () => {
  assert.deepEqual(
    mapFinalizeRpcError({
      message: 'duplicate key value violates unique constraint "sales_provider_payment_id_key"',
      code: "23505",
    }),
    { ok: false, code: "IDEMPOTENCY_CONFLICT" },
  );
  // PostgREST has been known to omit the SQLSTATE; the message alone must
  // still classify it.
  assert.deepEqual(
    mapFinalizeRpcError({ message: 'duplicate key value violates unique constraint "sales_provider_payment_id_key"' }),
    { ok: false, code: "IDEMPOTENCY_CONFLICT" },
  );
});

test("a unique violation on any OTHER constraint stays a refundable finalize error", () => {
  // A blanket `code === "23505"` arm would classify a future unique constraint
  // as "payment already funded a sale" and skip the refund.
  assert.deepEqual(
    mapFinalizeRpcError({
      message: 'duplicate key value violates unique constraint "some_future_key"',
      code: "23505",
    }),
    { ok: false, code: "FINALIZE_ERROR" },
  );
});

test("unknown failures stay refundable FINALIZE_ERROR", () => {
  assert.deepEqual(mapFinalizeRpcError({ message: "connection terminated unexpectedly" }), { ok: false, code: "FINALIZE_ERROR" });
  assert.deepEqual(mapFinalizeRpcError({ message: "INVALID_DOMAIN" }), { ok: false, code: "FINALIZE_ERROR" });
});
