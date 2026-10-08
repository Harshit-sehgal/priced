"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { track } from "@/lib/analytics";

function LoginInner() {
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const urlError = params.get("error");
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
