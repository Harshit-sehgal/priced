import Link from "next/link";
import { money } from "@/lib/game.ts";
import { getDomainForDisplay, getQuote } from "@/lib/repo";
import { nowMs } from "@/lib/time.ts";
import { CheckoutButton } from "@/components/CheckoutButton";
import { LiveRefresh } from "@/components/LiveRefresh";
import { QuoteCountdown } from "@/components/QuoteCountdown";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ quoteId: string }> };

export default async function TakeoverPage({ params }: Params) {
  const { quoteId } = await params;
  const quote = await getQuote(quoteId);

  if (!quote) {
    return (
      <div className="stack">
        <h1 className="display display-section">Quote not found.</h1>
        <Link href="/" className="btn">Back to the market</Link>
      </div>
    );
  }

  if (quote.status === "consumed") {
    return (
      <div className="stack">
        <h1 className="display display-section">This quote was already used.</h1>
        <p className="muted">If you paid, your takeover is recorded. Check the domain page.</p>
        <Link href={`/domain/${quote.domain}`} className="btn">View {quote.domain}</Link>
      </div>
    );
  }

  if (quote.status === "stale" || quote.status === "expired" || quote.status === "cancelled") {
    return (
      <div className="stack">
        <h1 className="display display-section">This quote is no longer valid.</h1>
        <p className="muted">Prices move. Get a fresh quote on the domain page.</p>
        <Link href={`/domain/${quote.domain}`} className="btn">Get a new price</Link>
      </div>
    );
  }

  const expired = new Date(quote.expiresAt).getTime() < nowMs();
  if (expired) {
    return (
      <div className="stack">
        <h1 className="display display-section">Quote expired.</h1>
        <p className="muted">Quotes last five minutes so prices stay honest. Get a fresh one.</p>
        <Link href={`/domain/${quote.domain}`} className="btn">Get a new price</Link>
      </div>
    );
  }

  // The market moved since this quote (another tab or challenger finalized).
  // Say so before the buyer pays for a takeover that can only be refunded.
  const live = await getDomainForDisplay(quote.domain);
  if ((live?.version ?? 0) !== quote.expectedVersion) {
    return (
      <div className="stack">
        <h1 className="display display-section">This tag changed hands.</h1>
        <p className="muted">
          {quote.domain} was taken after you got this price
          {live?.holderHandle ? <> and is now held by <span className="mono">@{live.holderHandle}</span></> : null}.
          Nothing was charged.
        </p>
        <Link href={`/domain/${quote.domain}`} className="btn">Get a new price</Link>
      </div>
    );
  }

  return (
    <div className="stack-lg" style={{ maxWidth: 640 }}>
      <LiveRefresh />
      <section className="stack">
        <p className="eyebrow">Confirm your takeover</p>
        <h1 className="display display-section">{quote.domain}</h1>
        {quote.currentPriceCents > 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            You choose the offer. The current holder receives nothing.
          </p>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            First claim. You choose the opening price.
          </p>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="eyebrow">Order</span>
          <span className="small muted mono">
            <QuoteCountdown expiresAt={quote.expiresAt} />
          </span>
        </div>
        <div className="panel-body">
          <div className="calc-grid">
            <span>Current price</span>
            <span className="dots" />
            <span className="money">{quote.currentPriceCents === 0 ? "—" : money(quote.currentPriceCents)}</span>
            <span>Minimum offer</span>
            <span className="dots" />
            <span className="money">{money(quote.minimumPriceCents)}</span>
            <span className="calc-total">Your offer</span>
            <span className="dots calc-total" />
            <span className="money calc-total money-up">{money(quote.nextPriceCents)}</span>
          </div>
        </div>
      </section>

      <CheckoutButton quoteId={quote.id} domain={quote.domain} />
      <Link href={`/domain/${quote.domain}`} className="small" style={{ alignSelf: "flex-start" }}>
        Change offer
      </Link>

      <section className="notice">
        <strong>You are buying:</strong> temporary symbolic holder status for {quote.domain}&apos;s
        tag on Priced. Not the domain registration, not DNS, not the company,
        not equity, not affiliation. Once taken, a tag is not refundable merely because somebody
        later takes it from you.
      </section>
    </div>
  );
}
