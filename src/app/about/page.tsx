import Link from "next/link";

// See src/app/login/page.tsx: the proxy reads cookies on every matched route,
// and OpenNext 500s a prerendered page that goes dynamic at request time.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "What this is",
  description:
    "Priced is a public game where people pay to be the temporary symbolic holder of a familiar domain's price tag. Not the actual domain.",
};

export default function AboutPage() {
  return (
    <article className="stack-lg" style={{ maxWidth: 760 }}>
      <section className="stack">
        <p className="eyebrow">What this is</p>
        <h1 className="display display-hero">It&apos;s a price tag. That&apos;s the whole thing.</h1>
        <p className="muted" style={{ maxWidth: 640, margin: 0 }}>
          Priced puts a price on familiar internet domains. You pay the asking price, and this
          website shows your handle on that tag until somebody pays more and takes it from you.
          <strong> Not the actual domain.</strong> Just the tag.
        </p>
      </section>

      <section className="section-rule stack">
        <h2 className="display display-section">How it works</h2>
        <ol className="stack" style={{ paddingLeft: "1.2rem", margin: 0 }}>
          <li>
            <strong>Find a tag.</strong> Search any domain. Unclaimed tags start at <span className="money">$5</span>.
          </li>
          <li>
            <strong>Pay the asking price.</strong> Not a bid — there is no auction and nothing to
            outbid. There is one price, the site tells you what it is, and you either pay it or you
            don&apos;t.
          </li>
          <li>
            <strong>You&apos;re the holder.</strong> Your handle sits on the tag. You get a public
            profile, one link of your choosing, a permanent line in the ledger, a shareable card,
            and numbers telling you how many people looked.
          </li>
          <li>
            <strong>Then somebody takes it.</strong> The price goes up, they pay it, the tag is
            theirs. Your name stays in the history forever. You get nothing else.
          </li>
        </ol>
      </section>

      <section className="section-rule stack">
        <h2 className="display display-section">The price only goes one way</h2>
        <p>
          Every takeover raises the price by the greater of <span className="money">$5</span> or 1%
          of the current price. So a <span className="money">$5</span> tag becomes{" "}
          <span className="money">$10</span>, then <span className="money">$15</span>. A{" "}
          <span className="money">$4,280</span> tag goes up by <span className="money">$42.80</span>.
        </p>
        <p className="small muted" style={{ margin: 0 }}>
          The rule is fixed and the server decides the number, not you. Prices never go down, tags
          are never delisted, and nobody gets a discount for asking nicely.
        </p>
      </section>

      <section className="section-rule stack">
        <h2 className="display display-section">What you are actually buying</h2>
        <p>
          The right for <em>this website</em> to display your handle on a tag, and to keep your name
          in its history. That is the entire product. It is a status marker on a made-up
          leaderboard, and it is meant to be funny.
        </p>
        <div className="notice">
          <strong>You do not get:</strong> the domain, the website, DNS, the trademark, the company,
          any equity, any affiliation with whoever really runs it, or any right to speak for them.
          Holding <span className="mono">google.com</span> here does not make you Google. It makes
          you someone who paid us money to have a joke displayed.
        </div>
      </section>

      <section className="section-rule stack">
        <h2 className="display display-section">Nobody gets paid out</h2>
        <p>
          When your tag is taken, you receive <strong>nothing</strong>. Not your money back, not a
          cut of the new price, not a share of anything. This is not an investment, a resale market,
          a token, or a way to make money. If you are hoping to flip a tag for profit, there is no
          mechanism for that and there never will be.
        </p>
        <p className="small muted" style={{ margin: 0 }}>
          Spend what a joke is worth to you, and not a rupee more.
        </p>
      </section>

      <section className="section-rule stack">
        <h2 className="display display-section">When you get your money back</h2>
        <p>
          Automatically, if the takeover didn&apos;t happen. If somebody beat you to the tag while
          your payment was going through, or the amount didn&apos;t match the asking price, the
          charge is refunded on its own — you do not have to ask. You never pay for a takeover you
          didn&apos;t get.
        </p>
        <p className="small muted" style={{ margin: 0 }}>
          A takeover that <em>did</em> happen is not refundable just because somebody later took the
          tag from you. That was always going to happen. It&apos;s the game.{" "}
          <Link href="/refunds">Full refund policy</Link>.
        </p>
      </section>

      <section className="section-rule stack">
        <h2 className="display display-section">Some tags are off limits</h2>
        <p>
          A small blocklist keeps tags that could be used to impersonate someone dangerous — banks,
          wallets, government sites — out of the game. Handles that pretend to be staff or to be us
          are refused too. If a tag or a handle is being used to mislead people,{" "}
          <Link href="/terms">tell us</Link> and it comes down.
        </p>
      </section>

      <section className="notice">
        <strong>Right now this is a beta.</strong> It runs on free infrastructure with test
        payments while the money path is being proven end to end. Before a single real rupee or
        dollar changes hands, the legal documents get a professional review and the operating
        entity, jurisdiction and support contact get named properly. Until then, treat everything
        here as a public experiment that happens to have a checkout button.
      </section>
    </article>
  );
}
