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
  const [adultConfirmed, setAdultConfirmed] = useState(false);
  const [ageDialogOpen, setAgeDialogOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const widgetRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (ageDialogOpen && !dialog.open) dialog.showModal();
    if (!ageDialogOpen && dialog.open) dialog.close();
  }, [ageDialogOpen]);

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
    if (!adultConfirmed) return;
    setBusy(true);
    setError(null);
    try {
      const ageRes = await fetch("/api/age-confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quoteId, adultConfirmed: true }),
      });
      const ageBody = await ageRes.json().catch(() => ({}));
      if (!ageRes.ok) {
        const message = ageBody.error === "login_required"
          ? "Sign in again before paying."
          : ageBody.error === "age_confirmation_unavailable"
            ? "Age confirmation is unavailable. Please try again later."
            : ageBody.error ?? `age confirmation failed (${ageRes.status})`;
        throw new Error(message);
      }

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
      <button
        className="btn btn-take btn-block"
        onClick={() => {
          setError(null);
          setAdultConfirmed(false);
          setAgeDialogOpen(true);
        }}
        disabled={busy}
      >
        {busy ? "Opening checkout…" : "Continue to payment"}
      </button>
      <dialog
        ref={dialogRef}
        className="age-dialog"
        aria-labelledby="age-confirmation-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) setAgeDialogOpen(false);
        }}
        onClose={() => setAgeDialogOpen(false)}
      >
        <div className="stack">
          <h2 id="age-confirmation-title" className="display" style={{ fontSize: 24, margin: 0 }}>
            Before you continue
          </h2>
          <p className="muted" style={{ margin: 0 }}>
            Only people 18 or older may make paid offers on Priced.
          </p>
          <label className="age-confirmation-check">
            <input
              type="checkbox"
              checked={adultConfirmed}
              onChange={(event) => setAdultConfirmed(event.target.checked)}
              disabled={busy}
            />
            <span>I confirm I am 18 or older.</span>
          </label>
          {error ? <p className="field-error small" role="alert" style={{ margin: 0 }}>{error}</p> : null}
          <div className="row-split">
            <button
              type="button"
              className="btn"
              onClick={() => setAgeDialogOpen(false)}
              disabled={busy}
            >
              Not now
            </button>
            <button
              type="button"
              className="btn btn-take"
              onClick={checkout}
              disabled={!adultConfirmed || busy}
            >
              {busy ? "Opening checkout…" : "Confirm and continue"}
            </button>
          </div>
        </div>
      </dialog>
      {error && !ageDialogOpen ? <p className="field-error small" role="alert" style={{ margin: 0 }}>{error}</p> : null}
    </div>
  );
}
