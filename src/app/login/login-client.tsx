"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { track } from "@/lib/analytics";

function LoginInner() {
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const urlError = params.get("error");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [error, setError] = useState<string | null>(urlError);

  useEffect(() => {
    fetch("/api/auth/mode")
      .then((r) => r.json())
      .then((d) => setDemoMode(Boolean(d.demo)))
      .catch(() => {});
  }, []);

  async function loginWithProvider(provider: "google") {
    setBusy(true);
    setError(null);
    track("login_started", { provider });
    try {
      const { createAuthBrowserClient } = await import("@/lib/auth-browser");
      const client = await createAuthBrowserClient();
      const { error } = await client.auth.signInWithOAuth({
        provider,
        options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
      });
      if (error) {
        setError(error.message);
        setBusy(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed. Please try again.");
      setBusy(false);
    }
  }

  async function loginWithMagicLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setBusy(true);
    setError(null);
    track("login_started", { provider: "magic_link" });
    try {
      const { createAuthBrowserClient } = await import("@/lib/auth-browser");
      const client = await createAuthBrowserClient();
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
      });
      if (error) {
        setError(error.message);
        return;
      }
      setSent(true);
    } catch (e) {
      // An unhandled rejection here used to leave the button disabled forever
      // with no message; AUTH_NOT_CONFIGURED is the demo-mode case.
      const msg = e instanceof Error ? e.message : "";
      setError(
        msg === "AUTH_NOT_CONFIGURED"
          ? "Email login isn't configured on this deployment. Use Google instead."
          : "Could not send the login link. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="stack">
        <h1 className="display display-section">Check your inbox</h1>
        <p className="muted">We sent a login link to {email}. Click it to continue your takeover.</p>
      </div>
    );
  }

  return (
    <div className="stack" style={{ maxWidth: 480 }}>
      <p className="eyebrow">Authentication</p>
      <h1 className="display display-section">Hold on. Prices move fast.</h1>
      <p className="muted">
        Log in to take tags. Browsing stays free and anonymous.
      </p>

      {demoMode ? (
        <div className="notice">
          <strong>Demo mode:</strong> auth isn&apos;t configured here. You&apos;ll browse as the
          demo buyer and checkout is simulated. Configure Supabase Auth for real logins.
        </div>
      ) : null}

      <button className="btn btn-primary btn-block" disabled={busy} onClick={() => loginWithProvider("google")}>
        Continue with Google
      </button>
      <div className="row-split small muted"><span>or</span></div>
      <form className="field" onSubmit={loginWithMagicLink}>
        <label htmlFor="email">Email · magic link</label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
        <button className="btn btn-block" type="submit" disabled={busy}>
          Send login link
        </button>
      </form>
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  );
}

export function LoginClient() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
