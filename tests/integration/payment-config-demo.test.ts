// The OTHER mismatch direction: a real payment provider configured while the
// datastore is only the in-memory demo. isPaymentConfigConsistent() must reject
// it, or checkout would charge real money against a store nothing persists.
//
// Node isolates each test file in its own process, so deleting the Supabase
// env here cannot leak into other suites.
import assert from "node:assert/strict";
import test from "node:test";

delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.DODO_PAYMENTS_API_KEY;
delete process.env.STRIPE_SECRET_KEY;

test("a real provider without the production datastore is a mismatch", async () => {
  const { isPaymentConfigConsistent } = await import("../../src/lib/payments.ts");

  // Demo provider + demo datastore is the only valid non-production pairing.
  assert.equal(isPaymentConfigConsistent(), true);

  process.env.DODO_PAYMENTS_API_KEY = "dodo-config-test";
  try {
    assert.equal(isPaymentConfigConsistent(), false, "real provider must require the production datastore");
  } finally {
    delete process.env.DODO_PAYMENTS_API_KEY;
  }
});
