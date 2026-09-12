import Link from "next/link";

export const metadata = { title: "Terms of Service" };

export default function TermsPage() {
  return (
    <article className="stack" style={{ maxWidth: 760 }}>
      <p className="eyebrow">Legal</p>
      <h1 className="display display-section">Terms of Service</h1>
      <p className="small muted">
        Plain language, on purpose. These are the working terms for the beta. They get replaced by
        professionally reviewed documents before real money is accepted — see{" "}
        <a href="#status">Status of these terms</a> at the bottom.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>1. What you are buying</h2>
      <p>
        Priced is a public game. Paying the asking price buys{" "}
        <strong>temporary symbolic holder status</strong> on a domain&apos;s price tag as displayed
        on this website, and a permanent line in this website&apos;s history. It lasts until
        somebody else pays the next price. That is the entire product.{" "}
        <Link href="/about">Longer explanation here</Link>.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>2. What a payment does not transfer</h2>
      <p>
        No domain registration, no DNS control, no website, no trademark, no copyright, no company
        ownership, no equity, no affiliation, no endorsement, and no authority to represent whoever
        actually operates the domain. <strong>Not the actual domain.</strong> You must not claim or
        imply otherwise anywhere on this site, including in your handle, display name, bio or link.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>3. The market rules</h2>
      <p>
        Unclaimed tags start at <span className="money">$5.00</span>. Each takeover raises the price
        by the greater of <span className="money">$5.00</span> or 1% of the current price, rounded
        up to the next cent. The challenger pays the full new price. There is no bidding, no
        auction, and no negotiation. The current holder cannot take their own tag. Prices are quoted
        and settled in <strong>US dollars</strong> only; a payment settled in another currency is
        refunded rather than applied.
      </p>
      <p className="small muted" style={{ margin: 0 }}>
        The price is calculated by the server and the server&apos;s number is the one that counts. A
        quote is held briefly while you pay; if it goes stale, see{" "}
        <Link href="/refunds">Refunds</Link>.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>4. Nobody gets paid out</h2>
      <p>
        When your tag is taken, you receive <strong>nothing</strong> — not a refund, not a share of
        the new price, not anything. This is not an investment, a security, a resale market, a
        token, or a revenue-sharing product, and nothing here should be read as an offer of one. Do
        not spend money you would mind losing.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>5. Your account and handle</h2>
      <p>
        You need an account to hold a tag, and you pick one public handle. The handle is{" "}
        <strong>permanent</strong> — it cannot be changed or transferred, so choose it knowing it is
        public forever. Handles that impersonate staff, the site itself, or any person or brand are
        refused or removed. One person, one account; do not share or sell accounts.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>6. Your profile link</h2>
      <p>
        A holder may attach one label and one <span className="mono">https</span> link. It is
        yours, it is clearly yours, and it must not pretend to belong to the domain on the tag.
        Links to malware, phishing, or anything unlawful are removed and the account suspended. We
        do not endorse anything a holder links to.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>7. Tags we keep out of the game</h2>
      <p>
        Some domains are blocked because a tag on them could be used to mislead — banks, crypto
        wallets, government and similar. We may add to that list at any time, including after a tag
        is already held, when something is being used to deceive people. If that removes a tag you
        hold, you get your last payment back.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>8. Conduct</h2>
      <p>
        No impersonation of people or brands. No unlawful or infringing use. No payment fraud or
        chargeback abuse. No automated abuse of the site, including scripted takeovers, scraping
        beyond ordinary browsing, or attempts to interfere with the market or other users. We may
        suspend accounts, reserve domains, and remove content to enforce this.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>9. Takedowns and complaints</h2>
      <p>
        If you operate a domain and want its tag removed, or a handle or link is impersonating you,
        say so and we will act on it. During the beta the channel is the repository issue tracker; a
        proper contact address is published before real-money launch.{" "}
        <strong>Never post payment details or private billing information in a public issue.</strong>
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>10. Availability</h2>
      <p>
        This is a beta running on free infrastructure. It may be slow, interrupted, or taken down
        entirely, and market data may be reset during the beta. Nothing here is guaranteed to keep
        existing.
      </p>

      <h2 id="status" className="display" style={{ fontSize: 18 }}>
        11. Status of these terms
      </h2>
      <p>
        These are plain-language working terms, not a finished legal agreement, and they have not
        been reviewed by a lawyer. Before real money is accepted, they are replaced by documents
        reviewed under the operating jurisdiction, naming the operating entity, the governing law,
        the dispute-resolution process, and a real support address. Until then the beta runs on test
        payments. Nothing here limits consumer rights you have by law.
      </p>

      <p className="small muted">
        Last updated with the beta. Contact: repository issue tracker. See also{" "}
        <Link href="/privacy">Privacy</Link> and <Link href="/refunds">Refunds</Link>.
      </p>
    </article>
  );
}
