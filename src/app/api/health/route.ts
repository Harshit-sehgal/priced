export const dynamic = "force-dynamic";

// Lightweight liveness/readiness probe for monitoring.
// Never returns secrets. Cheap: does not touch Supabase unless explicitly asked
// via ?check=db (which is opt-in so the default probe stays off the DB).

/**
 * Deep checks (?check=db / ?check=redis) touch shared free-tier resources:
 * a Supabase query and an Upstash command. This route is unauthenticated and
 * deliberately excluded from the session proxy, so an anonymous loop could
 * burn the shared Upstash quota — and the rate limiter fails CLOSED, which
 * means exhausting it 429s the whole money path for everyone
 * (see src/lib/view-events.ts). Cache each deep result briefly so request
 * volume cannot multiply upstream calls; a healthy->unhealthy transition is
 * still visible within the window, and the scheduled probe runs every 15 min.
 */
const DEEP_CHECK_TTL_MS = 30_000;
const g = globalThis as unknown as {
  __pricedHealth?: Map<string, { at: number; status: number; body: unknown }>;
};
function healthCache(): Map<string, { at: number; status: number; body: unknown }> {
  if (!g.__pricedHealth) g.__pricedHealth = new Map();
  return g.__pricedHealth;
}

type DeepResult = { status: number; body: unknown };

async function cachedDeepCheck(key: string, compute: () => Promise<DeepResult>): Promise<Response> {
  const now = Date.now();
  const hit = healthCache().get(key);
  if (hit && now - hit.at < DEEP_CHECK_TTL_MS) {
    return Response.json(hit.body, { status: hit.status, headers: { "cache-control": "no-store" } });
  }
  const result = await compute();
  healthCache().set(key, { at: now, status: result.status, body: result.body });
  return Response.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const doDbCheck = url.searchParams.get("check") === "db";
  const doRedisCheck = url.searchParams.get("check") === "redis";
  const doOriginCheck = url.searchParams.get("check") === "origin";

  const base: Record<string, unknown> = {
    ok: true,
    ts: new Date().toISOString(),
  };

  // Config-drift probe: does NEXT_PUBLIC_APP_URL still match where we are
  // actually served from?
  //
  // WHY THIS IS WORTH A PROBE: that variable is not cosmetic. It builds the
  // Dodo success/cancel return URLs (so a stale value sends a paying customer
  // to a dead host after they have been charged), it is the self-host
  // blocklist in validateCta (so a stale value lets a holder point their CTA
  // back INTO Priced, which is exactly the confusion that rule prevents), and
  // it is the canonical base for metadata, sitemap and robots.
  //
  // Nothing detected drift before: the app happily serves from a new origin
  // while pointing every link at the old one. This deployment has already
  // moved Vercel -> Cloudflare Workers once, so it is a live failure mode, not
  // a hypothetical.
  //
  // Scoped deliberately: only a PRODUCTION datastore makes a mismatch a
  // money-path bug, and previews legitimately serve from a different host, so
  // a mismatch there is noise rather than signal.
  if (doOriginCheck) {
    const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
    // The Host the client actually reached is the truth we compare against;
    // req.url can be rewritten by the platform.
    const servedHost = (req.headers.get("host") ?? new URL(req.url).host).toLowerCase();
    if (!configured) {
      return Response.json(
        { ...base, origin: "not_configured", served_host: servedHost },
        { headers: { "cache-control": "no-store" } },
      );
    }
    let configuredHost: string;
    try {
      configuredHost = new URL(configured).host.toLowerCase();
    } catch {
      return Response.json(
        { ok: false, origin: "malformed", configured },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    const matches = configuredHost === servedHost;
    const { isProdDatastore } = await import("@/lib/repo");
    if (!matches && isProdDatastore) {
      return Response.json(
        { ok: false, origin: "mismatch", configured_host: configuredHost, served_host: servedHost },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    return Response.json(
      {
        ...base,
        origin: matches ? "ok" : "mismatch_non_prod",
        configured_host: configuredHost,
        served_host: servedHost,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  if (!doDbCheck) {
    if (doRedisCheck) {
      return cachedDeepCheck("redis", async () => {
        const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.trim().replace(/\/+$/, "");
        const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
        if (!redisUrl || !redisToken) {
          return { status: 503, body: { ...base, redis: "not_configured" } };
        }
        try {
          const redisResponse = await fetch(redisUrl, {
            method: "POST",
            headers: { Authorization: `Bearer ${redisToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(["PING"]),
            signal: AbortSignal.timeout(1500),
          });
          if (!redisResponse.ok) {
            return { status: 503, body: { ...base, redis: "unavailable", status: redisResponse.status } };
          }
          const payload = (await redisResponse.json()) as { result?: unknown };
          return { status: 200, body: { ...base, redis: payload.result === "PONG" ? "ok" : "unexpected" } };
        } catch {
          return { status: 503, body: { ...base, redis: "unavailable" } };
        }
      });
    }
    return Response.json(base, { headers: { "cache-control": "no-store" } });
  }

  // Optional DB probe: verify the service role can reach Postgres.
  return cachedDeepCheck("db", async () => {
    try {
      const { isProdDatastore } = await import("@/lib/repo");
      if (!isProdDatastore) {
        return { status: 200, body: { ...base, datastore: "demo" } };
      }
      const { createClient } = await import("@supabase/supabase-js");
      const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      // Cheap: list at most 1 domain row head count.
      const { error } = await c.from("domains").select("domain", { count: "exact", head: true }).limit(1);
      if (error) throw error;
      return { status: 200, body: { ...base, datastore: "supabase", db: "ok" } };
    } catch (e) {
      return {
        status: 503,
        body: { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) },
      };
    }
  });
}
