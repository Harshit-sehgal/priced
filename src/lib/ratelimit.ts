// Fixed-window rate limiter (user list item 4).
// Production: shared Upstash Redis over REST (works across Vercel instances).
// Local/demo/CI without Redis credentials: in-memory fallback (single
// instance only — never rely on it in production).
//
// Failure policy is fail-CLOSED: if Redis is configured but unreachable, we
// reject the request (429) rather than let abuse through during an outage.
// Money-adjacent endpoints (quotes, checkout, handles) must not go unlimited.
import "server-only";

type Bucket = { count: number; resetAt: number };

const g = globalThis as unknown as { __iptBuckets?: Map<string, Bucket> };
function buckets(): Map<string, Bucket> {
  if (!g.__iptBuckets) g.__iptBuckets = new Map();
  return g.__iptBuckets;
}

function memoryCheck(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets().get(key);
  if (!b || b.resetAt <= now) {
    buckets().set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}

/** Test hook: clear in-memory fallback buckets. */
export function resetRateLimitForTests(): void {
  g.__iptBuckets?.clear();
}

function redisConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim().replace(/\/+$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

/** True when a shared limiter backs this process (multi-instance safe). */
export function isSharedRateLimiter(): boolean {
  return redisConfig() !== null;
}

// Atomic fixed window: INCR + PEXPIRE in one Lua script so concurrent
// serverless invocations share one counter and the key always gets a TTL.
const WINDOW_LUA = `local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end return c`;

async function redisCheck(key: string, limit: number, windowMs: number): Promise<boolean> {
  const cfg = redisConfig();
  if (!cfg) return memoryCheck(key, limit, windowMs);
  const namespaced = `ipt:rl:${key}`;
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      // Upstash's root REST endpoint accepts the complete Redis command as a
      // JSON array. The command name must therefore be included here.
      body: JSON.stringify(["EVAL", WINDOW_LUA, "1", namespaced, String(windowMs)]),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false; // fail closed
    const body = (await res.json()) as { result?: unknown };
    const count = typeof body.result === "number" ? body.result : Number(body.result);
    if (!Number.isFinite(count)) return false;
    return count <= limit;
  } catch {
    return false; // Redis outage → reject, never unlimited
  }
}

export async function rateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  return redisCheck(key, limit, windowMs);
}

/** One dimension of a layered limit (per-user, per-IP, per-domain, …). */
export type RateLimitDimension = { key: string; limit: number; windowMs: number };

/**
 * Check several independent dimensions in ONE Upstash round-trip.
 *
 * WHY: the money-path routes layer 2-4 dimensions, and awaiting them
 * separately serialised a full HTTPS round-trip to us-west-1 each — on
 * /api/quotes that was four before any real work began. It also burned four
 * commands against a FREE-TIER database that the quote/checkout/handle
 * limiters share, and `rateLimit` fails CLOSED: exhausting that quota 429s
 * checkout. Fewer round-trips is a resilience win, not only a latency one.
 *
 * Behaviour is identical to the sequential code it replaces. That is only true
 * because every call site already awaited ALL of its limiters before testing
 * any result, so no short-circuit is being lost — each dimension's counter was
 * always incremented. `every()` is deliberately NOT used to drive the checks
 * for the same reason: it would stop incrementing at the first denial and
 * quietly change which counters advance.
 */
export async function rateLimitAll(dimensions: RateLimitDimension[]): Promise<boolean> {
  if (dimensions.length === 0) return true;
  const cfg = redisConfig();
  if (!cfg) {
    // Evaluate every dimension, then combine — see the note above.
    const results = dimensions.map((d) => memoryCheck(d.key, d.limit, d.windowMs));
    return results.every(Boolean);
  }
  try {
    const res = await fetch(`${cfg.url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      // Upstash's /pipeline endpoint takes an array of complete commands and
      // returns one {result} or {error} object per command, in order.
      body: JSON.stringify(
        dimensions.map((d) => ["EVAL", WINDOW_LUA, "1", `ipt:rl:${d.key}`, String(d.windowMs)]),
      ),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false; // fail closed
    const body = (await res.json()) as unknown;
    // Anything we cannot fully account for is a denial: a short, malformed or
    // partially-errored pipeline means we do not know the counts, and "unsure"
    // must never resolve to "allowed" on a money path.
    if (!Array.isArray(body) || body.length !== dimensions.length) return false;
    for (let i = 0; i < dimensions.length; i++) {
      const entry = body[i] as { result?: unknown; error?: unknown };
      if (!entry || entry.error !== undefined) return false;
      const count = typeof entry.result === "number" ? entry.result : Number(entry.result);
      if (!Number.isFinite(count)) return false;
      if (count > dimensions[i]!.limit) return false;
    }
    return true;
  } catch {
    return false; // Redis outage → reject, never unlimited
  }
}
