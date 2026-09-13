#!/usr/bin/env node
/**
 * Live race/load test (§74 "load testing", §18 concurrency).
 *
 * Drives the REAL HTTP path of a running production build in demo mode:
 *   N racers all quote the same unclaimed domain at once, all open
 *   checkouts, and all fire signed succeeded-webhooks concurrently.
 *
 * Asserts the plan's invariants:
 *   - exactly ONE sale for the domain;
 *   - the domain page shows the winner and the price advanced exactly once;
 *   - every loser got a deterministic, money-safe outcome
 *     (stale quote + refund, expired/stale quote rejection, or duplicate);
 *   - throttling (429) is accounted for, never a crash: no 5xx chaos.
 *
 * Usage: node tests/load/race.mjs [baseUrl] [racers]
 * Defaults: http://127.0.0.1:3111 (Playwright's webServer port), 8 racers.
 */
const BASE = process.argv[2] ?? "http://127.0.0.1:3111";
const N = Number(process.argv[3] ?? 8);

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

async function post(path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
  return { status: res.status, json };
}

// Sign via the app's own demo signing route (the demo secret is no longer a
// static constant; local dev generates a random per-process secret).
async function sign(payload) {
  const res = await post("/api/demo/sign", { payload });
  if (!res.json?.signature) throw new Error("demo sign route unavailable");
  return res.json.signature;
}

// Retry a single request until it clears the rate limiter (429) or fails hard.
// The demo limiter is a fixed 60s window, so throttled racers ride it out.
async function postWithRetry(path, body, headers = {}, maxMs = 90_000) {
  const start = Date.now();
  for (;;) {
    const r = await post(path, body, headers);
    if (r.status !== 429 || Date.now() - start > maxMs) return r;
    await new Promise((res) => setTimeout(res, 2_500));
  }
}

// --- setup: lock in the demo buyer handle, then quote a unique domain --------
const handle = await postWithRetry("/api/handle", { handle: "smoketest" });
assert(handle.status === 200 || handle.status === 400, `handle setup unexpected status ${handle.status}`);

const domain = `race${Date.now().toString(36)}.com`;

// --- everyone quotes simultaneously -----------------------------------------
const quoteResponses = await Promise.all(
  Array.from({ length: N }, () => postWithRetry("/api/quotes", { domain })),
);
const quotes = quoteResponses.filter((r) => r.status === 200 && r.json?.quoteId);
const throttledQuotes = quoteResponses.length - quotes.length;
assert(quotes.length > 0, "no racer got a quote");
const price = quotes[0].json.nextPriceCents;
assert(price === 500, `first-claim price should be 500 cents, got ${price}`);

// --- everyone checks out simultaneously --------------------------------------
const checkoutResponses = await Promise.all(
  quotes.map((q) => postWithRetry("/api/checkout", { quoteId: q.json.quoteId })),
);
// Keep each checkout PAIRED with the quote it belongs to. Filtering first and
// then indexing `quotes[i]` misaligned the two the moment one racer's checkout
// failed: the webhook under test could reference a quote that was never
// checked out, and the race could "pass" without exercising the intended pair.
const checkouts = checkoutResponses
  .map((res, i) => ({ res, quote: quotes[i] }))
  .filter(({ res }) => res.status === 200 && res.json?.checkoutUrl);
assert(checkouts.length > 0, "no racer opened a checkout");

// --- everyone pays at the same instant (concurrent webhooks) ------------------
const payments = await Promise.all(
  checkouts.map(async ({ res: checkout, quote }, i) => {
    const quoteId = quote.json.quoteId;
    const payload = JSON.stringify({
      id: `evt_race_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
      type: "payment_intent.succeeded",
      // The provider payment id the checkout route actually stored — never a
      // reconstructed guess.
      payment_intent: checkout.json.providerPaymentId ?? `demo_pi_${quoteId}`,
      metadata: {
        quote_id: quoteId,
        domain,
        amount_cents: String(price),
      },
    });
    const sig = await sign(payload);
    return post("/api/webhooks/payments", JSON.parse(payload), { "x-demo-signature": sig });
  }),
);

// --- assert the invariants ---------------------------------------------------
const processed = payments.filter((p) => p.json?.result?.outcome === "processed");
const stale = payments.filter(
  (p) =>
    p.json?.result?.outcome === "failed" &&
    ["stale_quote", "quote_stale"].includes(p.json?.result?.reason),
);
const duplicates = payments.filter((p) => p.json?.result?.outcome === "duplicate");
const other = payments.filter(
  (p) => !processed.includes(p) && !stale.includes(p) && !duplicates.includes(p),
);

assert(processed.length === 1, `exactly one winner expected, got ${processed.length}`);
assert(
  other.length === 0,
  `unexpected outcomes present: ${other.map((o) => JSON.stringify(o.json)).join("; ") || "none"}`,
);
// A FAILED refund also returns outcome "failed" with reason stale_quote, but
// with `refunded: false` and HTTP 500 (the task retries). It matched the
// `stale` filter above, so without this assertion a loser whose money was
// never returned still printed "no money lost" — exactly how the hosted
// INSUFFICIENT_WALLET_FUNDS race could have looked green.
const unrefunded = payments.filter(
  (p) => p.json?.result?.outcome === "failed" && p.json?.result?.refunded !== true,
);
assert(
  unrefunded.length === 0,
  `losers whose refund did not complete: ${unrefunded.map((u) => JSON.stringify({ status: u.status, result: u.json?.result })).join("; ")}`,
);
const saleId = processed[0].json?.result?.saleId;
assert(typeof saleId === "string" && saleId.length > 10, "winner produced no sale id");

// The market shows exactly one holder and the price advanced once.
const page = await fetch(`${BASE}/domain/${domain}`).then((r) => r.text());
assert(page.includes("@smoketest"), "domain page shows the winner");
assert(page.includes("$10"), "domain page shows the advanced price");

console.log(
  `OK: ${N} racers → 1 winner (sale ${saleId.slice(0, 8)}…), ` +
    `${stale.length} stale-refunded, ${duplicates.length} duplicates, ` +
    `${throttledQuotes} throttled at quote — no money lost`,
);
