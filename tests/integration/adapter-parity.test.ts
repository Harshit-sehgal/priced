// Adapter parity: the in-memory store must enforce the same profile invariants
// as Supabase/Postgres, or the whole suite green-lights rules production never
// actually applies. Two divergences are pinned here:
//
//  1. handle exclusivity — SQL upserts profiles on the primary key and the
//     unique index on profiles.handle raises 23505 when a second user tries to
//     take a claimed handle. src/lib/auth.ts claimHandle turns that violation
//     into HANDLE_TAKEN. A memory store keyed by handle instead silently
//     overwrote the row, handing userB someone else's public identity.
//  2. suspension — the SQL upsert writes id/handle/display_name/avatar_url
//     only, so a re-claim cannot lift moderation state. The memory path used to
//     hardcode suspendedAt: null, wiping a suspension on the next upsert.
import assert from "node:assert/strict";
import test from "node:test";
import {
  resetMemoryMarket,
  upsertProfile,
  getProfileById,
  getProfileByHandle,
  updateProfileExtras,
  seedDemoMarket,
  type RepoProfile,
} from "../../src/lib/repo.ts";

// The exact matcher src/lib/auth.ts claimHandle() uses to map a driver-level
// uniqueness violation onto HANDLE_TAKEN. If the memory adapter's error stops
// matching this, claimHandle silently reports success on a hijack.
const CLAIM_HANDLE_TAKEN_MATCHER = /duplicate key.*handle|unique.*handle|23505/i;

test.beforeEach(() => resetMemoryMarket());

test("profiles are keyed by id: two users keep separate rows", async () => {
  await upsertProfile("user-a", "alice", "Alice", null);
  await upsertProfile("user-b", "bob", "Bob", null);

  assert.equal((await getProfileById("user-a"))?.handle, "alice");
  assert.equal((await getProfileById("user-b"))?.handle, "bob");
  assert.equal((await getProfileByHandle("alice"))?.id, "user-a");
  assert.equal((await getProfileByHandle("bob"))?.id, "user-b");
  assert.equal(await getProfileById("user-nope"), null);
  assert.equal(await getProfileByHandle("nobody"), null);
  // Handle lookup accepts the display form as well as the stored bare form.
  assert.equal((await getProfileByHandle("@Alice"))?.id, "user-a");
});

test("a second user cannot hijack a claimed handle", async () => {
  await upsertProfile("user-a", "bob", "Real Bob", null);

  await assert.rejects(
    () => upsertProfile("user-b", "bob", "Impostor", null),
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      assert.match(msg, CLAIM_HANDLE_TAKEN_MATCHER, "claimHandle must be able to map this onto HANDLE_TAKEN");
      return true;
    },
  );

  // The original holder is untouched and the impostor has no profile at all.
  const holder = await getProfileByHandle("bob");
  assert.equal(holder?.id, "user-a");
  assert.equal(holder?.displayName, "Real Bob");
  assert.equal(await getProfileById("user-b"), null);
});

test("handle exclusivity is case-insensitive, like the stored-lowercase SQL column", async () => {
  await upsertProfile("user-a", "bob", null, null);
  await assert.rejects(() => upsertProfile("user-b", "BOB", null, null), CLAIM_HANDLE_TAKEN_MATCHER);
  assert.equal((await getProfileByHandle("bob"))?.id, "user-a");
});

test("re-upserting your own profile updates identity fields and keeps extras", async () => {
  await upsertProfile("user-a", "alice", null, null);
  await updateProfileExtras({ id: "user-a", bio: "keep me", ctaLabel: "Follow", ctaUrl: "https://example.com" });

  const again = await upsertProfile("user-a", "alice", "Alice A", "https://cdn.example.com/a.png");
  assert.equal(again.displayName, "Alice A");
  assert.equal(again.avatarUrl, "https://cdn.example.com/a.png");
  assert.equal(again.bio, "keep me");
  assert.equal(again.ctaLabel, "Follow");
  assert.equal(again.ctaUrl, "https://example.com");
  assert.equal((await getProfileByHandle("alice"))?.bio, "keep me");
});

test("upsert does not lift a suspension", async () => {
  await upsertProfile("user-a", "alice", null, null);

  // The memory adapter hands back the live row (no copy), which is how a
  // moderation write — an admin UPDATE against profiles.suspended_at in
  // production — is represented locally.
  const stored = (await getProfileById("user-a")) as RepoProfile;
  stored.suspendedAt = "2026-09-12T00:00:00.000Z";

  const after = await upsertProfile("user-a", "alice", "Alice", null);
  assert.equal(after.suspendedAt, "2026-09-12T00:00:00.000Z", "an upsert must not clear moderation state");
  assert.equal((await getProfileById("user-a"))?.suspendedAt, "2026-09-12T00:00:00.000Z");
  assert.equal((await getProfileByHandle("alice"))?.suspendedAt, "2026-09-12T00:00:00.000Z");

  // Profile-extras writes are likewise not a moderation escape hatch.
  const extras = await updateProfileExtras({ id: "user-a", bio: "still here", ctaLabel: null, ctaUrl: null });
  assert.equal(extras?.suspendedAt, "2026-09-12T00:00:00.000Z");
});

test("updateProfileExtras targets the id, never the handle", async () => {
  await upsertProfile("user-a", "alice", null, null);
  await upsertProfile("user-b", "bob", null, null);

  const updated = await updateProfileExtras({ id: "user-b", bio: "bob only", ctaLabel: null, ctaUrl: null });
  assert.equal(updated?.handle, "bob");
  assert.equal((await getProfileByHandle("bob"))?.bio, "bob only");
  assert.equal((await getProfileByHandle("alice"))?.bio, null);
  assert.equal(await updateProfileExtras({ id: "user-missing", bio: "x", ctaLabel: null, ctaUrl: null }), null);
});

test("demo seeding stores holder profiles under the same id key", async () => {
  seedDemoMarket([{ domain: "openai.com", holderHandle: "@seeded", priceCents: 1500 }]);

  const byHandle = await getProfileByHandle("seeded");
  assert.ok(byHandle, "seeded holder must be reachable by handle");
  assert.equal((await getProfileById(byHandle.id))?.handle, "seeded");

  // And a seeded handle is still exclusive against a real signup.
  await assert.rejects(() => upsertProfile("user-x", "seeded", null, null), CLAIM_HANDLE_TAKEN_MATCHER);
});

// The Supabase path capped its scans (1000 domains, 2000 sales) while the
// in-memory path scanned everything. Since the whole node suite runs the
// in-memory adapter, every test was exercising semantics production does not
// have — and the two would report different headline numbers the moment the
// market grew past a cap. The caps now live in shared.ts and both adapters
// apply them; these tests fail if the memory path stops honouring them.
test("marketValueCents honours the shared sampling cap", async () => {
  const { resetMemoryMarket } = await import("../../src/lib/repo.ts");
  const { MARKET_VALUE_SAMPLE_LIMIT } = await import("../../src/lib/repo/shared.ts");
  const memory = await import("../../src/lib/repo/memory.ts");
  resetMemoryMarket();

  const over = MARKET_VALUE_SAMPLE_LIMIT + 25;
  memory.seedDemoMarket(
    Array.from({ length: over }, (_, i) => ({
      domain: `cap-${i}.com`,
      holderHandle: `h${i}`,
      priceCents: 100,
    })),
  );

  const value = await memory.marketValueCents();
  assert.equal(
    value,
    MARKET_VALUE_SAMPLE_LIMIT * 100,
    "must sum at most the cap, not every held domain",
  );
  resetMemoryMarket();
});

test("unheld domains never count toward market value", async () => {
  const { resetMemoryMarket } = await import("../../src/lib/repo.ts");
  const memory = await import("../../src/lib/repo/memory.ts");
  resetMemoryMarket();
  memory.seedDemoMarket([{ domain: "held.com", holderHandle: "a", priceCents: 500 }]);
  assert.equal(await memory.marketValueCents(), 500);
  resetMemoryMarket();
});

// The blocklist exists to keep impersonation-dangerous tags out of the game,
// and the Terms say a domain may be reserved AFTER it is already held. Before
// this, only the sitemap and "Most Fought Over" honoured it, so reserving a
// dangerous tag left it promoted on the homepage table, in Newly Claimed and
// in the activity feed. A control that only half the surfaces respect is not
// a control.
test("reserved tags are dropped from every discovery surface", async () => {
  const { resetMemoryMarket } = await import("../../src/lib/repo.ts");
  const memory = await import("../../src/lib/repo/memory.ts");
  const { DEFAULT_RESERVED_DOMAINS } = await import("../../src/lib/domains.ts");
  resetMemoryMarket();

  const reserved = DEFAULT_RESERVED_DOMAINS[0]!; // statically blocklisted
  memory.seedDemoMarket([
    { domain: reserved, holderHandle: "impostor", priceCents: 900 },
    { domain: "allowed-tag.com", holderHandle: "ok", priceCents: 500 },
  ]);
  // A takeover (previous price > 0) so the tag also qualifies for Fastest
  // Rising — otherwise that surface would pass vacuously.
  const { finalizeTakeover, upsertProfile } = await import("../../src/lib/repo.ts");
  await upsertProfile("u-rise", "riser", null, null);
  await finalizeTakeover({
    domain: reserved,
    buyerUserId: "u-rise",
    buyerHandle: "riser",
    expectedVersion: 1,
    paidCents: 1400,
    providerPaymentId: "pi-reserved-rise",
  });

  const market = await memory.listMarket(50);
  assert.ok(
    !market.some((d) => d.domain === reserved),
    `${reserved} must not appear in the market table`,
  );
  assert.ok(market.some((d) => d.domain === "allowed-tag.com"), "ordinary tags still listed");

  const recent = await memory.listRecentSales(50);
  assert.ok(!recent.some((s) => s.domain === reserved), "reserved tag must not appear in activity");

  const claimed = await memory.listNewlyClaimed(50);
  assert.ok(!claimed.some((r) => r.domain === reserved), "reserved tag must not appear in newly claimed");

  const rising = await memory.listFastestRising(50);
  assert.ok(!rising.some((r) => r.domain === reserved), "reserved tag must not appear in fastest rising");

  resetMemoryMarket();
});

test("filtering reserved rows does not under-fill a list", async () => {
  const { resetMemoryMarket } = await import("../../src/lib/repo.ts");
  const memory = await import("../../src/lib/repo/memory.ts");
  resetMemoryMarket();
  // Over-fetch must still return a full page of allowed rows.
  memory.seedDemoMarket(
    Array.from({ length: 30 }, (_, i) => ({
      domain: `fill-${i}.com`,
      holderHandle: `h${i}`,
      priceCents: 500 + i,
    })),
  );
  assert.equal((await memory.listMarket(25)).length, 25, "a full page is still returned");
  resetMemoryMarket();
});
