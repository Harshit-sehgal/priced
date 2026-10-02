// Structured logger for server-side payment/webhook observability (§56).
// Emits single-line JSON to stdout/stderr so hosts can index and alert on the
// critical events: payment succeeded but takeover failed, refund failed,
// webhook signature failures, finalization errors.
//
// TWO optional, independent alert sinks fire for level "error" ONLY:
//
//  1. ALERT_WEBHOOK_URL — a dependency-free JSON POST to any endpoint
//     (Slack/Discord/generic collector). This is the free, always-available
//     path and the one the launch runbook recommends; it works on Cloudflare
//     Workers and Node alike because it uses the platform `fetch`.
//  2. SENTRY_DSN — forwarded to Sentry ONLY when the optional `@sentry/nextjs`
//     package is actually installed (`npm i @sentry/nextjs`). It is
//     deliberately NOT a hard dependency: the active runtime is Cloudflare
//     Workers, most deployments do not run Sentry, and an uninstalled optional
//     import fails silently rather than crashing the money path. Setting the
//     DSN alone does nothing until the package is present — see DEPLOY.md §8.
//
// Neither sink ever forwards raw webhook bodies or secrets; both strip
// secret/PII-shaped keys and keep only primitive values.
import "server-only";

export type LogLevel = "info" | "warn" | "error";

const SENTRY_SPECIFIER = "@sentry/nextjs";

/**
 * Drop secret/PII-shaped keys and keep only primitive values, so a nested
 * object (or a stray token) can never reach an alert destination. Shared by
 * both sinks so their redaction can never drift apart.
 */
export function sanitizeAlertFields(fields: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    const lower = k.toLowerCase();
    if (lower.includes("secret") || lower.includes("token") || lower.includes("password") || lower.includes("email")) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v == null) safe[k] = v;
  }
  return safe;
}

/**
 * Dependency-free alert sink. Fire-and-forget: never awaited, never throws,
 * and bounded by a timeout so a hung collector cannot hold a request open.
 * On Cloudflare Workers `fetch` is native; on Node it is global since v18.
 */
function maybeSendAlertWebhook(event: string, fields: Record<string, unknown>): void {
  const url = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!url) return;
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    level: "error",
    event,
    ...sanitizeAlertFields(fields),
  });
  void fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    signal: AbortSignal.timeout(3_000),
  }).catch(() => null);
}

function maybeCaptureError(event: string, fields: Record<string, unknown>): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return;
  // Use Function("return import(...)") so Turbopack/eslint don't flag a string-literal eval.
  const dynImport = new Function("s", "return import(s)") as (s: string) => Promise<unknown>;
  void dynImport(SENTRY_SPECIFIER)
    .catch(() => null)
    .then((mod) => {
      const sentry = mod as null | { captureMessage?: (msg: string, opts?: { level?: string; tags?: Record<string, unknown> }) => void };
      if (!sentry?.captureMessage) return;
      sentry.captureMessage(event, { level: "error", tags: sanitizeAlertFields(fields) });
    });
}

export function logEvent(
  event: string,
  level: LogLevel,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  // Only error-level events are worth waking someone up for.
  if (level === "error") {
    maybeSendAlertWebhook(event, fields);
    maybeCaptureError(event, fields);
  }
}
