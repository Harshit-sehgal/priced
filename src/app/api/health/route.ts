export const dynamic = "force-dynamic";

// Lightweight liveness/readiness probe for Vercel/monitoring.
// Never returns secrets. Cheap: does not touch Supabase unless explicitly asked
// via ?check=db (which is opt-in so the default probe stays off the DB).
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
      const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.trim().replace(/\/+$/, "");
      const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
      if (!redisUrl || !redisToken) {
        return Response.json({ ...base, redis: "not_configured" }, { status: 503, headers: { "cache-control": "no-store" } });
      }
      try {
        const redisResponse = await fetch(redisUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${redisToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(["PING"]),
          signal: AbortSignal.timeout(1500),
        });
        if (!redisResponse.ok) {
          return Response.json({ ...base, redis: "unavailable", status: redisResponse.status }, { status: 503, headers: { "cache-control": "no-store" } });
        }
        const payload = (await redisResponse.json()) as { result?: unknown };
        return Response.json({ ...base, redis: payload.result === "PONG" ? "ok" : "unexpected" }, { headers: { "cache-control": "no-store" } });
      } catch {
        return Response.json({ ...base, redis: "unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
      }
    }
    return Response.json(base, { headers: { "cache-control": "no-store" } });
  }

  // Optional DB probe: verify the service role can reach Postgres.
  try {
    const { isProdDatastore } = await import("@/lib/repo");
    if (!isProdDatastore) {
      return Response.json({ ...base, datastore: "demo" }, { headers: { "cache-control": "no-store" } });
    }
    const { createClient } = await import("@supabase/supabase-js");
    const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Cheap: list at most 1 domain row head count.
    const { error } = await c.from("domains").select("domain", { count: "exact", head: true }).limit(1);
    if (error) throw error;
    return Response.json({ ...base, datastore: "supabase", db: "ok" }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
