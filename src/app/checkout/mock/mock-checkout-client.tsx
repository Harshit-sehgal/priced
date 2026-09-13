"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { money } from "@/lib/game.ts";

/**
 * Simulated payment page for the demo provider. It drives the exact production
 * path: a signed webhook payload is POSTed to /api/webhooks/payments, which
 * verifies the signature and finalizes the takeover atomically.
 */
function newDemoEventId(): string {
  return `demo_evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function MockCheckoutInner() {
  const router = useRouter();
  const params = useSearchParams();
  const quoteId = params.get("quote_id") ?? "";
  const domain = params.get("domain") ?? "";
  const amountCents = Number(params.get("amount_cents") ?? 0);
  // User-supplied query param: Number("abc") is NaN and Intl renders "$NaN".
  const amountText = Number.isFinite(amountCents) && amountCents > 0 ? money(amountCents) : "—";
  const [state, setState] = useState<"idle" | "paying" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function pay(result: "success" | "failure") {
    setState("paying");
    try {
      const eventId = newDemoEventId();
      const payload = JSON.stringify({
        id: eventId,
        type: result === "success" ? "payment_intent.succeeded" : "payment_intent.payment_failed",
        payment_intent: `demo_pi_${quoteId}`,
        metadata: {
          quote_id: quoteId,
          domain,
          amount_cents: String(Number.isFinite(amountCents) ? amountCents : 0),
        },
      });
      const sigRes = await fetch("/api/demo/sign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload }),
      });
      const sigBody = (await sigRes.json().catch(() => ({}))) as { signature?: string };
      const sig = sigBody?.signature ?? "";
      if (!sig) {
        setState("error");
        setMessage("Could not sign the demo webhook. Try again.");
        return;
      }
      const res = await fetch("/api/webhooks/payments", {
        method: "POST",
        headers: { "content-type": "application/json", "x-demo-signature": sig },
        body: payload,
      });
      const body = await res.json().catch(() => ({}));
      if (result === "failure") {
        setState("error");
        setMessage("Payment declined (simulated). No money moved.");
        return;
      }
      if (body?.result?.saleId) {
        setState("done");
        router.push(`/success/${body.result.saleId}`);
        return;
      }
      const reason = (body?.result?.reason ?? body?.error ?? "") as string;
      setState("error");
      if (reason === "stale_quote") {
        setMessage("Someone took this tag before your payment completed. A refund was issued automatically.");
      } else if (reason === "quote_expired") {
        setMessage("Your quote expired before payment settled. A refund was issued. Get a fresh price.");
      } else if (reason === "already_holder") {
        setMessage("You already hold this tag. Your payment was refunded.");
      } else if (reason === "FINALIZE_ERROR") {
        setMessage("This domain is no longer available. Your payment was refunded.");
      } else {
        setMessage(reason || "Webhook processing failed. Your payment was refunded. Check the domain page.");
      }
    } catch {
      // A dropped connection used to leave both buttons disabled on
      // "Processing…" with no way back.
      setState("error");
      setMessage("Could not reach the demo checkout. Check your connection and try again.");
    }
  }

  if (!quoteId) {
    return <p className="muted">Missing quote. Start again from a domain page.</p>;
  }

  return (
    <div className="stack" style={{ maxWidth: 560 }}>
      <p className="eyebrow">Demo checkout</p>
      <h1 className="display display-section">{domain}</h1>
      <div className="panel">
        <div className="panel-header">
          <span className="eyebrow">Simulated payment</span>
          <span className="small muted">no real money moves</span>
        </div>
        <div className="panel-body">
          <div className="row-split">
            <span className="muted">Amount</span>
            <span className="money money-big">{amountText}</span>
          </div>
        </div>
      </div>
      <div className="row-split" style={{ gap: "var(--space-3)" }}>
        <button className="btn btn-take" disabled={state === "paying"} onClick={() => pay("success")}>
          {state === "paying" ? "Processing…" : "Pay (succeed)"}
        </button>
        <button className="btn" disabled={state === "paying"} onClick={() => pay("failure")}>
          Simulate decline
        </button>
      </div>
      {message ? <p className="field-error small">{message}</p> : null}
    </div>
  );
}

export function MockCheckoutClient() {
  return (
    <Suspense fallback={null}>
      <MockCheckoutInner />
    </Suspense>
  );
}
