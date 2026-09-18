import Link from "next/link";

// See src/app/login/page.tsx: the proxy reads cookies on every matched route,
// and OpenNext 500s a prerendered page that goes dynamic at request time.
export const dynamic = "force-dynamic";

export const metadata = { title: "Refund Policy" };

export default function RefundsPage() {
  return (
    <article className="stack" style={{ maxWidth: 760 }}>
      <p className="eyebrow">Legal</p>
      <h1 className="display display-section">Refund Policy</h1>
      <p className="small muted">
        Short version: if the takeover didn&apos;t happen, your money comes back on its own. If it did
        happen, it doesn&apos;t.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>You never pay for a takeover you didn&apos;t get</h2>
      <p>
        Payments are only applied when the takeover actually completes. If it doesn&apos;t, the charge
        is refunded <strong>automatically</strong> — you do not have to ask, and you do not have to
        notice. That covers:
      </p>
      <ul className="stack" style={{ paddingLeft: "1.2rem", margin: 0 }}>
        <li>
          <strong>Somebody beat you to it.</strong> The tag changed hands while your payment was
          going through, so your quote was out of date.
        </li>
        <li>
          <strong>The amount didn&apos;t match</strong> the offer you selected, or arrived in a currency
          we do not settle in.
        </li>
        <li>
          <strong>The tag became unavailable</strong> — for example it was added to the blocklist
          between your quote and your payment.
        </li>
        <li>
          <strong>We reserve a tag you already hold.</strong> If the operator adds a tag you hold to
          the blocklist to stop it being used to mislead people, the last payment for that tag is
          refunded.
        </li>
        <li>
          <strong>Something broke on our side</strong> after the charge but before the takeover.
        </li>
      </ul>
      <p className="small muted" style={{ margin: 0 }}>
        Refunds go back to the original payment method through our payment provider. How quickly it
        appears is up to your bank, not us — typically a few business days.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>A completed takeover is not refundable</h2>
      <p>
        Once the tag is yours, the payment is final. It is <strong>not</strong> refundable because
        somebody later took the tag from you — that is the entire game, it was always going to
        happen, and it is stated everywhere on this site before you pay. You bought temporary holder
        status and the duration was never guaranteed. The one exception is above: if the operator
        reserves the tag for safety, the last payment is refunded.
      </p>
      <p className="small muted" style={{ margin: 0 }}>
        You also do not get a refund for regretting it, for the price rising, or for the tag turning
        out to be less funny than you hoped. <Link href="/about">Read what you are buying</Link>{" "}
        before you buy it.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>Billing mistakes</h2>
      <p>
        Genuine errors — a duplicate charge, a provider fault, a charge you did not make — are
        reviewed and corrected. Tell us what happened and we will look at the actual payment record
        rather than guess. Every payment and refund is logged against a provider reference, so this
        is usually quick to settle.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>If a refund fails</h2>
      <p>
        Refunds are tracked in their own ledger and retried. If one cannot be completed
        automatically it is flagged for a human rather than quietly dropped, and we resolve it with
        the provider. A refund we owe you does not stop being owed because an API call failed.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>Chargebacks</h2>
      <p>
        If something is wrong, please ask us first — it is faster than a chargeback and we can
        usually just fix it. Disputes raised with your bank are recorded and answered. Using
        chargebacks to reverse takeovers you intended to make is payment fraud under the{" "}
        <Link href="/terms">Terms</Link> and ends the account.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>Getting in touch</h2>
      <p>
        During the beta, the channel is the repository issue tracker. A private billing-support
        address is published before real-money payments are enabled.{" "}
        <strong>
          Never post card details, full provider references, or other private billing information in
          a public issue.
        </strong>
      </p>

      <p className="small muted">
        Plain-language beta policy, not a lawyer-reviewed document. Nothing here limits refund or
        consumer rights you have by law or through your payment provider.
      </p>
    </article>
  );
}
