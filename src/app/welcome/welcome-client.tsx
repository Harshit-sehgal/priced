"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { sanitizeInternalPath } from "@/lib/navigation";

function WelcomeInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = sanitizeInternalPath(params.get("next"));
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/handle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle, next }),
      });
      const body = (await res.json().catch(() => ({}))) as { reason?: string; error?: string; next?: unknown };
      if (!res.ok) {
        // Why: every non-2xx used to render the raw machine string
        // ("invalid_handle") and an unhandled fetch rejection left the button
        // disabled forever with no error at all.
        const messages: Record<string, string> = {
          HANDLE_TAKEN: "That handle is taken.",
          INVALID_HANDLE: "Handles are 3–20 characters: lowercase letters, numbers, underscore.",
          HANDLE_LOCKED: "Your handle is permanent and cannot be changed.",
        };
        setError(messages[body.reason ?? ""] ?? body.error ?? "Could not save handle.");
        return;
      }
      const target = typeof body.next === "string" ? sanitizeInternalPath(body.next) : next;
      router.push(target);
    } catch {
      setError("Could not save handle. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ maxWidth: 520 }}>
      <p className="eyebrow">One-time setup</p>
      <h1 className="display display-section">Pick your public handle.</h1>
      <p className="muted">
        This is the name shown on every tag you hold. It cannot be changed later, because the
        ledger is permanent.
      </p>
      <form className="field" onSubmit={submit}>
        <label htmlFor="handle">Public handle</label>
        <input
          id="handle"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="lowercase, 3 to 20 chars, a-z 0-9 _"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Continue"}
        </button>
        {error ? <p className="field-error">{error}</p> : null}
      </form>
    </div>
  );
}

export function WelcomeClient() {
  return (
    <Suspense fallback={null}>
      <WelcomeInner />
    </Suspense>
  );
}
