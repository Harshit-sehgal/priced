// Adapter-independent parts of the market repository: the contract constants
// both adapters must agree on, and the pure ranking/join logic the discovery
// reads perform once their rows are in hand. Anything in here would otherwise
// exist twice — and two copies of one rule drift (see types.ts).
import "server-only";
import type { RepoDomain } from "./types.ts";

export const QUOTE_TTL_MS = 5 * 60 * 1000; // §16: ~5 minutes, configurable

export const MAX_REFUND_ATTEMPTS = 3;
export const REFUND_CLAIM_LEASE_MS = 10 * 60 * 1000;

// Default page sizes, one definition each so the two adapters cannot answer
// the same call with different amounts of data.
export const DEFAULT_MARKET_LIMIT = 50;
export const DEFAULT_SALES_LIMIT = 50;
export const DEFAULT_CONTESTED_LIMIT = 6;
export const DEFAULT_RISING_LIMIT = 5;
export const DEFAULT_RISING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_NEWLY_CLAIMED_LIMIT = 5;
export const DEFAULT_RECENT_SALES_LIMIT = 20;

// Sampling caps for the two aggregate/display figures. These live here, not in
// an adapter, because they ARE the behaviour: the Supabase path capped its
// scans while the in-memory path scanned everything, so the two adapters
// silently disagreed once the market grew past the cap — and the whole test
// suite runs the uncapped one. A cap defined in one adapter is drift waiting
// to happen; shared, both paths answer identically.
//
// Both figures are deliberately approximate headline numbers (the homepage
// footnotes the market value "* according to this ridiculous website"). They
// are never used for pricing or any money decision.
export const MARKET_VALUE_SAMPLE_LIMIT = 1000;
export const CONTESTED_SALES_SAMPLE_LIMIT = 2000;

/** Id-shaped lookup guard: a malformed id is "not found", never a datastore error. */
export function isIdShaped(value: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(value);
}

export type ContestedCounts = Map<string, { count: number; latest: string }>;

/** Sale count + latest sale per domain, from raw ledger rows. */
export function tallyContestedSales(rows: Array<{ domain: string; createdAt: string }>): ContestedCounts {
  const counts: ContestedCounts = new Map();
  for (const r of rows) {
    const cur = counts.get(r.domain);
    if (!cur) counts.set(r.domain, { count: 1, latest: r.createdAt });
    else {
      cur.count += 1;
      if (r.createdAt > cur.latest) cur.latest = r.createdAt;
    }
  }
  return counts;
}

/** More than one sale, ranked by count DESC, latest sale DESC, domain ASC. */
export function rankContested(counts: ContestedCounts, limit: number): string[] {
  return [...counts.entries()]
    .filter(([, v]) => v.count > 1)
    .sort((a, b) => b[1].count - a[1].count || b[1].latest.localeCompare(a[1].latest) || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([domain]) => domain);
}

/**
 * Reserved domains must not surface in discovery (§7/§38) even if they have
 * history. Static blocklist is synchronous; the DB list is one batched read
 * the caller has already performed (empty for the in-memory adapter).
 */
export async function filterOutReserved(domains: string[], dbReserved: Set<string>): Promise<string[]> {
  const { evaluateDomain } = await import("../domains.ts");
  return domains.filter(
    (domain) => evaluateDomain(domain).reason !== "reserved" && !dbReserved.has(domain),
  );
}

/** Joins ranked contested domains onto live market rows; unheld domains drop out. */
export function joinContested(
  domains: string[],
  counts: ContestedCounts,
  rows: Map<string, RepoDomain>,
): Array<{ domain: string; sales: number; priceCents: number; holderHandle: string }> {
  return domains.flatMap((domain) => {
    const row = rows.get(domain);
    const count = counts.get(domain)?.count ?? 0;
    return row && row.holderUserId && row.holderHandle
      ? [{ domain, sales: count, priceCents: row.priceCents, holderHandle: row.holderHandle }]
      : [];
  });
}

/**
 * Aggregate per domain (best rise in window). First claims (previous price 0)
 * are excluded upstream: a "rise" means a challenger moved the price, not that
 * the tag opened at $5.
 */
export function bestRisePerDomain(candidates: Array<{ domain: string; roseCents: number }>): Map<string, number> {
  const best = new Map<string, number>();
  for (const c of candidates) {
    const cur = best.get(c.domain) ?? 0;
    if (c.roseCents > cur) best.set(c.domain, c.roseCents);
  }
  return best;
}

/** Rank by rise DESC. */
export function rankRising(best: Map<string, number>, limit: number): string[] {
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([domain]) => domain);
}

/** Joins ranked rising domains onto live market rows; unheld domains drop out. */
export function joinRising(
  domains: string[],
  best: Map<string, number>,
  rows: Map<string, RepoDomain>,
): Array<{ domain: string; roseCents: number; priceCents: number; holderHandle: string }> {
  return domains.flatMap((domain) => {
    const row = rows.get(domain);
    const rose = best.get(domain) ?? 0;
    return row && row.holderUserId && row.holderHandle && rose > 0
      ? [{ domain, roseCents: rose, priceCents: row.priceCents, holderHandle: row.holderHandle }]
      : [];
  });
}
