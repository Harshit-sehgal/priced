import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export default async function proxy(request: NextRequest) {
  // Next's App Router emits inline bootstrap scripts for RSC and hydration, so
  // the CSP has to permit them somehow: a per-request nonce, or 'unsafe-inline'.
  //
  // A nonce was tried and does NOT work for this app. Two reasons, both
  // verified against a production build:
  //
  //  1. Next does not read `x-nonce` — it discovers the nonce by parsing
  //     'nonce-…' out of the CONTENT-SECURITY-POLICY *request* header. Setting
  //     it only on the response yielded an enforcing policy demanding a nonce
  //     that 0 of 10 script tags carried, so every inline script was blocked
  //     and any client-rendered page showed an empty <main>. Fixing that took
  //     dynamic routes from 0/10 to 10/10 nonced.
  //  2. But statically prerendered pages still got 0/10, and always will: their
  //     HTML is built ahead of time, so it cannot contain a per-request value.
  //     /login, /welcome and /checkout/mock are prerendered client components,
  //     and a "use client" module cannot declare `force-dynamic`. Making them
  //     dynamic means restructuring them behind server wrappers — a real
  //     refactor of the auth path, not a header change.
  //
  // So the enforcing policy allows inline scripts instead. Note that mixing
  // the two is NOT an option: per the CSP spec, once a nonce is present
  // browsers IGNORE 'unsafe-inline', so a nonce would re-break the static
  // pages even with it listed.
  //
  // What this still buys: scripts may only be LOADED from 'self' and the
  // Turnstile origin, which blocks the usual XSS exfiltration path, plus
  // object-src 'none', base-uri 'self' and frame-ancestors 'none'. What it
  // gives up is inline-script execution, mitigated by there being no
  // dangerouslySetInnerHTML anywhere in src/ and React escaping all output.
  //
  // A single policy for every route is deliberate: an exclusion list of "the
  // static ones" would silently rot the moment a page's rendering mode changed.
  //
  // To restore a nonce later, convert those three pages to server components
  // that render a client child, confirm every HTML route builds as ƒ (Dynamic),
  // then put 'nonce-…' back here and drop 'unsafe-inline'.
  const csp = contentSecurityPolicy();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", csp);

  // Skip if auth env not configured (demo mode: no Supabase).
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("Content-Security-Policy", csp);
    return response;
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);

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

function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    // 'unsafe-inline' rather than a nonce — see the note in proxy() for why a
    // nonce cannot work while /login, /welcome and /checkout/mock are
    // prerendered client components. Script LOADING stays restricted to 'self'
    // and Turnstile, which is the control that blocks XSS exfiltration.
    "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https:",
    "frame-src https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
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
    // future `/api/health/deep` and leave it with no session. `api/webhooks`,
    // `api/demo` and `api/market/pulse` stay unanchored on purpose — those are
    // whole subtrees that can never act on a user session.
    // `.*/opengraph-image$` is likewise anchored so a domain page whose slug
    // merely contains "opengraph-image" stays session-aware.
    // Everything else, including every session-bearing route, stays matched.
    "/((?!_next/static|_next/image|favicon\\.ico$|api/webhooks|api/market/pulse|api/demo|api/health$|sitemap\\.xml$|robots\\.txt$|.*/opengraph-image$).*)",
  ],
};
