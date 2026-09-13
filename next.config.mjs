/** @type {import('next').NextConfig} */

// The ENFORCED policy. It lives here, not in src/proxy.ts, so that EVERY
// response carries it — including the routes the session-refresh middleware
// deliberately skips (`/api/health`, `/api/market/pulse`, `/api/webhooks`,
// `/api/demo`, sitemap/robots, generated OG images). A middleware-only policy
// silently disappears for those paths, and would silently disappear for any
// future HTML route added to the matcher exclusions.
//
// `script-src` allows `'unsafe-inline'` rather than a nonce: /login, /welcome,
// /checkout/mock and the legal pages are dynamically rendered now, but the
// Next app still emits inline bootstrap scripts, and the repo deliberately
// keeps the documented trade-off (script LOADING stays restricted to 'self'
// and Turnstile, object/base/frame are locked down). See DEPLOY/INTEGRATION
// before changing it.
const CSP = [
  "default-src 'self'",
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

const nextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  // Do not announce the framework/version to every response.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // Report-Only CSP: a tripwire that must be SATISFIED today, so that a
          // violation is real signal.
          //
          // The enforced policy above allows `connect-src 'self' https:` — i.e.
          // an XSS could exfiltrate to ANY https host. This probes the narrow
          // set we genuinely use (Supabase REST + realtime websocket,
          // Turnstile), so a violation tells us about a real egress we had not
          // accounted for, rather than restating a limitation we already
          // documented. script-src matches the enforced policy on purpose: it
          // is not what is being probed here.
          { key: "Content-Security-Policy-Report-Only", value: "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          // HSTS only matters on https; harmless on http/localhost.
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
