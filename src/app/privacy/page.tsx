import Link from "next/link";

export const metadata = { title: "Privacy Policy" };

export default function PrivacyPage() {
  return (
    <article className="stack" style={{ maxWidth: 760 }}>
      <p className="eyebrow">Legal</p>
      <h1 className="display display-section">Privacy Policy</h1>
      <p className="small muted">
        Short version: this site is a public ledger, so most of what you do here is meant to be
        seen. Your email is not. We sell nothing to anybody.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>What is public, permanently</h2>
      <p>
        Your handle, the tags you hold, every takeover you have ever made, the price you paid, and
        anything you put in your profile bio or link. The takeover history is the product — it is
        append-only and it does not get rewritten.
      </p>
      <p className="small muted" style={{ margin: 0 }}>
        Your handle is permanent and cannot be changed.{" "}
        <strong>If you want to stay anonymous, do not pick a handle that identifies you.</strong>
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>What is not public</h2>
      <p>
        Your email address, your login identity, and any moderation state on your account are not
        shown to other users and are not readable through the public API.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>What we collect</h2>
      <ul className="stack" style={{ paddingLeft: "1.2rem", margin: 0 }}>
        <li>
          <strong>Account.</strong> Whatever Google or the email magic link gives us to sign you in
          — an account id and an email address — plus the handle you choose.
        </li>
        <li>
          <strong>Payments.</strong> Provider payment and event identifiers, the amount, the
          currency, and the outcome. Enough to reconcile a charge and issue a refund, and no more.
        </li>
        <li>
          <strong>Product analytics.</strong> Which pages and tags were opened, the domain or handle
          involved, and a random per-tab session id kept in your browser&apos;s{" "}
          <span className="mono">sessionStorage</span>. It is not tied to your identity and it
          disappears when you close the tab.
        </li>
      </ul>

      <h2 className="display" style={{ fontSize: 18 }}>Your card details never reach us</h2>
      <p>
        Payment is handled entirely by our payment provider. Card numbers do not touch this site&apos;s
        servers at any point. We store the provider&apos;s reference, the amount and the currency. We
        record a one-way hash of each payment webhook so we can recognise duplicates and tampering —
        never the raw payload.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>Your IP address</h2>
      <p>
        Used transiently to rate-limit abuse, and <strong>never written to the database</strong>. It
        lives only as a short-lived counter key that expires within minutes. We do not log IP
        addresses against your account or your activity.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>Cookies and connections</h2>
      <p>
        First-party cookies for your login session, and a websocket connection so the market updates
        live while you watch it. <strong>No advertising cookies, no third-party trackers, no
        analytics vendor.</strong> The analytics above are first-party and stay in our own database.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>How long we keep things</h2>
      <p>
        Product analytics are deleted automatically after about <strong>180 days</strong>. Payment
        and refund records are kept as long as we need them for accounting and dispute handling.
        The public takeover ledger is permanent by design — it is the history the site exists to
        show.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>Deleting your account</h2>
      <p>
        Ask and we will delete your account, your email, your profile text and your link. What stays
        is the ledger: the fact that a handle took a tag at a price on a date does not get erased,
        because the market record is the product and other people&apos;s history depends on it. Decide
        whether you are comfortable with that before you buy anything.
      </p>

      <h2 className="display" style={{ fontSize: 18 }}>Where your data sits</h2>
      <p>
        The site itself runs on a global edge network, so the server that answers you is wherever
        you happen to be. Stored data is narrower: the database is hosted in{" "}
        <strong>India</strong>, the rate-limit counters in the <strong>United States</strong>, and
        payment records with our payment provider. If you are in the EU or UK, that means your data
        is processed outside it.
      </p>
      <p className="small muted" style={{ margin: 0 }}>
        During the beta the contact for any privacy request is the repository issue tracker; a real
        address is published before real-money launch.{" "}
        <strong>Never post payment details in a public issue.</strong>
      </p>

      <p className="small muted">
        This is a plain-language beta policy, not a lawyer-reviewed document — see{" "}
        <Link href="/terms">Terms</Link> for what that means. Nothing here limits data-protection
        rights you have by law.
      </p>
    </article>
  );
}
