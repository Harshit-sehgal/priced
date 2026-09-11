// Abuse guards for analytics writes (§42 funnel, §46 abuse).
//
// Two problems this file solves:
//
// 1. Server-rendered "view" events (`profile_viewed`, `tag_viewed`,
//    `share_visit`) used to insert one analytics_events row per render. That
//    made holder numbers trivially forgeable (a curl loop inflates a holder's
//    view count) and turned every crawler, Slack/Discord unfurl and every
//    LiveRefresh-driven `router.refresh()` into a database write. On the
//    Supabase free tier (500 MB) a row plus its four indexes costs ~2 KB, so
//    an unbounded write path is a storage-exhaustion vector, not just noise.
// 2. `/api/analytics` capped each prop VALUE at 512 chars but never capped the
//    NUMBER of keys, so one 10 KiB body could persist ~200 keys of jsonb.
//
// Everything here is fail-open for RENDERING and fail-closed for COUNTING:
// when a guard cannot run (Redis outage, missing headers) the page still
// renders perfectly, it simply does not persist a row. Analytics must never
// break the funnel.
import "server-only";

import { rateLimit } from "./ratelimit.ts";
import { clientIp } from "./client-ip.ts";

/** Server-rendered view events guarded by {@link persistViewEvent}. */
export type ViewEvent = "profile_viewed" | "tag_viewed" | "share_visit";

// One row per (IP, event, resource) per 5 minutes. This is the standard
// "unique view" definition and it is what makes holder analytics honest: a
// refresh loop, a realtime re-render, or a curl loop all collapse to one row.
export const VIEW_DEDUP_WINDOW_MS = 5 * 60_000;

// Ceiling across ALL resources for one IP. Bot filtering already removes
// declared crawlers; this bounds an undeclared scraper walking thousands of
// distinct domain pages, each of which would otherwise be a fresh dedup key.
export const VIEW_IP_LIMIT = 60;
export const VIEW_IP_WINDOW_MS = 60_000;

/**
 * Per-instance, in-memory budget for anonymous telemetry. No network at all.
 *
 * WHY: the view and analytics guards spend Upstash commands on unauthenticated
 * traffic, and they share ONE free-tier Redis with the quote / checkout /
 * handle limiters — which fail CLOSED. Without a local gate, a flood of page
 * views or /api/analytics POSTs can exhaust the shared command quota, and once
 * Upstash starts refusing, `rateLimit` returns false for everything: the money
 * path 429s. Telemetry must never be able to take down checkout.
 *
 * This gate runs BEFORE the first Redis call, so a flood is shed at ~zero cost
 * and spends no quota. It is deliberately generous — it is a blast-radius cap,
 * not the real limiter. Being per-instance and memory-only it resets on cold
 * start, which is fine: its only job is to bound what one instance can spend.
 */
export const TELEMETRY_LOCAL_LIMIT = 300;
export const TELEMETRY_LOCAL_WINDOW_MS = 60_000;

type LocalBucket = { count: number; resetAt: number };
const g = globalThis as unknown as { __iptTelemetryLocal?: Map<string, LocalBucket> };
function localBuckets(): Map<string, LocalBucket> {
  if (!g.__iptTelemetryLocal) g.__iptTelemetryLocal = new Map();
  return g.__iptTelemetryLocal;
}

/** Test hook: clear the in-process telemetry budget. */
export function resetTelemetryBudgetForTests(): void {
  g.__iptTelemetryLocal?.clear();
}

/**
 * True when this instance may still spend a Redis command on telemetry.
 * Fails CLOSED (returns false) once the local budget is exhausted — dropping a
 * view is always preferable to risking the money path.
 */
export function withinLocalTelemetryBudget(dimension: string): boolean {
  const now = Date.now();
  const buckets = localBuckets();
  // Bound the map itself: an unbounded key space would be its own memory leak.
  if (buckets.size > 5_000) buckets.clear();
  const bucket = buckets.get(dimension);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(dimension, { count: 1, resetAt: now + TELEMETRY_LOCAL_WINDOW_MS });
    return true;
  }
  if (bucket.count >= TELEMETRY_LOCAL_LIMIT) return false;
  bucket.count += 1;
  return true;
}

// `/api/analytics` limits. Analytics is high-volume by nature, so these are
// generous enough that a real browsing session never trips them and tight
// enough that one host cannot fill the free-tier database: 120 rows/min is
// ~340 MB/day worst case per IP instead of the previous unbounded rate.
export const ANALYTICS_IP_LIMIT = 120;
export const ANALYTICS_SESSION_LIMIT = 60;
export const ANALYTICS_WINDOW_MS = 60_000;

/** Maximum jsonb keys persisted per analytics event. */
export const MAX_ANALYTICS_PROP_KEYS = 24;

// Declared automation: link unfurlers, crawlers, uptime checks, HTTP clients.
// These are real traffic but they are not a human looking at a holder's tag,
// so they must not move holder numbers. Matching is deliberately broad — a
// false positive costs one uncounted view, a false negative costs a DB row
// and a forged statistic.
const BOT_USER_AGENT =
  /(bot\b|bot\/|bots?[-_ ]|crawler|crawl|spider|slurp|archiver|scrapy|fetcher|feedfetcher|facebookexternalhit|embedly|quora link preview|skypeuripreview|slackbot|slack-imgproxy|discord|whatsapp|telegram|twitterbot|linkedinbot|redditbot|pinterest\/|vkshare|preview|headless|phantomjs|electron\/|curl\/|wget|python-requests|python-urllib|aiohttp|go-http-client|okhttp|axios\/|node-fetch|undici|libwww|java\/|apache-httpclient|lighthouse|pagespeed|pingdom|uptime|monitoring|statuscake|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|anthropic-ai|ccbot|perplexity|applebot|yandexbot|baiduspider|duckduckbot|bingpreview)/i;

/**
 * True when the user agent is automation rather than a person.
 * A missing/empty user agent counts as automation: browsers always send one,
 * scripts frequently do not.
 */
export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").trim();
  if (ua.length === 0) return true;
  return BOT_USER_AGENT.test(ua);
}

/**
 * Decides whether one server-rendered view may persist a row.
 * Never throws; returns false when it cannot prove the view is countable.
 */
export async function shouldCountView(args: {
  event: ViewEvent;
  resource: string;
  ip: string | null | undefined;
  userAgent: string | null | undefined;
}): Promise<boolean> {
  if (isBotUserAgent(args.userAgent)) return false;
  // Spend no Redis command at all once this instance's telemetry budget is
  // gone; the shared limiter is what checkout depends on. See the constant.
  if (!withinLocalTelemetryBudget("view")) return false;
  const ip = args.ip?.trim() || "unknown";
  const resource = args.resource.slice(0, 253).toLowerCase();
  // Dedup first: a repeat view short-circuits before the per-IP budget, so the
  // common case costs a single limiter round-trip.
  const fresh = await rateLimit(`view:${args.event}:${resource}:${ip}`, 1, VIEW_DEDUP_WINDOW_MS);
  if (!fresh) return false;
  return rateLimit(`view:ip:${ip}`, VIEW_IP_LIMIT, VIEW_IP_WINDOW_MS);
}

/**
 * Drops prop keys that look like secrets/PII, coerces to scalars, caps each
 * value at 512 chars, and caps the number of persisted keys so one event can
 * never carry kilobytes of jsonb.
 */
export function sanitizeAnalyticsProps(props: Record<string, unknown>): {
  props: Record<string, unknown>;
  droppedKeys: number;
} {
  const safe: Record<string, unknown> = {};
  let droppedKeys = 0;
  for (const [k, v] of Object.entries(props)) {
    const lower = k.toLowerCase();
    // Never persist secrets/PII.
    if (
      lower.includes("secret") ||
      lower.includes("token") ||
      lower.includes("password") ||
      lower.includes("email")
    ) {
      continue;
    }
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean" && v !== null) {
      continue;
    }
    if (Object.keys(safe).length >= MAX_ANALYTICS_PROP_KEYS) {
      droppedKeys += 1;
      continue;
    }
    safe[k] = typeof v === "string" ? v.slice(0, 512) : v;
  }
  return { props: safe, droppedKeys };
}

// Mirrors repo.isProdDatastore without importing the datastore module into
// every render path: demo/preview deployments have no analytics sink, so the
// guard should not spend limiter calls (or grow in-memory limiter keys) there.
function datastoreConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Best-effort view-event write from a Server Component.
 * Applies the bot filter and the (IP, resource) dedup window, then persists.
 * Never throws — a skipped or failed write must still render the page.
 */
export async function persistViewEvent(args: {
  event: ViewEvent;
  resource: string;
  domain?: string | null;
  handle?: string | null;
  props?: Record<string, unknown>;
}): Promise<void> {
  try {
    if (!datastoreConfigured()) return;
    // Dynamic imports keep next/headers and the Supabase sink out of the
    // module graph of anything that merely imports the pure guards above.
    const { headers } = await import("next/headers");
    const h = await headers();
    const ip = clientIp(h);
    const countable = await shouldCountView({
      event: args.event,
      resource: args.resource,
      ip,
      userAgent: h.get("user-agent"),
    });
    if (!countable) return;

    const { persistAnalyticsEvent } = await import("./analytics-server.ts");
    await persistAnalyticsEvent({
      event: args.event,
      domain: args.domain ?? null,
      handle: args.handle ?? null,
      props: args.props ?? {},
      userId: null,
    });
  } catch {
    // swallow — analytics must never break a render
  }
}
