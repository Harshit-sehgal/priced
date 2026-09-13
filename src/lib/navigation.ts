/**
 * Reduce an untrusted `next`/redirect value to a path that can only ever
 * resolve back to our own origin.
 *
 * Callers resolve the result against the REAL origin, e.g.
 * `NextResponse.redirect(new URL(safeNext, url.origin))` in
 * `src/app/auth/callback/route.ts`. That makes the *output* — not just the
 * input — the security boundary, which is why the checks below run twice.
 *
 * The subtle case: WHATWG URL normalisation can COLLAPSE a `..` segment and
 * leave a protocol-relative path behind. `"/..//evil.com"` starts with a
 * single "/" and resolves to origin `priced.invalid`, so an input-only check
 * passes it — but its pathname is `"//evil.com"`, and
 * `new URL("//evil.com", "https://priced.app")` is `https://evil.com/`.
 * That turned a real, successful login into an attacker-controlled landing
 * page. Anything starting with `//` is therefore rejected outright, and the
 * final re-resolution proves the returned string cannot move origins.
 */
export function sanitizeInternalPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/")) return "/";

  try {
    const base = new URL("https://priced.invalid");
    const parsed = new URL(value, base);
    if (parsed.origin !== base.origin) return "/";

    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    // Protocol-relative after normalisation ("/..//evil.com" -> "//evil.com").
    if (!path.startsWith("/") || path.startsWith("//")) return "/";
    // Belt and braces: the value we hand back must itself be origin-stable.
    if (new URL(path, base).origin !== base.origin) return "/";

    return path;
  } catch {
    return "/";
  }
}

/**
 * Percent-decode a route parameter without throwing.
 *
 * A raw `%` (or any malformed escape) makes `decodeURIComponent` throw a
 * URIError, which surfaces as an unauthenticated 500 on every public
 * `/domain/[domain]` and `/u/[handle]` request that contains one — trivial
 * error spam and monitoring noise. Leaving the malformed value intact is safe:
 * every caller validates the result (evaluateDomain / isHandleValid) and
 * rejects it as malformed.
 */
export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
