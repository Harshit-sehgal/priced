// /api/quotes input contract. A non-string `domain` used to throw
// `input.trim is not a function` from normalizeDomain OUTSIDE the route's
// error mapping, surfacing as an unauthenticated 500. It must be a 400.
import assert from "node:assert/strict";
import test from "node:test";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { POST: quotesPOST } = (await import("../../src/app/api/quotes/route.ts")) as any;

type StubResponse = { status: number; body: unknown };

function post(body: unknown, ip: string): Request {
  return new Request("http://localhost/api/quotes", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("quotes: non-string and missing domains are rejected with 400, never a throw", async () => {
  let n = 0;
  for (const body of [{ domain: 123 }, { domain: true }, { domain: { a: 1 } }, { domain: ["x.com"] }, {}, { domain: "" }]) {
    const res = (await quotesPOST(post(body, `10.20.0.${++n}`))) as StubResponse;
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

test("quotes: a string domain reaches quote creation in demo mode", async () => {
  const res = (await quotesPOST(post({ domain: "example.com" }, "10.20.0.50"))) as StubResponse;
  // Demo mode has no profile for demo-user, so the route reports the missing
  // handle (409 NO_HANDLE) — which proves parsing/normalization ran cleanly.
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { code: "NO_HANDLE", error: "handle_required" });
});

test("quotes: amount must be a positive integer number of cents", async () => {
  let n = 60;
  for (const amountCents of [0, -1, 5.5, "1250", null, {}, []]) {
    const res = (await quotesPOST(post({ domain: "example.com", amountCents }, `10.20.0.${++n}`))) as StubResponse;
    assert.equal(res.status, 400, `expected 400 for amount ${JSON.stringify(amountCents)}`);
  }
});
