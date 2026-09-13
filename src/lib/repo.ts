// Server-only market repository. Two adapters behind one interface:
//  - Supabase/Postgres when env is configured (production path) — ./repo/supabase.ts
//  - deterministic in-memory store otherwise (local dev / preview) — ./repo/memory.ts
// Quotes, takeovers and history are ALWAYS server-authoritative here.
//
// This module is only the selector: it picks one adapter ONCE at load and
// re-exports its functions unchanged. Every caller keeps importing from
// "@/lib/repo" and cannot tell which adapter is underneath. Behaviour lives in
// the adapters; the contract they both satisfy is RepoAdapter in ./repo/types.ts.
import "server-only";
import { isProdDatastore } from "./repo/env.ts";
import * as memoryAdapter from "./repo/memory.ts";
import * as supabaseAdapter from "./repo/supabase.ts";
import type { RepoAdapter } from "./repo/types.ts";

export type {
  RepoDomain,
  RepoSale,
  RepoProfile,
  RepoQuote,
  RepoRefundStatus,
  RefundClaim,
  TakeoverOutcome,
  FinalizeInput,
} from "./repo/types.ts";

export { isProdDatastore } from "./repo/env.ts";
export { MAX_REFUND_ATTEMPTS } from "./repo/shared.ts";
// Test/dev only: clears the in-memory market whichever adapter is live, exactly
// as before the split (the Supabase adapter has no such state to clear).
export { resetMemoryMarket } from "./repo/memory.ts";

// The datastore is chosen once, at module load, from env read once (./repo/env.ts).
// This assignment is also the compile-time proof that BOTH adapters implement
// the whole contract: a function added to or re-typed on one side only fails
// here instead of drifting silently into dev-vs-production divergence.
const adapter: RepoAdapter = isProdDatastore ? supabaseAdapter : memoryAdapter;

// ------------------------------------------------------------------- reads
export const getDomain = adapter.getDomain;
export const getDomainForDisplay = adapter.getDomainForDisplay;
export const listMarket = adapter.listMarket;
export const listSalesForBuyer = adapter.listSalesForBuyer;
export const listMostContested = adapter.listMostContested;
export const listFastestRising = adapter.listFastestRising;
export const listNewlyClaimed = adapter.listNewlyClaimed;
export const listRecentSales = adapter.listRecentSales;
export const listSalesForDomain = adapter.listSalesForDomain;
export const listDomainsForHolder = adapter.listDomainsForHolder;
export const getSale = adapter.getSale;
export const getSaleByProviderPaymentId = adapter.getSaleByProviderPaymentId;
export const listSuspendedHandles = adapter.listSuspendedHandles;
export const getProfileByHandle = adapter.getProfileByHandle;
export const getProfileById = adapter.getProfileById;
export const marketValueCents = adapter.marketValueCents;

// ------------------------------------------------------------------- quotes
export const createQuote = adapter.createQuote;
export const getQuote = adapter.getQuote;
export const markQuoteStatus = adapter.markQuoteStatus;
export const setQuoteCheckout = adapter.setQuoteCheckout;

// --------------------------------------------------------------- finalization
export const finalizeTakeover = adapter.finalizeTakeover;

// ------------------------------------------------------------------ profiles
export const upsertProfile = adapter.upsertProfile;
export const updateProfileExtras = adapter.updateProfileExtras;

// ------------------------------------------------------------- payment events
export const recordPaymentEvent = adapter.recordPaymentEvent;
export const getPaymentEvent = adapter.getPaymentEvent;
export const markPaymentEventStatus = adapter.markPaymentEventStatus;

// --------------------------------------------------------------- refund ledger
export const claimRefundAttempt = adapter.claimRefundAttempt;
export const completeRefundAttempt = adapter.completeRefundAttempt;
export const reconcileRefundProviderEvent = adapter.reconcileRefundProviderEvent;

// -------------------------------------------------------------------- reserved
export const isReservedInDb = adapter.isReservedInDb;
export const isDomainReserved = adapter.isDomainReserved;
export const listReservedDomains = adapter.listReservedDomains;

// Adapter-independent display helper: drop rows whose domain is reserved using
// the cached blocklist set, without a per-domain query. Exported for callers
// (sitemap) that fetch their own rows.
export { dropReservedRows } from "./repo/shared.ts";

// ------------------------------------------------------- demo seeding (non-prod)
export const seedDemoMarket = adapter.seedDemoMarket;
