import assert from "node:assert/strict";
import test from "node:test";
import {
  ADULT_ATTESTATION_TTL_MS,
  createAdultAttestationToken,
  getCookieValue,
  verifyAdultAttestationToken,
} from "./adult-attestation.ts";

test("adult attestation is signed, quote-bound, user-bound, and short-lived", async () => {
  const token = await createAdultAttestationToken("test-secret", "user-a", "quote-a", 10_000);
  assert.equal(await verifyAdultAttestationToken(token, "test-secret", "user-a", "quote-a", 10_000), true);
  assert.equal(
    await verifyAdultAttestationToken(token, "test-secret", "user-a", "quote-a", 10_000 + ADULT_ATTESTATION_TTL_MS),
    true,
  );
  assert.equal(await verifyAdultAttestationToken(token, "wrong-secret", "user-a", "quote-a", 10_000), false);
  assert.equal(await verifyAdultAttestationToken(token, "test-secret", "user-b", "quote-a", 10_000), false);
  assert.equal(await verifyAdultAttestationToken(token, "test-secret", "user-a", "quote-b", 10_000), false);
  assert.equal(
    await verifyAdultAttestationToken(token, "test-secret", "user-a", "quote-a", 10_001 + ADULT_ATTESTATION_TTL_MS),
    false,
  );
  assert.equal(await verifyAdultAttestationToken(token, "test-secret", "user-a", "quote-a", 9_999), false);
  assert.equal(await verifyAdultAttestationToken(`${token}x`, "test-secret", "user-a", "quote-a", 10_000), false);
});

test("adult attestation cookie parser selects exact cookie name", () => {
  assert.equal(getCookieValue("other=one; priced_adult_attestation=token; last=three", "priced_adult_attestation"), "token");
  assert.equal(getCookieValue("not_priced_adult_attestation=bad", "priced_adult_attestation"), null);
});
