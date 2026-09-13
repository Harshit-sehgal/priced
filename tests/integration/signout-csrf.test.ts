// /api/auth/signout CSRF contract: a mutating route must reject a cross-origin
// HTML form post. A form cannot produce `application/json`, so the content-type
// gate closes logout-CSRF; the JSON path must keep working for the real button.
import assert from "node:assert/strict";
import test from "node:test";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { POST: signoutPOST } = (await import("../../src/app/api/auth/signout/route.ts")) as any;

function post(contentType: string, body: string): Request {
  return new Request("http://localhost/api/auth/signout", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

test("signout rejects non-JSON content types (logout-CSRF guard)", async () => {
  for (const contentType of ["text/plain", "application/x-www-form-urlencoded", ""]) {
    const res = (await signoutPOST(post(contentType, "csrf=1"))) as { status: number; body: unknown };
    assert.equal(res.status, 415, `expected 415 for "${contentType}"`);
    assert.deepEqual(res.body, { error: "unsupported_media_type" });
  }
});

test("signout accepts a JSON request (the real button path)", async () => {
  const res = (await signoutPOST(post("application/json", "{}"))) as { status: number; body: unknown };
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, demo: true });
});
