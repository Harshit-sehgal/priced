import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Session-refresh middleware. The security headers (including the enforced
 * Content-Security-Policy) live in `next.config.mjs` headers(), NOT here:
 * middleware does not run on the routes the matcher excludes, so a
 * middleware-set policy would be missing on `/api/health`, `/api/webhooks`,
 * the pulse endpoint, the OG images and anything else added to the
 * exclusions later.
 */
export default async function proxy(request: NextRequest) {
  // Skip if auth env not configured (demo mode: no Supabase).
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return NextResponse.next();
  }

  const response = NextResponse.next();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          request.cookies.set(name, value);
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Refresh the session so Server Components see a valid user.
  // Supabase SSR does lazy refresh on getUser / getSession.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    // Every matched request pays a supabase.auth.getUser() network round-trip,
    // so routes that can never act on a user session are excluded: the signed
    // webhook, the demo pulse/demo routes, the health probes (hit every 15
    // minutes by the uptime workflow), the crawler-only sitemap/robots files,
    // and both generated Open Graph images — the OG routes are unauthenticated
    // by definition and are the most crawler-heavy paths on the site.
    // Exclusions that name ONE route are anchored with `$`; unanchored they
    // are prefixes, so a bare `api/health` would also silently exclude a
    // future `/api/health/deep` and leave it with no session. `api/webhooks`
    // and `api/demo` are whole subtrees and keep a trailing `/` for the same
    // reason: a bare `api/demo` would swallow a future `/api/demographics`.
    // `api/market/pulse` is one route, so it is `$`-anchored.
    // `.*/opengraph-image$` is likewise anchored so a domain page whose slug
    // merely contains "opengraph-image" stays session-aware.
    // Everything else, including every session-bearing route, stays matched.
    "/((?!_next/static|_next/image|favicon\\.ico$|api/webhooks/|api/market/pulse$|api/demo/|api/health$|sitemap\\.xml$|robots\\.txt$|.*/opengraph-image$).*)",
  ],
};
