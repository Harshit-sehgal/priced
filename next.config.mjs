/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // Report-Only CSP: a tripwire that must be SATISFIED today, so that a
          // violation is real signal.
          //
          // The previous version forbade inline scripts "until nonce plumbing
          // lands in proxy.ts". That plan is now known to be unachievable —
          // nonces were implemented and proven impossible for this app's
          // statically prerendered "use client" pages (/login, /welcome,
          // /checkout/mock), whose HTML is built ahead of time and cannot carry
          // a per-request value (see the long note in src/proxy.ts). So it was
          // violated on 100% of page loads, with no report-uri or report-to
          // collecting anything: console noise for every visitor, and an alarm
          // that is always red is an alarm everyone learns to ignore.
          //
          // Retargeted at the directive that is actually worth tightening next.
          // The enforced policy allows `connect-src 'self' https:` — i.e. an
          // XSS could exfiltrate to ANY https host. This probes the narrow set
          // we genuinely use (Supabase REST + realtime websocket, Turnstile),
          // so a violation tells us about a real egress we had not accounted
          // for, rather than restating a limitation we already documented.
          // script-src matches the enforced policy on purpose: it is not what
          // is being probed here.
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
