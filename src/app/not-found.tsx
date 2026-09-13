import Link from "next/link";

// The auth proxy may refresh a session cookie before an unknown route reaches
// the App Router. Keep the custom 404 compatible with that request-time work
// instead of letting OpenNext fail with a static-to-dynamic error.
export const dynamic = "force-dynamic";

export default function NotFound() {
  return (
    <div className="stack" style={{ maxWidth: 560 }}>
      <p className="eyebrow">404 · Not found</p>
      <h1 className="display display-section">Nothing here has a price yet.</h1>
      <p className="muted">
        That page doesn&apos;t exist. The market does. Try a domain or head back to the leaderboard.
      </p>
      <Link href="/" className="btn">
        Back to the market
      </Link>
    </div>
  );
}
