// In-memory adapter: deterministic local store used for local dev, preview and
// most tests. Selected by src/lib/repo.ts whenever Supabase is not configured.
//
// This adapter exists to mirror the production rules, not to be convenient: a
// rule enforced here but not in SQL (or the reverse) means the suite green-lights
// behaviour production never applies. Where a branch below mirrors a database
// constraint or the SQL finalizer, the comment says so — keep them in step.
import "server-only";
import { normalizeDomain, quoteFor } from "../game.ts";
import { requireEligibleDomain } from "../domains.ts";
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

// ---------------------------------------------------------------- memory store
type MemState = {
  domains: Map<string, RepoDomain>;
  sales: RepoSale[];
  quotes: Map<string, RepoQuote>;
  // Keyed by profile id, mirroring the SQL primary key. Keying by handle would
  // let a second user's upsert overwrite the row that holds the handle, which
  // the unique index on profiles.handle rejects in production.
  profiles: Map<string, RepoProfile>;
  paymentEvents: Map<string, { id: string; provider: string; providerEventId: string; providerPaymentId: string; eventType: string; status: string; createdAt: string }>;
  refunds: Map<string, MemRefund>;
};

type MemRefund = {
  provider: string;
  providerPaymentId: string;
  providerEventId: string;
  reason: string;
  amountCents: number | null;
  status: RepoRefundStatus;
  attempts: number;
  claimToken: string | null;
  leaseExpiresAt: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

// Held on globalThis so the store survives module reloads (Next dev/HMR) and is
// shared by every importer in the process; a module-level `let` would hand each
// reload its own empty market.
const g = globalThis as unknown as { __iptMem?: MemState };
function mem(): MemState {
  if (!g.__iptMem) {
    g.__iptMem = { domains: new Map(), sales: [], quotes: new Map(), profiles: new Map(), paymentEvents: new Map(), refunds: new Map() };
  }
  return g.__iptMem;
}

export function resetMemoryMarket(): void {
  if (g.__iptMem) g.__iptMem = undefined as unknown as MemState;
}

// ------------------------------------------------------------------- reads
export async function getDomain(domain: string): Promise<RepoDomain | null> {
  const d = requireEligibleDomain(domain);
  return mem().domains.get(d) ?? null;
}

export async function getDomainForDisplay(domain: string): Promise<RepoDomain | null> {
  const d = normalizeDomain(domain);
  if (!d) return null;
  return mem().domains.get(d) ?? null;
}

export async function listMarket(limit = DEFAULT_MARKET_LIMIT): Promise<RepoDomain[]> {
  // Mirrors the Supabase path: reserved tags are dropped from listings too.
  // There is no operator blocklist without a database, so only the static one
  // applies here — dropReservedRows checks both.
  const ranked = [...mem().domains.values()]
    .filter((d) => d.holderUserId)
    .sort((a, b) => b.priceCents - a.priceCents || a.claimedAt!.localeCompare(b.claimedAt!))
    .slice(0, overFetch(limit));
  return dropReservedRows(ranked, (d) => d.domain, new Set<string>(), limit);
}

/** Sales where the given handle is the buyer, newest first. */
export async function listSalesForBuyer(buyerHandle: string, limit = DEFAULT_SALES_LIMIT): Promise<RepoSale[]> {
  const h = buyerHandle.toLowerCase().replace(/^@/, "");
  return mem()
    .sales.filter((s) => s.buyerHandle === h)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

/**
 * Most-contested domains (§39 discovery): more than one sale, ranked by sale
 * count DESC, latest sale DESC, domain ASC — deterministic for all visitors.
 * Returns live market state so the UI can show current holder/price.
 */
export async function listMostContested(limit = DEFAULT_CONTESTED_LIMIT): Promise<Array<{ domain: string; sales: number; priceCents: number; holderHandle: string }>> {
  // Mirror the Supabase path: tally the newest N sales, not every sale ever.
  const recent = [...mem().sales]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, CONTESTED_SALES_SAMPLE_LIMIT);
  const counts = tallyContestedSales(recent);

  const domains = rankContested(counts, limit);
  if (domains.length === 0) return [];

  // No operator-managed blocklist without a database; the static blocklist
  // still applies inside filterOutReserved.
  const live = await filterOutReserved(domains, new Set<string>());

  // Batched fetch of live market state — one lookup instead of one per domain.
  const rows = listDomainsByNames(live);
  return joinContested(live, counts, rows);
}

/** One batched read for live domain rows (replaces per-domain getDomain N+1). */
function listDomainsByNames(domains: string[]): Map<string, RepoDomain> {
  if (domains.length === 0) return new Map();
  const m = mem();
  return new Map(domains.map((d) => [d, m.domains.get(d) ?? null]).filter(([, v]) => v !== null) as Array<[string, RepoDomain]>);
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
  const candidates = mem()
    .sales.filter((s) => s.createdAt >= since && s.previousPriceCents > 0)
    .map((s) => ({ domain: s.domain, roseCents: s.priceCents - s.previousPriceCents }))
    .filter((s) => s.roseCents > 0);

  const best = bestRisePerDomain(candidates);
  // Mirrors the Supabase path: rank wide, drop reserved, then trim. No
  // operator blocklist without a database, so only the static one applies.
  const ranked = rankRising(best, overFetch(limit));
  const top = (await filterOutReserved(ranked, new Set<string>())).slice(0, limit);
  if (top.length === 0) return [];

  const rows = listDomainsByNames(top);
  return joinRising(top, best, rows);
}

/**
 * Newly Claimed (§12): first claims (previous_price = 0), newest first.
 * Honest by construction: the ledger only records real first claims.
 */
export async function listNewlyClaimed(limit = DEFAULT_NEWLY_CLAIMED_LIMIT): Promise<Array<{ domain: string; priceCents: number; holderHandle: string; createdAt: string }>> {
  const rows = mem()
    .sales.filter((s) => s.previousPriceCents === 0)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, overFetch(limit))
    .map((s) => ({ domain: s.domain, priceCents: s.priceCents, holderHandle: s.buyerHandle, createdAt: s.createdAt }));
  return dropReservedRows(rows, (r) => r.domain, new Set<string>(), limit);
}

export async function listRecentSales(limit = DEFAULT_RECENT_SALES_LIMIT): Promise<RepoSale[]> {
  const recent = [...mem().sales]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, overFetch(limit));
  return dropReservedRows(recent, (s) => s.domain, new Set<string>(), limit);
}

export async function listSalesForDomain(domain: string, limit = DEFAULT_SALES_LIMIT): Promise<RepoSale[]> {
  // Display-only; mirrors the Supabase adapter by tolerating reserved domains
  // so immutable history still renders after a blocklist expansion.
  const d = normalizeDomain(domain);
  if (!d) return [];
  return mem()
    .sales.filter((s) => s.domain === d)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

/** Every live tag held by one handle, price DESC. */
export async function listDomainsForHolder(handle: string): Promise<RepoDomain[]> {
  const h = handle.toLowerCase().replace(/^@/, "");
  return [...mem().domains.values()]
    .filter((d) => d.holderUserId && d.holderHandle === h)
    .sort((a, b) => b.priceCents - a.priceCents);
}

export async function getSale(saleId: string): Promise<RepoSale | null> {
  if (!isIdShaped(saleId)) return null;
  return mem().sales.find((s) => s.id === saleId) ?? null;
}

export async function getSaleByProviderPaymentId(providerPaymentId: string): Promise<RepoSale | null> {
  if (!providerPaymentId) return null;
  return mem().sales.find((s) => s.providerPaymentId === providerPaymentId) ?? null;
}

/** Which of these handles are suspended, in one pass. */
export async function listSuspendedHandles(handles: string[]): Promise<Set<string>> {
  const wanted = new Set(handles.map((h) => h.toLowerCase().replace(/^@/, "")).filter(Boolean));
  const suspended = new Set<string>();
  for (const p of mem().profiles.values()) {
    if (p.suspendedAt && wanted.has(p.handle)) suspended.add(p.handle);
  }
  return suspended;
}

export async function getProfileByHandle(handle: string): Promise<RepoProfile | null> {
  const h = handle.toLowerCase().replace(/^@/, "");
  // Profiles are keyed by id; handle lookup scans (the memory store is small).
  for (const p of mem().profiles.values()) if (p.handle === h) return p;
  return null;
}

export async function getProfileById(id: string): Promise<RepoProfile | null> {
  return mem().profiles.get(id) ?? null;
}

export async function marketValueCents(): Promise<number> {
  // Same sampling cap as the Supabase path, newest-claimed first, so both
  // adapters report the same number for the same market.
  const rows = [...mem().domains.values()]
    .filter((d) => d.holderUserId)
    .sort((a, b) => (b.claimedAt ?? "").localeCompare(a.claimedAt ?? ""))
    .slice(0, MARKET_VALUE_SAMPLE_LIMIT);
  return rows.reduce((sum, d) => sum + d.priceCents, 0);
}

// ------------------------------------------------------------------- quotes
export async function createQuote(domainInput: string, buyerUserId: string): Promise<RepoQuote> {
  const domain = requireEligibleDomain(domainInput);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + QUOTE_TTL_MS).toISOString();

  const profile = await getProfileById(buyerUserId);
  if (!profile) throw new Error("PROFILE_REQUIRED");
  if (profile.suspendedAt) throw new Error("ACCOUNT_SUSPENDED");

  const current = mem().domains.get(domain) ?? {
    domain, holderUserId: null, holderHandle: null, priceCents: 0, version: 0, claimedAt: null, updatedAt: null,
  };
  if (current.holderUserId && current.holderUserId === buyerUserId) throw new Error("ALREADY_HOLDER");
  const q = quoteFor({ domain, holder: current.holderHandle, priceCents: current.priceCents, version: current.version, history: [] });
  const id = crypto.randomUUID();
  const quote: RepoQuote = {
    id,
    domain,
    buyerUserId,
    expectedVersion: current.version,
    currentPriceCents: current.priceCents,
    requiredIncrementCents: q.requiredIncrementCents,
    nextPriceCents: q.nextPriceCents,
    expiresAt,
    status: "active",
    createdAt: now.toISOString(),
    checkoutProvider: null,
    checkoutPaymentId: null,
    checkoutUrl: null,
  };
  mem().quotes.set(id, quote);
  return quote;
}

export async function getQuote(quoteId: string): Promise<RepoQuote | null> {
  if (!isIdShaped(quoteId)) return null;
  return mem().quotes.get(quoteId) ?? null;
}

export async function markQuoteStatus(quoteId: string, status: RepoQuote["status"]): Promise<void> {
  const q = mem().quotes.get(quoteId);
  if (!q) return;
  // Mirrors the Supabase guard: consumed is terminal, never downgraded.
  if (q.status === "consumed" && status !== "consumed") return;
  q.status = status;
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
  const q = mem().quotes.get(args.quoteId);
  if (!q) throw new Error("UNKNOWN_QUOTE");
  if (q.checkoutPaymentId) {
    return { paymentId: q.checkoutPaymentId, checkoutUrl: q.checkoutUrl, reused: true };
  }
  // Mirror the Supabase guard: never store a session on, or resurrect, a
  // terminal quote. Dev must reproduce the production refusal, not diverge.
  if (q.status !== "active" && q.status !== "checkout_created") {
    throw new Error(`QUOTE_NOT_CHECKOUTABLE: ${q.status}`);
  }
  q.checkoutProvider = args.provider;
  q.checkoutPaymentId = args.paymentId;
  q.checkoutUrl = args.checkoutUrl;
  if (q.status === "active") q.status = "checkout_created";
  return { paymentId: args.paymentId, checkoutUrl: args.checkoutUrl, reused: false };
}

// --------------------------------------------------------------- finalization
export async function finalizeTakeover(input: FinalizeInput): Promise<TakeoverOutcome> {
  // In-memory mirror of db/schema.sql finalize_takeover, with the same codes.
  const m = mem();
  // Mirror the SQL input validation: empty identifiers must never materialize
  // rows the SQL side would reject with INVALID_*.
  if (
    !input.domain?.trim() ||
    !input.buyerUserId?.trim() ||
    !input.buyerHandle?.trim() ||
    !input.providerPaymentId?.trim()
  ) {
    return { ok: false, code: "FINALIZE_ERROR" };
  }
  // One payment id, one outcome: a LIVE refund intent blocks a sale, matching
  // the SQL advisory-lock exclusion. A definitively `failed` refund does not
  // block (the provider answered and no money moved), so a later correct
  // payment can still fund the sale.
  for (const refund of m.refunds.values()) {
    if (refund.providerPaymentId === input.providerPaymentId && refund.status !== "failed") {
      return { ok: false, code: "PAYMENT_ALREADY_REFUNDED" };
    }
  }
  const existing = m.sales.find((s) => s.providerPaymentId === input.providerPaymentId);
  if (existing) {
    if (existing.domain !== input.domain || existing.buyerUserId !== input.buyerUserId || existing.priceCents !== input.paidCents) {
      return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
    }
    return { ok: true, sale: existing };
  }

  let d = m.domains.get(input.domain);
  if (!d) {
    d = { domain: input.domain, holderUserId: null, holderHandle: null, priceCents: 0, version: 0, claimedAt: null, updatedAt: null };
    m.domains.set(input.domain, d);
  }

  if (d.version !== input.expectedVersion) return { ok: false, code: "STALE_QUOTE" };
  if (d.holderUserId && d.holderUserId === input.buyerUserId) return { ok: false, code: "ALREADY_HOLDER" };

  // The locked formula lives in one TS place (game.ts quoteFor). Re-deriving it
  // here with literals is how the memory adapter and the SQL finalizer drift;
  // tests/pg/pricing-parity.test.ts pins quoteFor against the SQL RPC.
  const required = quoteFor({
    domain: d.domain,
    holder: d.holderHandle,
    priceCents: d.priceCents,
    version: d.version,
    history: [],
  }).nextPriceCents;
  if (input.paidCents !== required) return { ok: false, code: "WRONG_PRICE" };

  const sale: RepoSale = {
    id: crypto.randomUUID(),
    domain: d.domain,
    buyerUserId: input.buyerUserId,
    buyerHandle: input.buyerHandle,
    previousHolderHandle: d.holderHandle,
    previousPriceCents: d.priceCents,
    priceCents: input.paidCents,
    domainVersion: d.version + 1,
    providerPaymentId: input.providerPaymentId,
    createdAt: new Date().toISOString(),
  };
  m.domains.set(input.domain, {
    ...d,
    holderUserId: input.buyerUserId,
    holderHandle: input.buyerHandle,
    priceCents: input.paidCents,
    version: d.version + 1,
    claimedAt: d.claimedAt ?? sale.createdAt,
    updatedAt: sale.createdAt,
  });
  m.sales.push(sale);
  return { ok: true, sale };
}

// ------------------------------------------------------------------ profiles
export async function upsertProfile(id: string, handle: string, displayName: string | null, avatarUrl: string | null): Promise<RepoProfile> {
  const h = handle.toLowerCase();
  const m = mem();
  // SQL upserts on the id and lets the unique index on profiles.handle reject
  // a hijack; both halves are mirrored here. Without the uniqueness throw, a
  // second user claiming a taken handle would silently overwrite the holder,
  // and claimHandle would return success instead of HANDLE_TAKEN.
  for (const p of m.profiles.values()) {
    if (p.handle === h && p.id !== id) {
      throw new Error('duplicate key value violates unique constraint "profiles_handle_key"');
    }
  }
  const existing = m.profiles.get(id);
  const profile: RepoProfile = {
    id, handle: h, displayName, avatarUrl,
    bio: existing?.bio ?? null,
    ctaLabel: existing?.ctaLabel ?? null,
    ctaUrl: existing?.ctaUrl ?? null,
    // Suspension is moderation state the SQL upsert never writes; a profile
    // upsert must not lift an existing suspension.
    suspendedAt: existing?.suspendedAt ?? null,
  };
  m.profiles.set(id, profile);
  return profile;
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
  const m = mem();
  const p = m.profiles.get(args.id);
  if (!p) return null;
  const updated: RepoProfile = { ...p, bio: args.bio, ctaLabel: args.ctaLabel, ctaUrl: args.ctaUrl };
  m.profiles.set(args.id, updated);
  return updated;
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
  // Mirrors the insert-only unique (provider, provider_event_id) index: the
  // webhook layer reads this violation as an idempotent duplicate delivery.
  const key = `${ev.provider}:${ev.providerEventId}`;
  if (mem().paymentEvents.has(key)) throw new Error("duplicate key value violates unique constraint \"payment_events_provider_provider_event_id_key\"");
  mem().paymentEvents.set(key, {
    id: crypto.randomUUID(),
    provider: ev.provider,
    providerEventId: ev.providerEventId,
    providerPaymentId: ev.providerPaymentId,
    eventType: ev.eventType,
    status: ev.status,
    createdAt: new Date().toISOString(),
  });
}

export async function getPaymentEvent(provider: string, providerEventId: string): Promise<{
  provider: string;
  providerEventId: string;
  providerPaymentId: string;
  eventType: string;
  status: string;
  processedAt: string | null;
} | null> {
  const ev = mem().paymentEvents.get(`${provider}:${providerEventId}`);
  if (!ev) return null;
  return {
    provider: ev.provider,
    providerEventId: ev.providerEventId,
    providerPaymentId: ev.providerPaymentId,
    eventType: ev.eventType,
    status: ev.status,
    processedAt: ev.createdAt,
  };
}

export async function markPaymentEventStatus(provider: string, providerEventId: string, status: "processed" | "ignored" | "error", error?: string): Promise<void> {
  void error; // no error column in the memory store; the status is the signal
  const ev = mem().paymentEvents.get(`${provider}:${providerEventId}`);
  if (ev) ev.status = status;
}

// --------------------------------------------------------------- refund ledger
export async function claimRefundAttempt(args: {
  provider: string;
  paymentId: string;
  eventId: string;
  reason: string;
  amountCents: number | null;
}): Promise<RefundClaim> {
  // Mirrors claim_refund_attempt's cross-check: a payment that already funded
  // a sale is never refundable. No refunds row is created for this verdict.
  if (mem().sales.some((s) => s.providerPaymentId === args.paymentId)) {
    return {
      claimed: false,
      status: "already_finalized",
      attempts: 0,
      claimToken: null,
      lastError: "sale_exists: payment already funded a takeover",
    };
  }
  const now = Date.now();
  const key = `${args.provider}:${args.paymentId}`;
  const existing = mem().refunds.get(key);
  if (!existing) {
    const claimToken = crypto.randomUUID();
    const timestamp = new Date(now).toISOString();
    mem().refunds.set(key, {
      provider: args.provider,
      providerPaymentId: args.paymentId,
      providerEventId: args.eventId,
      reason: args.reason,
      amountCents: args.amountCents,
      status: "attempting",
      attempts: 1,
      claimToken,
      leaseExpiresAt: now + REFUND_CLAIM_LEASE_MS,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    });
    return { claimed: true, status: "attempting", attempts: 1, claimToken, lastError: null };
  }

  if (existing.status === "succeeded" || existing.status === "manual_review") {
    return {
      claimed: false,
      status: existing.status,
      attempts: existing.attempts,
      claimToken: existing.claimToken,
      lastError: existing.lastError,
    };
  }

  if (existing.status === "attempting") {
    if (existing.leaseExpiresAt != null && existing.leaseExpiresAt > now) {
      return {
        claimed: false,
        status: existing.status,
        attempts: existing.attempts,
        claimToken: existing.claimToken,
        lastError: existing.lastError,
      };
    }
    existing.status = "manual_review";
    existing.claimToken = null;
    existing.leaseExpiresAt = null;
    existing.lastError ??= "refund attempt lease expired";
    existing.updatedAt = new Date(now).toISOString();
    return { claimed: false, status: "manual_review", attempts: existing.attempts, claimToken: null, lastError: existing.lastError };
  }

  if (existing.attempts >= MAX_REFUND_ATTEMPTS) {
    existing.status = "manual_review";
    existing.claimToken = null;
    existing.leaseExpiresAt = null;
    existing.updatedAt = new Date(now).toISOString();
    return { claimed: false, status: "manual_review", attempts: existing.attempts, claimToken: null, lastError: existing.lastError };
  }

  const claimToken = crypto.randomUUID();
  existing.status = "attempting";
  existing.attempts += 1;
  existing.claimToken = claimToken;
  existing.leaseExpiresAt = now + REFUND_CLAIM_LEASE_MS;
  existing.updatedAt = new Date(now).toISOString();
  return { claimed: true, status: "attempting", attempts: existing.attempts, claimToken, lastError: existing.lastError };
}

export async function completeRefundAttempt(args: {
  provider: string;
  paymentId: string;
  claimToken: string;
  status: Extract<RepoRefundStatus, "failed" | "succeeded" | "manual_review">;
  error?: string;
}): Promise<boolean> {
  const now = new Date().toISOString();
  const refund = mem().refunds.get(`${args.provider}:${args.paymentId}`);
  if (!refund || refund.claimToken !== args.claimToken) return false;
  refund.status = args.status;
  refund.claimToken = null;
  refund.leaseExpiresAt = null;
  refund.lastError = args.error ?? null;
  refund.updatedAt = now;
  refund.completedAt = args.status === "succeeded" || args.status === "manual_review" ? now : null;
  return true;
}

/**
 * Reconcile a provider-emitted refund status. A refund may be accepted as
 * pending/review by the provider and settle later, so this path is allowed to
 * complete a manual-review row without a live claim token. A later failure
 * event must never downgrade a refund already confirmed as succeeded.
 */
export async function reconcileRefundProviderEvent(args: {
  provider: string;
  paymentId: string;
  eventId: string;
  status: Extract<RepoRefundStatus, "succeeded" | "manual_review">;
  amountCents?: number | null;
  error?: string;
}): Promise<{ saleExists: boolean }> {
  const now = new Date().toISOString();
  const key = `${args.provider}:${args.paymentId}`;
  // Single-threaded here, so evaluating the verdict with the write is atomic
  // by construction (the SQL version takes the advisory lock).
  const saleExists = mem().sales.some((s) => s.providerPaymentId === args.paymentId);

  const existing = mem().refunds.get(key);
  if (existing?.status === "succeeded") return { saleExists };
  if (existing) {
    existing.status = args.status;
    existing.providerEventId = args.eventId;
    if (args.amountCents != null) existing.amountCents = args.amountCents;
    existing.claimToken = null;
    existing.leaseExpiresAt = null;
    existing.lastError = args.error ?? null;
    existing.updatedAt = now;
    existing.completedAt = now;
    return { saleExists };
  }

  mem().refunds.set(key, {
    provider: args.provider,
    providerPaymentId: args.paymentId,
    providerEventId: args.eventId,
    reason: "provider_refund_event",
    amountCents: args.amountCents ?? null,
    status: args.status,
    attempts: 0,
    claimToken: null,
    leaseExpiresAt: null,
    lastError: args.error ?? null,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });
  return { saleExists };
}

export async function isReservedInDb(domain: string): Promise<boolean> {
  void domain; // no operator-managed blocklist without a database
  return false;
}

export async function isDomainReserved(domain: string): Promise<boolean> {
  // Static blocklist (always) + operator-managed DB blocklist (prod).
  const { evaluateDomain } = await import("../domains.ts");
  if (evaluateDomain(domain).reason === "reserved") return true;
  return isReservedInDb(domain);
}

export async function listReservedDomains(): Promise<Set<string>> {
  // No operator blocklist without a database; the static list is applied by
  // dropReservedRows/filterOutReserved at every call site.
  return new Set<string>();
}

// ------------------------------------------------------- demo seeding (non-prod)
export function seedDemoMarket(items: Array<{ domain: string; holderHandle: string; priceCents: number }>): void {
  const m = mem();
  // Idempotent: module-level seeding runs on every SSR render in dev — don't
  // duplicate sales or overwrite newer holder state.
  for (const item of items) {
    if (m.domains.has(item.domain)) continue;
    const now = new Date().toISOString();
    // Handles are stored bare (no leading @) everywhere; strip if a caller included it.
    const handle = item.holderHandle.replace(/^@+/, "").toLowerCase();
    const userId = `demo-${handle}`;
    const sale: RepoSale = {
      id: crypto.randomUUID(),
      domain: item.domain,
      buyerUserId: userId,
      buyerHandle: handle,
      previousHolderHandle: null,
      previousPriceCents: 0,
      priceCents: item.priceCents,
      domainVersion: 1,
      providerPaymentId: `demo-${item.domain}-${item.priceCents}`,
      createdAt: now,
    };
    m.domains.set(item.domain, {
      domain: item.domain,
      holderUserId: sale.buyerUserId,
      holderHandle: handle,
      priceCents: item.priceCents,
      version: 1,
      claimedAt: now,
      updatedAt: now,
    });
    m.sales.push(sale);
    if (!m.profiles.has(userId)) {
      m.profiles.set(userId, { id: userId, handle, displayName: null, avatarUrl: null, bio: null, ctaLabel: null, ctaUrl: null, suspendedAt: null });
    }
  }
}
