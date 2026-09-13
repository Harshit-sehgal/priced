"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { money } from "@/lib/game.ts";

type Props = {
  domain: string;
  priceCents: number;
  kind: "claim" | "takeover";
  expectedVersion?: number;
};

export function TakeoverCTA({ domain, priceCents, kind, expectedVersion }: Props) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "quoting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function take() {
    setState("quoting");
    setError(null);
    try {
      // Server creates the authoritative quote (price + version pinned there).
      const res = await fetch("/api/quotes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      if (res.status === 401) {
        router.push(`/login?next=${encodeURIComponent(`/domain/${domain}`)}`);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          code?: string;
          error?: string;
        };
        const code = body.code;
        if (code === "NO_HANDLE" || code === "PROFILE_REQUIRED") {
          router.push(`/welcome?next=${encodeURIComponent(`/domain/${domain}`)}`);
          return;
        }
        // These codes arrive with different statuses (SUSPENDED is 403,
        // INELIGIBLE 422, ALREADY_HOLDER 409), so key off the code, not the
        // status — the old 409-only branch made two of these messages dead.
        if (code === "SUSPENDED") throw new Error("Your account is suspended and cannot take tags.");
        if (code === "ALREADY_HOLDER") throw new Error("You already hold this tag.");
        if (code === "INELIGIBLE") throw new Error("This domain cannot be claimed.");
        throw new Error(body.error ?? code ?? `quote failed (${res.status})`);
      }
      const { quoteId } = (await res.json()) as { quoteId: string };
      router.push(`/takeover/${quoteId}`);
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "Something went wrong");
    }
  }

  return (
    <div className="stack" style={{ gap: "var(--space-2)" }}>
      <button
        className="btn btn-take btn-block"
        onClick={take}
        disabled={state === "quoting"}
        aria-live="polite"
      >
        {state === "quoting"
          ? "Getting your price…"
          : kind === "claim"
            ? `Claim for ${money(priceCents)}`
            : `Take it for ${money(priceCents)}`}
      </button>
      {error ? <p className="field-error small" style={{ margin: 0 }}>{error}</p> : null}
      {expectedVersion != null ? (
        <p className="small muted" style={{ margin: 0 }}>
          If someone takes it before you pay, you&apos;ll be refunded automatically.
        </p>
      ) : null}
    </div>
  );
}
