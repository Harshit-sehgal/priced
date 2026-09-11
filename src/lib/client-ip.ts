/**
 * The client IP used as a rate-limit dimension.
 *
 * WHY THIS EXISTS: every route used to read
 * `x-forwarded-for.split(",")[0]` directly. That is safe ONLY on a host that
 * overwrites the header, which Vercel does. This deployment is moving to
 * Cloudflare Workers (see `open-next.config.ts` / `wrangler.jsonc`), and
 * Cloudflare does NOT sanitize `X-Forwarded-For` — a client may send whatever
 * it likes, and the left-most entry is therefore ATTACKER-CONTROLLED.
 *
 * Left unchanged, every IP-dimension limit (`quote:ip`, `checkout:ip`,
 * `handle:ip`, `analytics:ip`, `view:ip`, `pulse:ip`, `demo-sign:ip`) would be
 * bypassed by sending a fresh random `X-Forwarded-For` per request — which
 * re-opens the unauthenticated write-amplifier and abuse paths those limits
 * exist to close.
 *
 * Precedence is therefore "most trustworthy first", and only platform-set
 * headers are trusted:
 *   1. `cf-connecting-ip`   — set by Cloudflare, stripped from client input.
 *   2. `x-vercel-forwarded-for` — set by Vercel's edge, not client-settable.
 *   3. `x-real-ip`          — set by common reverse proxies.
 *   4. `x-forwarded-for`    — LAST, and only as a best-effort fallback for
 *                             local dev, where there is no edge at all.
 *
 * Returns "unknown" when nothing is available. Callers bucket on that string,
 * which is deliberate: an unidentifiable client shares one strict bucket
 * rather than escaping the limiter entirely.
 */
export function clientIp(headers: Headers): string {
  const platform =
    headers.get("cf-connecting-ip") ??
    headers.get("x-vercel-forwarded-for") ??
    headers.get("x-real-ip");
  if (platform) {
    const value = platform.split(",")[0]?.trim();
    if (value) return value;
  }
  // Fallback only. Behind a real edge one of the headers above is always
  // present, so this branch is local dev — where spoofing is not a threat.
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}
