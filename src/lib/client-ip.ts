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
 *
 * `x-real-ip` is deliberately NOT trusted: it is client-sendable on any path
 * where the edge does not overwrite it (direct-to-origin bypass, non-Vercel
 * hosting), so trusting it re-opens the exact bucket-rotation bypass this
 * module was written to close.
 * `x-forwarded-for` is LAST, and only as a best-effort fallback for local
 * dev, where there is no edge at all.
 *
 * Values are validated as literal IPv4/IPv6 before use: a garbage string
 * must not become a limiter bucket (or poison Turnstile remoteip).
 *
 * Returns "unknown" when nothing is available. Callers bucket on that string,
 * which is deliberate: an unidentifiable client shares one strict bucket
 * rather than escaping the limiter entirely.
 */
export function clientIp(headers: Headers): string {
  const platform = headers.get("cf-connecting-ip") ?? headers.get("x-vercel-forwarded-for");
  if (platform) {
    const value = platform.split(",")[0]?.trim();
    if (value && isLiteralIp(value)) return value;
  }
  // Fallback only. Behind a real edge one of the headers above is always
  // present, so this branch is local dev — where spoofing is not a threat.
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded && isLiteralIp(forwarded)) return forwarded;
  return "unknown";
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
// IPv6 hex form (compressed or full). The previous charset check accepted
// garbage like "1:2:3" or "abc:def", which defeats the validation's purpose on
// any deployment where a forgeable forwarded header is the fallback source.
const IPV6_RE =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
// IPv4-mapped/embedded forms: ::ffff:192.0.2.1, ::192.0.2.1, 0:0:0:0:0:ffff:192.0.2.1.
const IPV6_V4_RE =
  /^::(?:ffff(?::0{1,4})?:)?(?:(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])\.){3}(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])$/i;

/** Literal IP only: bucket cardinality and Turnstile remoteip stay clean. */
function isLiteralIp(value: string): boolean {
  if (value.length > 45) return false;
  if (IPV4_RE.test(value)) return true;
  if (!value.includes(":")) return false;
  // Zone ids (fe80::1%eth0) are transport-local; validate the address part.
  const address = value.split("%")[0] ?? value;
  return IPV6_RE.test(address) || IPV6_V4_RE.test(address);
}
