// Shared vocabulary of the market repository: the row shapes both adapters
// return, and the `RepoAdapter` contract each of them must implement in full.
// The contract is what keeps the Supabase and in-memory adapters honest — a
// function added to or changed on one side fails typecheck in src/lib/repo.ts
// instead of drifting silently (the in-memory store once keyed profiles by
// handle while SQL keyed by id, so dev enforced a rule production did not).

export type RepoDomain = {
  domain: string;
  holderUserId: string | null;
  holderHandle: string | null;
  priceCents: number;
  version: number;
  claimedAt: string | null;
  updatedAt: string | null;
};

export type RepoSale = {
  id: string;
  domain: string;
  buyerUserId: string;
  buyerHandle: string;
  previousHolderHandle: string | null;
  previousPriceCents: number;
  priceCents: number;
  domainVersion: number;
  providerPaymentId: string;
  createdAt: string;
};

export type RepoProfile = {
  id: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  ctaLabel: string | null;
  ctaUrl: string | null;
  suspendedAt: string | null;
};

export type RepoQuote = {
  id: string;
  domain: string;
  buyerUserId: string;
  expectedVersion: number;
  currentPriceCents: number;
  requiredIncrementCents: number;
  nextPriceCents: number;
  expiresAt: string;
  status: string;
  createdAt: string;
  // Idempotent checkout reuse: one quote maps to at most one provider session.
  // Null until the first successful POST /api/checkout for this quote.
  checkoutProvider: string | null;
  checkoutPaymentId: string | null;
  checkoutUrl: string | null;
};

export type TakeoverOutcome =
  | { ok: true; sale: RepoSale }
  | { ok: false; code: "STALE_QUOTE" | "WRONG_PRICE" | "ALREADY_HOLDER" | "IDEMPOTENCY_CONFLICT" | "FINALIZE_ERROR" };

export type FinalizeInput = {
  domain: string;
  buyerUserId: string;
  buyerHandle: string;
  expectedVersion: number;
  paidCents: number;
  providerPaymentId: string;
};

export type RepoRefundStatus = "attempting" | "failed" | "succeeded" | "manual_review";

export type RefundClaim = {
  claimed: boolean;
  status: RepoRefundStatus;
  attempts: number;
  claimToken: string | null;
  lastError: string | null;
};

/**
 * The full data-layer surface. Both `./supabase.ts` and `./memory.ts` must
 * satisfy this; src/lib/repo.ts checks that by assigning each of them to it.
 */
export type RepoAdapter = {
  // ------------------------------------------------------------------- reads
  getDomain(domain: string): Promise<RepoDomain | null>;
  listMarket(limit?: number): Promise<RepoDomain[]>;
  /** Sales where the given handle is the buyer, newest first. */
  listSalesForBuyer(buyerHandle: string, limit?: number): Promise<RepoSale[]>;
  /**
   * Most-contested domains (§39 discovery): more than one sale, ranked by sale
   * count DESC, latest sale DESC, domain ASC — deterministic for all visitors.
   * Returns live market state so the UI can show current holder/price.
   */
  listMostContested(limit?: number): Promise<Array<{ domain: string; sales: number; priceCents: number; holderHandle: string }>>;
  /**
   * Fastest Rising (§12): biggest absolute price increase from a sale within
   * the window, computed from the immutable ledger (real data only). Ranks by
   * (price - previous_price) among recent sales, then joins live market state.
   */
  listFastestRising(limit?: number, windowMs?: number): Promise<Array<{ domain: string; roseCents: number; priceCents: number; holderHandle: string }>>;
  /**
   * Newly Claimed (§12): first claims (previous_price = 0), newest first.
   * Honest by construction: the ledger only records real first claims.
   */
  listNewlyClaimed(limit?: number): Promise<Array<{ domain: string; priceCents: number; holderHandle: string; createdAt: string }>>;
  listRecentSales(limit?: number): Promise<RepoSale[]>;
  listSalesForDomain(domain: string, limit?: number): Promise<RepoSale[]>;
  getSale(saleId: string): Promise<RepoSale | null>;
  getProfileByHandle(handle: string): Promise<RepoProfile | null>;
  getProfileById(id: string): Promise<RepoProfile | null>;
  marketValueCents(): Promise<number>;

  // ------------------------------------------------------------------ quotes
  createQuote(domainInput: string, buyerUserId: string): Promise<RepoQuote>;
  getQuote(quoteId: string): Promise<RepoQuote | null>;
  markQuoteStatus(quoteId: string, status: RepoQuote["status"]): Promise<void>;
  /**
   * Persist the provider session for a quote so retries reuse one checkout.
   * First writer wins: a concurrent second checkout for the same quote reuses
   * the stored session instead of creating a second payment session.
   * Returns the authoritative (existing-or-newly-stored) checkout triple.
   */
  setQuoteCheckout(args: {
    quoteId: string;
    provider: string;
    paymentId: string;
    checkoutUrl: string | null;
  }): Promise<{ paymentId: string; checkoutUrl: string | null; reused: boolean }>;

  // ------------------------------------------------------------ finalization
  finalizeTakeover(input: FinalizeInput): Promise<TakeoverOutcome>;

  // ---------------------------------------------------------------- profiles
  upsertProfile(id: string, handle: string, displayName: string | null, avatarUrl: string | null): Promise<RepoProfile>;
  /**
   * Holder-authored profile extras (bio + CTA). Validated upstream in
   * /api/profile; this layer only persists. Handle is immutable and is NOT
   * writable here.
   */
  updateProfileExtras(args: {
    id: string;
    bio: string | null;
    ctaLabel: string | null;
    ctaUrl: string | null;
  }): Promise<RepoProfile | null>;

  // ----------------------------------------------------------- payment events
  recordPaymentEvent(ev: {
    provider: string;
    providerEventId: string;
    providerPaymentId: string;
    eventType: string;
    payloadHash?: string;
    status: "received" | "processed" | "ignored" | "error";
    error?: string;
  }): Promise<void>;
  getPaymentEvent(provider: string, providerEventId: string): Promise<{
    provider: string;
    providerEventId: string;
    providerPaymentId: string;
    eventType: string;
    status: string;
  } | null>;
  markPaymentEventStatus(provider: string, providerEventId: string, status: "processed" | "ignored" | "error", error?: string): Promise<void>;

  // ------------------------------------------------------------ refund ledger
  claimRefundAttempt(args: {
    provider: string;
    paymentId: string;
    eventId: string;
    reason: string;
    amountCents: number | null;
  }): Promise<RefundClaim>;
  completeRefundAttempt(args: {
    provider: string;
    paymentId: string;
    claimToken: string;
    status: Extract<RepoRefundStatus, "failed" | "succeeded" | "manual_review">;
    error?: string;
  }): Promise<boolean>;
  /**
   * Reconcile a provider-emitted refund status. A refund may be accepted as
   * pending/review by the provider and settle later, so this path is allowed to
   * complete a manual-review row without a live claim token. A later failure
   * event must never downgrade a refund already confirmed as succeeded.
   */
  reconcileRefundProviderEvent(args: {
    provider: string;
    paymentId: string;
    eventId: string;
    status: Extract<RepoRefundStatus, "succeeded" | "manual_review">;
    amountCents?: number | null;
    error?: string;
  }): Promise<void>;

  // ------------------------------------------------------------------ reserved
  isReservedInDb(domain: string): Promise<boolean>;
  isDomainReserved(domain: string): Promise<boolean>;

  // --------------------------------------------------------------- demo seeding
  seedDemoMarket(items: Array<{ domain: string; holderHandle: string; priceCents: number }>): void;
};
