// The sitemap must not advertise suspended profiles: their page renders the
// hidden "holds nothing yet" state, so indexing them contradicts moderation.
// Memory adapter (demo/CI) — the Supabase path is a chunked, lenient lookup.
import assert from "node:assert/strict";
import test from "node:test";
import { getProfileById, resetMemoryMarket, seedDemoMarket } from "../../src/lib/repo.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { default: sitemap } = (await import("../../src/app/sitemap.ts")) as any;

test.beforeEach(() => resetMemoryMarket());

test("suspended holders are excluded from the sitemap while their tags stay", async () => {
  seedDemoMarket([
    { domain: "keeper-tag.com", holderHandle: "keeper", priceCents: 500 },
    { domain: "hidden-tag.com", holderHandle: "hidden", priceCents: 800 },
  ]);
  const hidden = (await getProfileById("demo-hidden"))!;
  hidden.suspendedAt = new Date().toISOString();

  const entries = (await sitemap()) as Array<{ url: string }>;
  const urls = entries.map((e) => e.url);
  assert.ok(urls.some((u) => u.endsWith("/u/keeper")), "active holder profile stays indexed");
  assert.ok(!urls.some((u) => u.endsWith("/u/hidden")), "suspended holder profile is not advertised");
  assert.ok(
    urls.some((u) => u.endsWith("/domain/hidden-tag.com")),
    "the tag page itself remains (the holding is ledger truth)",
  );
});
