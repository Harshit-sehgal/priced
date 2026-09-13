import { APIRequestContext } from "@playwright/test";

/**
 * Demo-mode helper: the demo buyer needs a public handle before quoting.
 * In production (Supabase configured) this endpoint 401s; callers gate
 * auth-dependent tests on that themselves if ever needed.
 */
export async function handleFor(request: APIRequestContext): Promise<void> {
  const res = await request.post("/api/handle", {
    data: { handle: "smoketest" },
    headers: { "content-type": "application/json" },
  });
  // 429 is possible when another test's burst ran just before; the handle is
  // still valid because the demo buyer was already registered. A 400 is NOT
  // acceptable: it means INVALID_HANDLE/HANDLE_LOCKED, which would otherwise
  // surface later as an unrelated locator timeout.
  if (res.ok() || res.status() === 429) return;
  const detail = await res.text().catch(() => "");
  throw new Error(`handle setup failed: ${res.status()} ${detail.slice(0, 120)}`);
}

/**
 * Unique eligible domain per call so tests never collide with demo seed data
 * or with each other, even across repeated runs against a reused server.
 */
export function uniqueDomain(): string {
  return `ipt${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}.com`;
}
