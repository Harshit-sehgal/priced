import Link from "next/link";
import { getViewer } from "@/lib/auth";
import { SignOutButton } from "@/components/SignOutButton";

export async function SiteHeader() {
  let handle: string | null = null;
  try {
    const { user, profile } = await getViewer();
    if (user && profile) handle = profile.handle;
  } catch {
    // auth not configured (demo mode) — stay anonymous
  }

  return (
    <header className="site-header">
      <div className="shell site-header-inner">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)", flex: 1, minWidth: 0 }}>
          <Link href="/" className="wordmark">
            Priced<span className="tick">.</span>
          </Link>
        </div>
        <nav style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }}>
          {/* The premise has to be reachable from every page, not only the
              homepage hero — most inbound traffic lands on a shared tag or
              receipt link and never sees the front page. */}
          <Link href="/about" className="small mono">
            what is this?
          </Link>
          {handle ? (
            <>
              <span className="mono small">@{handle}</span>
              <SignOutButton />
            </>
          ) : (
            <Link href="/login" className="btn btn-sm">
              Log in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
