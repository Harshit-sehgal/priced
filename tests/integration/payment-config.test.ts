// The payment provider and the datastore must agree. A real provider without
// the production datastore (or the demo provider with it) is a deployment
// error: getPaymentProvider() throws for the latter combination, which used to
// surface as a 500 on every checkout/webhook instead of the intended 503.
//
// Node's test runner isolates each file in its own process, so setting env
// before the dynamic import is safe and deterministic here.
import assert from "node:assert/strict";
import test from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://config-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-config-test";
delete process.env.DODO_PAYMENTS_API_KEY;
delete process.env.STRIPE_SECRET_KEY;

test("demo provider against the production datastore is a detectable mismatch", async () => {
  const { isPaymentConfigConsistent } = await import("../../src/lib/payments.ts");
  assert.equal(isPaymentConfigConsistent(), false, "demo + prod datastore must be rejected");

  // A real provider key makes the same datastore consistent.
  process.env.DODO_PAYMENTS_API_KEY = "dodo-config-test";
  try {
    assert.equal(isPaymentConfigConsistent(), true, "real provider + prod datastore is valid");
  } finally {
    delete process.env.DODO_PAYMENTS_API_KEY;
  }
});
