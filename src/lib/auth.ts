// Server-side Supabase auth helpers (SSR cookie sessions via @supabase/ssr).
import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { type SupabaseClient } from "@supabase/supabase-js";
import { getProfileById, getProfileByHandle, upsertProfile, type RepoProfile } from "./repo.ts";
import { isHandleAllowed, isHandleValid } from "./domains.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export const isAuthConfigured = Boolean(url && anonKey);

/** Cookie-bound client for Server Components, Server Actions and route handlers. */
export async function createAuthClient(): Promise<SupabaseClient> {
  if (!isAuthConfigured) throw new Error("AUTH_NOT_CONFIGURED");
  const cookieStore = await cookies();
  return createServerClient(url!, anonKey!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot set cookies; middleware refreshes sessions.
        }
      },
    },
  });
}

export type SessionUser = { id: string; email: string | null };

export async function getSessionUser(): Promise<SessionUser | null> {
  if (!isAuthConfigured) return null;
  const { data } = await (await createAuthClient()).auth.getUser();
  if (!data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

/**
 * The buyer's public identity. Absence of a profile means the user still owes
 * a handle — the UI routes them through /welcome before any purchase.
 */
export async function getViewer(): Promise<{ user: SessionUser | null; profile: RepoProfile | null }> {
  const user = await getSessionUser();
  if (!user) return { user: null, profile: null };
  const profile = await getProfileById(user.id);
  return { user, profile };
}

/** Dev/demo identities when Supabase auth is not configured. */
export function demoViewer(): { user: SessionUser; profile: RepoProfile } {
  const user = { id: "demo-user", email: "demo@localhost" };
  const profile: RepoProfile = { id: user.id, handle: "demo", displayName: "Demo Holder", avatarUrl: null, bio: null, ctaLabel: null, ctaUrl: null, suspendedAt: null };
  return { user, profile };
}

export async function claimHandle(userId: string, rawHandle: string): Promise<{ ok: true; handle: string } | { ok: false; reason: string }> {
  const handle = rawHandle.trim().toLowerCase().replace(/^@+/, "");
  if (!isHandleValid(handle)) return { ok: false, reason: "INVALID_HANDLE" };
  // Well-formed but banned/brand-like: say so instead of repeating the format rule.
  if (!isHandleAllowed(handle)) return { ok: false, reason: "HANDLE_RESERVED" };
  const existing = await getProfileById(userId);
  if (existing) {
    if (existing.handle !== handle) return { ok: false, reason: "HANDLE_LOCKED" };
    return { ok: true, handle };
  }
  // Pre-read check — final exclusivity is the unique constraint on profiles.handle.
  const taken = await getProfileByHandle(handle);
  if (taken && taken.id !== userId) return { ok: false, reason: "HANDLE_TAKEN" };
  try {
    await upsertProfile(userId, handle, null, null);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Postgres duplicate/handle uniqueness races between concurrent claim requests.
    if (/duplicate key.*handle|unique.*handle|23505/i.test(msg)) {
      return { ok: false, reason: "HANDLE_TAKEN" };
    }
    throw e;
  }
  return { ok: true, handle };
}
