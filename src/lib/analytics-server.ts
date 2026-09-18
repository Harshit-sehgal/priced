// Server-only analytics sink — writes to analytics_events (Supabase/Postgres).
// Import this only from server/route code. Demo mode is a no-op (no datastore).
// All money/funnel reasoning stays server-authoritative via structured logs;
// this table is for product funnel measurement, not money authority.
import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isProdDatastore } from "./repo.ts";

// Lazy client reuse — avoid top-level Supabase init when not configured.
let sb: SupabaseClient | null = null;
function client(): SupabaseClient | null {
  if (!isProdDatastore) return null;
  if (sb) return sb;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return sb;
}

export type PersistArgs = {
  event: string;
  sessionId?: string | null;
  domain?: string | null;
  handle?: string | null;
  userId?: string | null;
  props?: Record<string, unknown>;
};

/** Best-effort insert — never throws. Callers must not fail on analytics. */
export async function persistAnalyticsEvent(args: PersistArgs): Promise<void> {
  try {
    // Keep client construction inside the best-effort boundary too. A bad or
    // partially configured deployment must never turn a committed payment or
    // takeover into a webhook retry.
    const c = client();
    if (!c) return;
    await c.from("analytics_events").insert({
      event: args.event,
      session_id: args.sessionId ?? null,
      handle: args.handle ?? null,
      domain: args.domain ?? null,
      user_id: args.userId ?? null,
      props: args.props ?? {},
    });
  } catch {
    // swallow — analytics insert must never break checkout/funnel
  }
}
