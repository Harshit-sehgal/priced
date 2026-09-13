// /api/profile route contract (§7): auth, validation codes, persistence.
import assert from "node:assert/strict";
import test from "node:test";
import { resetMemoryMarket, upsertProfile, getProfileByHandle, updateProfileExtras } from "../../src/lib/repo.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { POST: profilePOST } = (await import("../../src/app/api/profile/route.ts")) as any;

test.beforeEach(() => resetMemoryMarket());

test("oversized profile payloads are rejected before any JSON parse", async () => {
  const res = (await profilePOST(
    new Request("http://localhost/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bio: "x".repeat(5_000) }),
    }),
  )) as { status: number; body: unknown };
  assert.equal(res.status, 413);
  assert.deepEqual(res.body, { error: "payload_too_large" });
});

test("updateProfileExtras writes bio and CTA for the owning user only", async () => {
  await upsertProfile("user-a", "alice", null, null);
  const updated = await updateProfileExtras({
    id: "user-a",
    bio: "i price things",
    ctaLabel: "Visit my startup",
    ctaUrl: "https://example.com",
  });
  assert.ok(updated);
  assert.equal(updated?.bio, "i price things");
  assert.equal(updated?.ctaLabel, "Visit my startup");

  const reread = await getProfileByHandle("alice");
  assert.equal(reread?.ctaUrl, "https://example.com");

  // Unknown user id: no row touched.
  const missing = await updateProfileExtras({ id: "user-nope", bio: "x", ctaLabel: null, ctaUrl: null });
  assert.equal(missing, null);
  const still = await getProfileByHandle("alice");
  assert.equal(still?.bio, "i price things");
});

test("upsertProfile preserves existing extras (handle claim does not wipe CTA)", async () => {
  await upsertProfile("user-b", "bob", null, null);
  await updateProfileExtras({ id: "user-b", bio: "keep me", ctaLabel: "Follow me on X", ctaUrl: "https://x.com/bob" });
  await upsertProfile("user-b", "bob", "Bob", null);
  const reread = await getProfileByHandle("bob");
  assert.equal(reread?.bio, "keep me");
  assert.equal(reread?.ctaLabel, "Follow me on X");
});

test("clearing extras nulls them out", async () => {
  await upsertProfile("user-c", "carol", null, null);
  await updateProfileExtras({ id: "user-c", bio: "temp", ctaLabel: "temp", ctaUrl: "https://example.com" });
  await updateProfileExtras({ id: "user-c", bio: null, ctaLabel: null, ctaUrl: null });
  const reread = await getProfileByHandle("carol");
  assert.equal(reread?.bio, null);
  assert.equal(reread?.ctaLabel, null);
  assert.equal(reread?.ctaUrl, null);
});
