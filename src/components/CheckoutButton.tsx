"use client";

import { useEffect, useRef, useState } from "react";
import { track } from "@/lib/analytics";

// Public site key (safe for the browser). Empty/undefined = Turnstile disabled.
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  execute: (widgetId?: string) => void;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
};

function loadTurnstileScript(): Promise<TurnstileApi | null> {
  return new Promise((resolve) => {
    const w = window as unknown as { turnstile?: TurnstileApi; onTurnstileLoad?: () => void };
    if (w.turnstile) return resolve(w.turnstile);
    w.onTurnstileLoad = () => resolve(w.turnstile ?? null);
    if (!document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')) {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad";
      s.async = true;
      s.defer = true;
      document.head.appendChild(s);
    }
    // Never block checkout forever on a blocked script; the server-side check
    // still protects the endpoint, and the user can retry.
    setTimeout(() => resolve(w.turnstile ?? null), 8_000);
  });
}

export function CheckoutButton({ quoteId }: { quoteId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const widgetRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const tokenRef = useRef<string | null>(null);

  // Render the invisible widget when Turnstile is configured.
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    let removed = false;
    void loadTurnstileScript().then((ts) => {
      if (!ts || removed || !widgetRef.current || widgetIdRef.current !== null) return;
      widgetIdRef.current = ts.render(widgetRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        size: "invisible",
        callback: (token: string) => {
          tokenRef.current = token;
        },
        "error-callback": () => {
          tokenRef.current = null;
        },
        "expired-callback": () => {
          tokenRef.current = null;
        },
      });
    });
    return () => {
      removed = true;
      const ts = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
      if (ts && widgetIdRef.current !== null) {
        try { ts.remove(widgetIdRef.current); } catch { /* already gone */ }
        widgetIdRef.current = null;
      }
    };
  }, []);

  async function checkout() {
    setBusy(true);
    setError(null);
    try {
      let token: string | null = tokenRef.current;
      if (TURNSTILE_SITE_KEY) {
        const ts = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
        if (ts && widgetIdRef.current !== null) {
          // Invisible widgets require an explicit execute() to mint a fresh token.
          // Previous tokens are single-use — clear and re-issue every checkout.
          tokenRef.current = null;
          try {
            ts.execute(widgetIdRef.current);
          } catch {
            // execute can throw if the widget is not yet ready; fall through to poll
          }
          token = await new Promise<string | null>((resolve) => {
            const started = Date.now();
            const poll = setInterval(() => {
              if (tokenRef.current) {
                clearInterval(poll);
                const t = tokenRef.current;
                tokenRef.current = null;
                resolve(t);
              } else if (Date.now() - started > 8_000) {
                clearInterval(poll);
                resolve(null);
              }
            }, 100);
          });
          try {
            ts.reset(widgetIdRef.current);
          } catch {
            /* already gone */
          }
        }
      }
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quoteId, turnstileToken: token }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `checkout failed (${res.status})`);
      // A provider session without a redirect URL is a retryable dead end.
      // Without this branch the button stayed on "Opening checkout…" forever:
      // busy was never cleared and no error was shown.
      if (!body.checkoutUrl) {
        throw new Error("Checkout is temporarily unavailable. Please try again.");
      }
      track("checkout_started", { quoteId });
      window.location.assign(body.checkoutUrl);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Checkout failed");
    }
  }

  return (
    <div className="stack" style={{ gap: "var(--space-2)" }}>
      {TURNSTILE_SITE_KEY ? <div ref={widgetRef} aria-hidden="true" /> : null}
      <button className="btn btn-take btn-block" onClick={checkout} disabled={busy}>
        {busy ? "Opening checkout…" : "Continue to payment"}
      </button>
      {error ? <p className="field-error small" style={{ margin: 0 }}>{error}</p> : null}
    </div>
  );
}
