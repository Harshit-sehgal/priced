// Webhook duplicate-handling helpers, kept out of the route so they are
// unit-testable (Next route files only accept its own exports).
import "server-only";

/**
 * A `received` payment_events row older than this is considered abandoned: the
 * first delivery crashed (Worker eviction, timeout) or its terminal status
 * write failed. Without re-entry the duplicate handler would acknowledge every
 * redelivery forever and the payment would never be finalized or refunded.
 * Provider webhook timeouts are ~15s, so 15 minutes is far beyond any live
 * delivery.
 */
export const STALE_IN_PROGRESS_MS = 15 * 60 * 1000;

/**
 * True when an in-progress event row is old enough to re-enter processing.
 * A missing/unparseable timestamp is treated as stale: leaving a payment
 * acknowledged-but-unprocessed forever is worse than reprocessing, which is
 * idempotent and serialized per payment on the SQL side.
 */
export function isStaleInProgress(processedAt: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!processedAt) return true;
  const at = new Date(processedAt).getTime();
  if (!Number.isFinite(at)) return true;
  return nowMs - at > STALE_IN_PROGRESS_MS;
}
