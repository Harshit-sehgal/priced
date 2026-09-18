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

function parseAmountCents(input: string): number | null {
  const value = input.trim();
  if (!/^\d+(?:\.\d{0,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export function TakeoverCTA({ domain, priceCents, kind, expectedVersion }: Props) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "quoting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState((priceCents / 100).toFixed(2));

  async function take() {
    const amountCents = parseAmountCents(amount);
    if (amountCents == null) {
      setState("error");
      setError("Enter a valid amount with up to two decimal places.");
      return;
    }
    setState("quoting");
    setError(null);
    try {
      // Server creates the authoritative quote (price + version pinned there).
      const res = await fetch("/api/quotes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain, amountCents }),
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
        if (code === "OFFER_TOO_LOW") throw new Error(`Your offer must be at least ${money(priceCents)}.`);
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
      <label className="field" style={{ gap: "var(--space-1)" }}>
        <span className="eyebrow">Your offer</span>
        <span className="small muted">
          Minimum {money(priceCents)}. You can pay more if you want to support the tag.
        </span>
        <span style={{ display: "flex", alignItems: "center", border: "2px solid var(--rule)", background: "var(--paper-raised)" }}>
          <span aria-hidden="true" style={{ paddingLeft: 14, fontFamily: "var(--font-mono)", fontSize: 16 }}>$</span>
          <input
            inputMode="decimal"
            type="text"
            style={{ border: 0, flex: 1, minWidth: 0, background: "transparent" }}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-label={`Your offer for ${domain}`}
            placeholder={(priceCents / 100).toFixed(2)}
            disabled={state === "quoting"}
          />
        </span>
      </label>
      <button
        className="btn btn-take btn-block"
        onClick={take}
        disabled={state === "quoting"}
        aria-live="polite"
      >
        {state === "quoting"
          ? "Preparing your offer…"
          : kind === "claim"
            ? "Continue with this offer"
            : "Continue with this offer"}
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
