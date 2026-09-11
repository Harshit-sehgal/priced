import { listMarket, listRecentSales } from "@/lib/repo";
import { rateLimit } from "@/lib/ratelimit";
import { logEvent } from "@/lib/logger";
import { clientIp } from "@/lib/client-ip";

export const dynamic = "force-dynamic";

// Deliberately excluded from the proxy matcher (no session needed), which also
// made it the cheapest request for an attacker and the most expensive one for
// the backend: two Supabase queries returning up to 200 rows, uncached and
// unlimited. Three guards now stand in front of that.

// 1. Realtime deployments never poll this endpoint — realtime-browser.ts only
//    falls back to polling when the public Supabase env vars are absent. The
//    server sees exactly the same build-time env, so when Realtime is
//    configured the endpoint answers a constant fingerprint and touches no
//    database. Demo mode (no Supabase env) keeps the real polling path.
function realtimeConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

// 2. Short shared cache. The demo poller ticks every 5s, so a 4s window keeps
//    a single viewer's updates effectively live while collapsing every
//    additional concurrent viewer onto one pair of queries.
const PULSE_TTL_MS = 4_000;
const g = globalThis as unknown as { __pricedPulse?: { v: string; expiresAt: number } };

// 3. Per-IP ceiling. One polling tab costs 12 requests/minute; 60 leaves room
//    for several tabs behind one NAT and still bounds a scripted flood.
const PULSE_IP_LIMIT = 60;
const PULSE_WINDOW_MS = 60_000;

const CACHE_HEADER = `public, max-age=0, s-maxage=${Math.floor(PULSE_TTL_MS / 1000)}, stale-while-revalidate=10`;

/**
 * Cheap market-state fingerprint for the demo-mode polling fallback.
 * Realtime deployments never call this; Supabase Realtime drives updates.
 */
export async function GET(req: Request) {
  if (realtimeConfigured()) {
    // Constant value: a client that polls anyway simply never sees a change
    // and degrades to manual refresh, exactly like a dropped Realtime socket.
    return Response.json(
      { v: "realtime" },
      { headers: { "cache-control": "public, max-age=60, s-maxage=300" } },
    );
  }

  const ip = clientIp(req.headers);
  if (!(await rateLimit(`pulse:ip:${ip}`, PULSE_IP_LIMIT, PULSE_WINDOW_MS))) {
    return Response.json({ error: "rate_limited" }, { status: 429, headers: { "cache-control": "no-store" } });
  }

  const now = Date.now();
  const cached = g.__pricedPulse;
  if (cached && cached.expiresAt > now) {
    return Response.json({ v: cached.v }, { headers: { "cache-control": CACHE_HEADER } });
  }

  try {
    const [rows, latest] = await Promise.all([listMarket(200), listRecentSales(1)]);
    const maxUpdated = rows.reduce((acc, r) => (r.updatedAt && r.updatedAt > acc ? r.updatedAt : acc), "");
    const v = `${maxUpdated}|${rows.length}|${latest[0]?.id ?? ""}|${latest[0]?.priceCents ?? ""}`;
    g.__pricedPulse = { v, expiresAt: now + PULSE_TTL_MS };
    return Response.json({ v }, { headers: { "cache-control": CACHE_HEADER } });
  } catch (err) {
    // Rare enough to log: the display fallback is blind while this fails.
    logEvent("market_pulse_failed", "error", { reason: err instanceof Error ? err.name : "unknown" });
    return Response.json({ v: "unavailable" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
