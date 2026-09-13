// Production adapter: Supabase/Postgres. Selected by src/lib/repo.ts whenever
// NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both configured.
// Quotes, takeovers and history are ALWAYS server-authoritative here; the
// atomic/versioned parts live in SQL (db/schema.sql finalize_takeover), not in
// this file.
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { normalizeDomain, quoteFor, type PriceQuote } from "../game.ts";
import { requireEligibleDomain } from "../domains.ts";
import { logEvent } from "../logger.ts";
import { isProdDatastore, supabaseServiceKey, supabaseUrl } from "./env.ts";
import {
  CONTESTED_SALES_SAMPLE_LIMIT,
  DEFAULT_CONTESTED_LIMIT,
  DEFAULT_MARKET_LIMIT,
  DEFAULT_NEWLY_CLAIMED_LIMIT,
  DEFAULT_RECENT_SALES_LIMIT,
  DEFAULT_RISING_LIMIT,
  DEFAULT_RISING_WINDOW_MS,
  DEFAULT_SALES_LIMIT,
  MARKET_VALUE_SAMPLE_LIMIT,
  MAX_REFUND_ATTEMPTS,
  QUOTE_TTL_MS,
  REFUND_CLAIM_LEASE_MS,
  bestRisePerDomain,
  dropReservedRows,
  filterOutReserved,
  isIdShaped,
  joinContested,
  joinRising,
  overFetch,
  rankContested,
  rankRising,
  tallyContestedSales,
} from "./shared.ts";
import type {
  FinalizeInput,
  RefundClaim,
  RepoDomain,
  RepoProfile,
  RepoQuote,
  RepoRefundStatus,
  RepoSale,
  TakeoverOutcome,
} from "./types.ts";

let sb: SupabaseClient | null = null;
function client(): SupabaseClient {
  if (!sb) {
    if (!isProdDatastore) throw new Error("DATASTORE_NOT_CONFIGURED");
    sb = createClient(supabaseUrl!, supabaseServiceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return sb;
}

// ----------------------------------------------------------------- row mapping
function toQuote(row: Record<string, unknown>): RepoQuote {
  return {
    id: String(row.id),
    domain: String(row.domain),
    buyerUserId: String(row.buyer_user_id),
    expectedVersion: Number(row.expected_version),
    currentPriceCents: Number(row.current_price_cents),
    requiredIncrementCents: Number(row.required_increment_cents),
    nextPriceCents: Number(row.next_price_cents),
    expiresAt: String(row.expires_at),
    status: String(row.status),
    createdAt: String(row.created_at),
    checkoutProvider: row.checkout_provider == null ? null : String(row.checkout_provider),
    checkoutPaymentId: row.checkout_payment_id == null ? null : String(row.checkout_payment_id),
    checkoutUrl: row.checkout_url == null ? null : String(row.checkout_url),
  };
}

function toDomain(row: Record<string, unknown>): RepoDomain {
  return {
    domain: String(row.domain),
    holderUserId: row.holder_user_id == null ? null : String(row.holder_user_id),
    holderHandle: row.holder_handle == null ? null : String(row.holder_handle),
    priceCents: Number(row.price_cents),
    version: Number(row.version),
    claimedAt: row.claimed_at == null ? null : String(row.claimed_at),
    updatedAt: row.updated_at == null ? null : String(row.updated_at),
  };
}

function toSale(row: Record<string, unknown>): RepoSale {
  return {
    id: String(row.id),
    domain: String(row.domain),
    buyerUserId: String(row.buyer_user_id),
    buyerHandle: String(row.buyer_handle),
    previousHolderHandle: row.previous_holder_handle == null ? null : String(row.previous_holder_handle),
    previousPriceCents: Number(row.previous_price_cents),
    priceCents: Number(row.price_cents),
    domainVersion: Number(row.domain_version),
    providerPaymentId: String(row.provider_payment_id),
    createdAt: String(row.created_at),
  };
}

function toProfile(data: Record<string, string | null>): RepoProfile {
  return { id: data.id!, handle: data.handle!, displayName: data.display_name, avatarUrl: data.avatar_url, bio: data.bio ?? null, ctaLabel: data.cta_label ?? null, ctaUrl: data.cta_url ?? null, suspendedAt: data.suspended_at };
}

// ------------------------------------------------------------------- reads
export async function getDomain(domain: string): Promise<RepoDomain | null> {
  const d = requireEligibleDomain(domain);
  const { data, error } = await client().from("domains").select("*").eq("domain", d).maybeSingle();
  if (error) throw error;
  return data ? toDomain(data) : null;
}

export async function getDomainForDisplay(domain: string): Promise<RepoDomain | null> {
  const d = normalizeDomain(domain);
  if (!d) return null;
  const { data, error } = await client().from("domains").select("*").eq("domain", d).maybeSingle();
  if (error) throw error;
  return data ? toDomain(data) : null;
}

export async function listMarket(limit = DEFAULT_MARKET_LIMIT): Promise<RepoDomain[]> {
  const { data, error } = await client()
    .from("domains")
    .select("*")
    .not("holder_user_id", "is", null)
    .order("price_cents", { ascending: false })
    .order("claimed_at", { ascending: true })
    .limit(overFetch(limit));
  if (error) throw error;
  return dropReservedRows((data ?? []).map(toDomain), (d) => d.domain, await reservedDisplaySet(), limit);
}

/** Sales where the given handle is the buyer, newest first. */
export async function listSalesForBuyer(buyerHandle: string, limit = DEFAULT_SALES_LIMIT): Promise<RepoSale[]> {
  const h = buyerHandle.toLowerCase().replace(/^@/, "");
  const { data, error } = await client()
    .from("sales")
    .select("*")
    .eq("buyer_handle", h)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(toSale);
}

/**
 * Most-contested domains (§39 discovery): more than one sale, ranked by sale
 * count DESC, latest sale DESC, domain ASC — deterministic for all visitors.
 * Returns live market state so the UI can show current holder/price.
 */
export async function listMostContested(limit = DEFAULT_CONTESTED_LIMIT): Promise<Array<{ domain: string; sales: number; priceCents: number; holderHandle: string }>> {
  const { data, error } = await client()
    .from("sales")
    .select("domain, created_at")
    .order("created_at", { ascending: false })
    .limit(CONTESTED_SALES_SAMPLE_LIMIT);
  if (error) throw error;
  const counts = tallyContestedSales((data ?? []).map((row) => ({ domain: String(row.domain), createdAt: String(row.created_at) })));

  const domains = rankContested(counts, limit);
  if (domains.length === 0) return [];

  const dbReserved = await listReservedInDb(domains);
  const live = await filterOutReserved(domains, dbReserved);

  // Batched fetch of live market state — one query instead of one per domain.
  const rows = await listDomainsByNames(live);
  return joinContested(live, counts, rows);
}

/**
 * The whole blocklist, cached briefly, for DISPLAY filtering only.
 *
 * The homepage alone calls five discovery functions; giving each its own
 * reserved lookup would add five queries per render to a free-tier database.
 * reserved_domains is a small operator-managed blocklist, so fetching it once
 * and reusing it for a few seconds is far cheaper and just as correct for
 * listings.
 *
 * The money gate is deliberately NOT cached: assertNotReserved() re-reads the
 * table on every quote, so a newly reserved domain becomes unquotable
 * immediately. The worst this cache can do is leave a tag visible in a list
 * for a few more seconds — it can never let one be bought.
 */
const RESERVED_CACHE_MS = 30_000;
let reservedCache: { at: number; set: Set<string> } | null = null;

async function reservedDisplaySet(): Promise<Set<string>> {
  const now = Date.now();
  if (reservedCache && now - reservedCache.at < RESERVED_CACHE_MS) return reservedCache.set;
  try {
    const { data, error } = await client().from("reserved_domains").select("domain");
    if (error) {
      // Display-only: keep the market rendering. See assertNotReserved for the
      // path that must fail closed.
      logEvent("reserved_lookup_failed", "warn", { scope: "display", detail: error.message });
      return reservedCache?.set ?? new Set<string>();
    }
    const set = new Set((data ?? []).map((row) => String(row.domain)));
    reservedCache = { at: now, set };
    return set;
  } catch (e) {
    logEvent("reserved_lookup_failed", "warn", { scope: "display", detail: e instanceof Error ? e.message : String(e) });
    return reservedCache?.set ?? new Set<string>();
  }
}

/** Batched reserved-domain lookup (one query for a domain set). */
async function listReservedInDb(domains: string[]): Promise<Set<string>> {
  if (domains.length === 0) return new Set();
  try {
    const { data, error } = await client().from("reserved_domains").select("domain").in("domain", domains);
    if (error) {
      // Display-only filter: an empty set shows everything rather than hiding
      // the whole market. Quoting does not rely on this — see assertNotReserved.
      logEvent("reserved_lookup_failed", "warn", { count: domains.length, detail: error.message });
      return new Set();
    }
    return new Set((data ?? []).map((row) => String(row.domain)));
  } catch (e) {
    logEvent("reserved_lookup_failed", "warn", { count: domains.length, detail: e instanceof Error ? e.message : String(e) });
    return new Set();
  }
}

/** One batched read for live domain rows (replaces per-domain getDomain N+1). */
async function listDomainsByNames(domains: string[]): Promise<Map<string, RepoDomain>> {
  if (domains.length === 0) return new Map();
  const { data, error } = await client().from("domains").select("*").in("domain", domains);
  if (error) throw error;
  const out = new Map<string, RepoDomain>();
  for (const row of data ?? []) {
    const d = toDomain(row);
    out.set(d.domain, d);
  }
  return out;
}

/**
 * Fastest Rising (§12): biggest absolute price increase from a sale within
 * the window, computed from the immutable ledger (real data only). Ranks by
 * (price - previous_price) among recent sales, then joins live market state.
 */
export async function listFastestRising(limit = DEFAULT_RISING_LIMIT, windowMs = DEFAULT_RISING_WINDOW_MS): Promise<Array<{ domain: string; roseCents: number; priceCents: number; holderHandle: string }>> {
  const since = new Date(Date.now() - windowMs).toISOString();
  // First claims (previous price 0) are excluded: a "rise" means a challenger
  // moved the price, not that the tag opened at $5.
  const { data, error } = await client()
    .from("sales")
    .select("domain, price_cents, previous_price_cents, created_at")
    .gte("created_at", since)
    .gt("previous_price_cents", 0)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw error;
  const candidates = (data ?? [])
    .map((row) => ({
      domain: String(row.domain),
      roseCents: Number(row.price_cents) - Number(row.previous_price_cents),
    }))
    .filter((s) => s.roseCents > 0);

  const best = bestRisePerDomain(candidates);
  // Rank wide, drop reserved, then trim — otherwise removing a blocklisted tag
  // would silently shorten the list.
  const ranked = rankRising(best, overFetch(limit));
  const top = (await filterOutReserved(ranked, await reservedDisplaySet())).slice(0, limit);
  if (top.length === 0) return [];

  const rows = await listDomainsByNames(top);
  return joinRising(top, best, rows);
}

/**
 * Newly Claimed (§12): first claims (previous_price = 0), newest first.
 * Honest by construction: the ledger only records real first claims.
 */
export async function listNewlyClaimed(limit = DEFAULT_NEWLY_CLAIMED_LIMIT): Promise<Array<{ domain: string; priceCents: number; holderHandle: string; createdAt: string }>> {
  const { data, error } = await client()
    .from("sales")
    .select("domain, price_cents, buyer_handle, created_at")
    .eq("previous_price_cents", 0)
    .order("created_at", { ascending: false })
    .limit(overFetch(limit));
  if (error) throw error;
  const claimed = (data ?? []).map((row) => ({
    domain: String(row.domain),
    priceCents: Number(row.price_cents),
    holderHandle: String(row.buyer_handle),
    createdAt: String(row.created_at),
  }));
  return dropReservedRows(claimed, (r) => r.domain, await reservedDisplaySet(), limit);
}

export async function listRecentSales(limit = DEFAULT_RECENT_SALES_LIMIT): Promise<RepoSale[]> {
  const { data, error } = await client()
    .from("sales")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(overFetch(limit));
  if (error) throw error;
  return dropReservedRows((data ?? []).map(toSale), (s) => s.domain, await reservedDisplaySet(), limit);
}

export async function listSalesForDomain(domain: string, limit = DEFAULT_SALES_LIMIT): Promise<RepoSale[]> {
  // Display-only, so a domain reserved AFTER it had sales must still render its
  // ledger (the domain page and receipts present it as immutable history).
  // normalizeDomain, not requireEligibleDomain, which throws for reserved tags.
  const d = normalizeDomain(domain);
  if (!d) return [];
  const { data, error } = await client()
    .from("sales")
    .select("*")
    .eq("domain", d)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(toSale);
}

/** Every live tag held by one handle, price DESC. */
export async function listDomainsForHolder(handle: string): Promise<RepoDomain[]> {
  const h = handle.toLowerCase().replace(/^@/, "");
  const { data, error } = await client()
    .from("domains")
    .select("*")
    .eq("holder_handle", h)
    .order("price_cents", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(toDomain);
}

export async function getSale(saleId: string): Promise<RepoSale | null> {
  if (!isIdShaped(saleId)) return null;
  const { data, error } = await client().from("sales").select("*").eq("id", saleId).maybeSingle();
  if (error) throw error;
  return data ? toSale(data) : null;
}

export async function getSaleByProviderPaymentId(providerPaymentId: string): Promise<RepoSale | null> {
  if (!providerPaymentId) return null;
  const { data, error } = await client()
    .from("sales")
    .select("*")
    .eq("provider_payment_id", providerPaymentId)
    .maybeSingle();
  if (error) throw error;
  return data ? toSale(data) : null;
}

/**
 * Which of these handles are suspended, in chunked queries.
 *
 * Lenient by design, like reservedDisplaySet: this feeds the sitemap, and a
 * transient profiles/permission error must not turn /sitemap.xml into a 500
 * for every crawler. On error it returns what it has (possibly nothing) and
 * logs; the money and moderation gates never use this.
 */
export async function listSuspendedHandles(handles: string[]): Promise<Set<string>> {
  const unique = [...new Set(handles.map((h) => h.toLowerCase().replace(/^@/, "")).filter(Boolean))];
  const suspended = new Set<string>();
  if (unique.length === 0) return suspended;
  const CHUNK = 200; // keep the PostgREST query string bounded
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    try {
      const { data, error } = await client()
        .from("profiles")
        .select("handle")
        .in("handle", chunk)
        .not("suspended_at", "is", null);
      if (error) {
        logEvent("suspended_lookup_failed", "warn", { count: chunk.length, detail: error.message });
        continue;
      }
      for (const row of data ?? []) suspended.add(String(row.handle));
    } catch (e) {
      logEvent("suspended_lookup_failed", "warn", {
        count: chunk.length,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return suspended;
}

export async function getProfileByHandle(handle: string): Promise<RepoProfile | null> {
  const h = handle.toLowerCase().replace(/^@/, "");
  const { data, error } = await client().from("profiles").select("*").eq("handle", h).maybeSingle();
  if (error) throw error;
  return data ? toProfile(data) : null;
}

export async function getProfileById(id: string): Promise<RepoProfile | null> {
  const { data, error } = await client().from("profiles").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toProfile(data) : null;
}

export async function marketValueCents(): Promise<number> {
  const rows = await listMarket(MARKET_VALUE_SAMPLE_LIMIT);
  return rows.reduce((sum, d) => sum + (d.holderUserId ? d.priceCents : 0), 0);
}

// ------------------------------------------------------------------- quotes
export async function createQuote(domainInput: string, buyerUserId: string): Promise<RepoQuote> {
  const domain = requireEligibleDomain(domainInput);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + QUOTE_TTL_MS).toISOString();

  const profile = await getProfileById(buyerUserId);
  if (!profile) throw new Error("PROFILE_REQUIRED");
  if (profile.suspendedAt) throw new Error("ACCOUNT_SUSPENDED");

  await assertNotReserved(domain);

  // Fresh read + holder check at quote time; version is pinned for staleness.
  const { data: row, error } = await client().from("domains").select("*").eq("domain", domain).maybeSingle();
  if (error) throw error;
  const current: RepoDomain = row
    ? toDomain(row)
    : { domain, holderUserId: null, holderHandle: null, priceCents: 0, version: 0, claimedAt: null, updatedAt: null };
  if (current.holderUserId && current.holderUserId === buyerUserId) throw new Error("ALREADY_HOLDER");
  const quote: PriceQuote = quoteFor({
    domain,
    holder: current.holderHandle,
    priceCents: current.priceCents,
    version: current.version,
    history: [],
  });
  const { data: inserted, error: insErr } = await client()
    .from("quotes")
    .insert({
      domain,
      buyer_user_id: buyerUserId,
      expected_version: current.version,
      current_price_cents: current.priceCents,
      required_increment_cents: quote.requiredIncrementCents,
      next_price_cents: quote.nextPriceCents,
      expires_at: expiresAt,
      status: "active",
    })
    .select("*")
    .single();
  if (insErr) throw insErr;
  return toQuote(inserted);
}

export async function getQuote(quoteId: string): Promise<RepoQuote | null> {
  if (!isIdShaped(quoteId)) return null;
  const { data, error } = await client().from("quotes").select("*").eq("id", quoteId).maybeSingle();
  if (error) throw error;
  return data ? toQuote(data) : null;
}

export async function markQuoteStatus(quoteId: string, status: RepoQuote["status"]): Promise<void> {
  // `consumed` is terminal. A concurrent losing challenger must not downgrade
  // a committed quote back to stale/expired: the winner's duplicate delivery
  // would then read a terminal quote, and (before the payment-id idempotency
  // lookup existed) refund a sale that was already funded. The `status <>
  // consumed` predicate is evaluated by Postgres against the latest committed
  // row version, so it also closes the read-then-write race.
  let query = client().from("quotes").update({ status }).eq("id", quoteId);
  if (status !== "consumed") query = query.neq("status", "consumed");
  const { error } = await query;
  if (error) throw error;
}

/**
 * Persist the provider session for a quote so retries reuse one checkout.
 * First writer wins: a concurrent second checkout for the same quote reuses
 * the stored session instead of creating a second payment session.
 * Returns the authoritative (existing-or-newly-stored) checkout triple.
 */
export async function setQuoteCheckout(args: {
  quoteId: string;
  provider: string;
  paymentId: string;
  checkoutUrl: string | null;
}): Promise<{ paymentId: string; checkoutUrl: string | null; reused: boolean }> {
  // Claim the row only if no checkout was stored yet (atomic first-writer-wins),
  // and only out of a non-terminal status: a quote that flipped to
  // expired/stale/cancelled between the route's read and this claim must not
  // be resurrected back to checkout_created (that would destroy the expiry
  // audit state). Such a claim matches zero rows and falls to the lost-race
  // read below, which reuses the winner or falls back safely.
  const { data: claimed, error: claimErr } = await client()
    .from("quotes")
    .update({
      checkout_provider: args.provider,
      checkout_payment_id: args.paymentId,
      checkout_url: args.checkoutUrl,
      status: "checkout_created",
    })
    .is("checkout_payment_id", null)
    .in("status", ["active", "checkout_created"])
    .eq("id", args.quoteId)
    .select("checkout_payment_id, checkout_url");
  if (claimErr) throw claimErr;
  const row = (claimed ?? [])[0] as { checkout_payment_id: string; checkout_url: string | null } | undefined;
  if (row?.checkout_payment_id) {
    const reused = row.checkout_payment_id !== args.paymentId;
    return { paymentId: row.checkout_payment_id, checkoutUrl: row.checkout_url, reused };
  }
  // Lost the race: read the winner.
  const current = await getQuote(args.quoteId);
  if (current?.checkoutPaymentId) {
    return { paymentId: current.checkoutPaymentId, checkoutUrl: current.checkoutUrl, reused: true };
  }
  // No winner and the claim matched zero rows. That means the quote is either
  // gone or terminal (expired/stale/cancelled) — the status-guarded claim
  // above refused it. Do NOT resurrect it to checkout_created here: flipping a
  // terminal quote back would destroy the expiry audit state AND hand the
  // caller a provider session for a quote the checkout route already
  // rejected. Throw so the route surfaces quote_<status> instead of a URL.
  const gone = await getQuote(args.quoteId);
  if (!gone) throw new Error("UNKNOWN_QUOTE");
  throw new Error(`QUOTE_NOT_CHECKOUTABLE: ${gone.status}`);
}

// --------------------------------------------------------------- finalization

/**
 * Map a finalize_takeover RPC error to the outcome vocabulary. Exported so the
 * mapping itself is unit-testable without a live Postgres.
 *
 * The 23505 branch matters: `sales.provider_payment_id` is UNIQUE, and a
 * racing transaction that committed after finalize's post-lock idempotency
 * recheck makes the final INSERT raise a duplicate-key violation. Mapping that
 * to FINALIZE_ERROR would make src/lib/takeover.ts refund — the buyer would
 * keep the tag AND get the money back. It is the same condition
 * IDEMPOTENCY_CONFLICT exists for (the payment already funded a sale), so it is
 * an alert, never a refund.
 */
export function mapFinalizeRpcError(error: { message: string; code?: string | null }): TakeoverOutcome {
  const code = error.message.split(" ")[0]?.replace(/["']/g, "");
  if (code === "STALE_QUOTE") return { ok: false, code: "STALE_QUOTE" };
  if (code === "ALREADY_HOLDER") return { ok: false, code: "ALREADY_HOLDER" };
  if (code === "WRONG_PRICE") return { ok: false, code: "WRONG_PRICE" };
  if (code === "IDEMPOTENCY_CONFLICT") return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
  if (code === "PAYMENT_REFUNDING") return { ok: false, code: "PAYMENT_ALREADY_REFUNDED" };
  if (code === "RESERVED_DOMAIN") return { ok: false, code: "FINALIZE_ERROR" };
  // Only the sales.provider_payment_id constraint proves the payment already
  // funded a sale. A blanket 23505 would misclassify a future unique
  // constraint as this alert-only condition and silently skip a refund.
  if (/duplicate key value violates unique constraint .*provider_payment_id/i.test(error.message)) {
    return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
  }
  return { ok: false, code: "FINALIZE_ERROR" };
}

export async function finalizeTakeover(input: FinalizeInput): Promise<TakeoverOutcome> {
  const { data, error } = await client().rpc("finalize_takeover", {
    p_domain: input.domain,
    p_buyer_user_id: input.buyerUserId,
    p_buyer_handle: input.buyerHandle,
    p_expected_version: input.expectedVersion,
    p_paid_cents: input.paidCents,
    p_provider_payment_id: input.providerPaymentId,
  });
  if (error) return mapFinalizeRpcError(error);
  return { ok: true, sale: toSale(data) };
}

// ------------------------------------------------------------------ profiles
export async function upsertProfile(id: string, handle: string, displayName: string | null, avatarUrl: string | null): Promise<RepoProfile> {
  const h = handle.toLowerCase();
  const { data, error } = await client()
    .from("profiles")
    .upsert({ id, handle: h, display_name: displayName, avatar_url: avatarUrl }, { onConflict: "id" })
    .select("*")
    .single();
  if (error) throw error;
  return toProfile(data);
}

/**
 * Holder-authored profile extras (bio + CTA). Validated upstream in
 * /api/profile; this layer only persists. Handle is immutable and is NOT
 * writable here.
 */
export async function updateProfileExtras(args: {
  id: string;
  bio: string | null;
  ctaLabel: string | null;
  ctaUrl: string | null;
}): Promise<RepoProfile | null> {
  const { data, error } = await client()
    .from("profiles")
    .update({ bio: args.bio, cta_label: args.ctaLabel, cta_url: args.ctaUrl })
    .eq("id", args.id)
    .select("*")
    // maybeSingle, not single: a user with no profile row (handle not yet
    // claimed) must resolve to "profile_missing" (404), and `.single()` turns
    // zero rows into a thrown PGRST116 that surfaced as a 500.
    .maybeSingle();
  if (error) throw error;
  return data ? toProfile(data) : null;
}

// ------------------------------------------------------------- payment events
export async function recordPaymentEvent(ev: {
  provider: string;
  providerEventId: string;
  providerPaymentId: string;
  eventType: string;
  payloadHash?: string;
  status: "received" | "processed" | "ignored" | "error";
  error?: string;
}): Promise<void> {
  // Insert-only: duplicate (provider, provider_event_id) surfaces as a
  // unique-violation so the webhook layer can treat it as idempotent
  // delivery. Upsert would silently swallow the duplicate and break that
  // signal.
  const { error } = await client().from("payment_events").insert({
    provider: ev.provider,
    provider_event_id: ev.providerEventId,
    provider_payment_id: ev.providerPaymentId,
    event_type: ev.eventType,
    payload_hash: ev.payloadHash ?? null,
    status: ev.status,
    error: ev.error ?? null,
    processed_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export async function getPaymentEvent(provider: string, providerEventId: string): Promise<{
  provider: string;
  providerEventId: string;
  providerPaymentId: string;
  eventType: string;
  status: string;
  processedAt: string | null;
} | null> {
  const { data, error } = await client()
    .from("payment_events")
    .select("provider, provider_event_id, provider_payment_id, event_type, status, processed_at")
    .eq("provider", provider)
    .eq("provider_event_id", providerEventId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    provider: String(data.provider),
    providerEventId: String(data.provider_event_id),
    providerPaymentId: String(data.provider_payment_id),
    eventType: String(data.event_type),
    status: String(data.status),
    processedAt: data.processed_at == null ? null : String(data.processed_at),
  };
}

export async function markPaymentEventStatus(provider: string, providerEventId: string, status: "processed" | "ignored" | "error", error?: string): Promise<void> {
  const { error: err } = await client()
    .from("payment_events")
    .update({ status, error: error ?? null, processed_at: new Date().toISOString() })
    .eq("provider", provider)
    .eq("provider_event_id", providerEventId);
  if (err) throw err;
}

// --------------------------------------------------------------- refund ledger
export async function claimRefundAttempt(args: {
  provider: string;
  paymentId: string;
  eventId: string;
  reason: string;
  amountCents: number | null;
}): Promise<RefundClaim> {
  const { data, error } = await client().rpc("claim_refund_attempt", {
    p_provider: args.provider,
    p_provider_payment_id: args.paymentId,
    p_provider_event_id: args.eventId,
    p_reason: args.reason,
    p_amount_cents: args.amountCents,
    p_max_attempts: MAX_REFUND_ATTEMPTS,
    p_lease_seconds: REFUND_CLAIM_LEASE_MS / 1000,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!row) throw new Error("REFUND_CLAIM_EMPTY");
  return {
    claimed: Boolean(row.claimed),
    // The SQL may return `already_finalized` (a sale exists for this payment);
    // the union keeps that distinct from the ledger states.
    status: String(row.status) as RefundClaim["status"],
    attempts: Number(row.attempts),
    claimToken: row.claim_token == null ? null : String(row.claim_token),
    lastError: row.last_error == null ? null : String(row.last_error),
  };
}

export async function completeRefundAttempt(args: {
  provider: string;
  paymentId: string;
  claimToken: string;
  status: Extract<RepoRefundStatus, "failed" | "succeeded" | "manual_review">;
  error?: string;
}): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await client()
    .from("refunds")
    .update({
      status: args.status,
      claim_token: null,
      lease_expires_at: null,
      last_error: args.error ?? null,
      updated_at: now,
      completed_at: args.status === "succeeded" || args.status === "manual_review" ? now : null,
    })
    .eq("provider", args.provider)
    .eq("provider_payment_id", args.paymentId)
    .eq("claim_token", args.claimToken)
    .select("status")
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

/**
 * Reconcile a provider-emitted refund status. A refund may be accepted as
 * pending/review by the provider and settle later, so this path is allowed to
 * complete a manual-review row without a live claim token. A later failure
 * event must never downgrade a refund already confirmed as succeeded.
 *
 * Delegated to the `reconcile_refund_event` RPC, which takes the SAME
 * per-payment advisory lock as finalize_takeover and claim_refund_attempt.
 * Without that lock a dashboard refund event could insert a refund row
 * concurrently with a takeover finalization for the same payment, producing
 * the tag-and-money-back outcome this migration exists to prevent. The SQL
 * also carries the never-downgrade rule under FOR UPDATE.
 */
export async function reconcileRefundProviderEvent(args: {
  provider: string;
  paymentId: string;
  eventId: string;
  status: Extract<RepoRefundStatus, "succeeded" | "manual_review">;
  amountCents?: number | null;
  error?: string;
}): Promise<{ saleExists: boolean }> {
  const { data, error } = await client().rpc("reconcile_refund_event", {
    p_provider: args.provider,
    p_provider_payment_id: args.paymentId,
    p_provider_event_id: args.eventId,
    p_status: args.status,
    p_amount_cents: args.amountCents ?? null,
    p_error: args.error ?? null,
  });
  if (error) throw error;
  // The RPC returns one row: { status, sale_exists }. The verdict is computed
  // under the same advisory lock as the write, so it cannot miss a concurrent
  // finalization the way a pre-call sale lookup did.
  const row = (Array.isArray(data) ? data[0] : data) as { sale_exists?: unknown } | undefined;
  return { saleExists: row?.sale_exists === true };
}

/**
 * Money-path gate for the reserved/blocklist check. Fails CLOSED.
 *
 * `isReservedInDb` below is deliberately lenient because it feeds page and
 * sitemap rendering, where a failed lookup should not blank the site. Quoting
 * is different: the blocklist exists to stop impersonation of phishing-
 * sensitive brands, so "we could not tell" must never resolve to "allowed".
 *
 * Two things were wrong with using the lenient path here. supabase-js does not
 * throw on a query error — it returns `{ data: null, error }` — so a missing
 * table or a permission failure produced `false` without ever reaching the
 * catch, and the comment promising a log described something that did not
 * happen. A transient error therefore quoted a reserved domain silently.
 *
 * Failing closed costs nothing in practice: createQuote needs the database for
 * the very next statement anyway, so if this lookup cannot run the quote was
 * never going to succeed. The distinct error keeps the response honest — the
 * caller reports a server error rather than telling the user their domain is
 * reserved when we simply could not check.
 *
 * Note the money path has a second, independent guard: SQL finalize_takeover
 * re-checks reserved_domains inside the transaction. This makes the quote
 * refuse up front instead of taking a payment that can only end in a refund.
 */
async function assertNotReserved(domain: string): Promise<void> {
  const { data, error } = await client()
    .from("reserved_domains")
    .select("domain")
    .eq("domain", domain)
    .maybeSingle();
  if (error) {
    logEvent("reserved_lookup_failed", "error", { domain, detail: error.message });
    throw new Error("RESERVED_LOOKUP_UNAVAILABLE");
  }
  if (data) throw new Error("DOMAIN_INELIGIBLE: reserved");
}

export async function isReservedInDb(domain: string): Promise<boolean> {
  try {
    const { data, error } = await client().from("reserved_domains").select("domain").eq("domain", domain).maybeSingle();
    if (error) {
      // Display-only path: keep the page rendering, but say so. The money-path
      // gate is assertNotReserved(), which fails closed instead.
      logEvent("reserved_lookup_failed", "warn", { domain, detail: error.message });
      return false;
    }
    return !!data;
  } catch (e) {
    logEvent("reserved_lookup_failed", "warn", { domain, detail: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

export async function isDomainReserved(domain: string): Promise<boolean> {
  // Static blocklist (always) + operator-managed DB blocklist (prod).
  const { evaluateDomain } = await import("../domains.ts");
  if (evaluateDomain(domain).reason === "reserved") return true;
  return isReservedInDb(domain);
}

/**
 * The whole operator blocklist, briefly cached (same 30s display cache the
 * discovery surfaces already use). Callers that need to filter a large batch
 * of domains — the sitemap was doing up to 500 individual queries per crawler
 * hit — should use this instead of isReservedInDb per domain.
 */
export async function listReservedDomains(): Promise<Set<string>> {
  return reservedDisplaySet();
}

// ------------------------------------------------------- demo seeding (non-prod)
export function seedDemoMarket(): void {
  // Deliberately a no-op: production never fabricates purchases (§41). Only
  // the in-memory adapter seeds a demo market.
}
