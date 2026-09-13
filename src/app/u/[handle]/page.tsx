import type { Metadata } from "next";
import Link from "next/link";
import { money } from "@/lib/game.ts";
import { getProfileByHandle, listDomainsForHolder, listSalesForBuyer } from "@/lib/repo";
import { isHandleValid } from "@/lib/domains.ts";
import { persistViewEvent } from "@/lib/view-events";
import { safeDecodeURIComponent } from "@/lib/navigation";
import { LiveRefresh } from "@/components/LiveRefresh";
import { HolderCta, HolderCtaInline } from "@/components/HolderCta";
import { ProfileEditor } from "@/components/ProfileEditor";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ handle: string }> };

// Holder history page size. Numbers and lists below are labelled as a window
// when the slice is full, so "all time" is never claimed over truncated data.
const SALES_PAGE_SIZE = 200;

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const h = safeDecodeURIComponent(handle).toLowerCase().replace(/^@/, "");
  if (!isHandleValid(h)) return { title: "Unknown holder", robots: { index: false } };
  const profile = await getProfileByHandle(h);
  if (!profile) {
    return {
      title: `@${h} holds nothing yet`,
      robots: { index: false },
    };
  }
  // Suspended profiles render the hidden state; their metadata must not
  // advertise them to crawlers either.
  if (profile.suspendedAt) {
    return { title: "Unknown holder", robots: { index: false, follow: false } };
  }
  const sales = await listSalesForBuyer(h, 1);
  const spent = sales.length > 0 ? `Latest: ${sales[0].domain} for ${money(sales[0].priceCents)}.` : "";
  return {
    title: `@${h} · holder profile`,
    description: `@${h}'s Priced holdings and takeover history. ${spent} Not the actual domain.`,
  };
}

export default async function HolderPage({ params }: Params) {
  const { handle } = await params;
  const h = safeDecodeURIComponent(handle).toLowerCase().replace(/^@/, "");

  if (!isHandleValid(h)) {
    return (
      <div className="stack">
        <h1 className="display display-section">That handle doesn&apos;t exist here.</h1>
        <Link href="/" className="btn">Back to the market</Link>
      </div>
    );
  }

  const profile = await getProfileByHandle(h);
  if (!profile || profile.suspendedAt) {
    return (
      <div className="stack">
        <h1 className="display display-section">@{h} holds nothing yet.</h1>
        <p className="muted">No public holder profile exists for this handle.</p>
        <Link href="/" className="btn">Back to the market</Link>
      </div>
    );
  }

  // Direct per-holder query: the market list is capped, so scanning it both
  // fetched 1000 rows per profile view and silently dropped tags beyond the
  // cap. The holder's own tags are few and this is one indexed lookup.
  const [sales, held] = await Promise.all([
    listSalesForBuyer(h, SALES_PAGE_SIZE),
    listDomainsForHolder(h),
  ]);
  const salesTruncated = sales.length >= SALES_PAGE_SIZE;
  // Holder analytics input: profile render counts a view (best-effort).
  // Guarded by persistViewEvent — bots are skipped and one (IP, handle) pair
  // counts once per dedup window, so a refresh/curl loop cannot forge numbers.
  // A skipped view still renders the page normally.
  await persistViewEvent({ event: "profile_viewed", resource: `u:${h}`, handle: h });

  const heldDomains = new Set(held.map((t) => t.domain));
  // Previously held: domains this profile ever bought but no longer holds.
  const everHeld = new Set(sales.map((s) => s.domain));
  const previouslyHeld = [...everHeld].filter((d) => !heldDomains.has(d));
  const spentCents = sales.reduce((acc, s) => acc + s.priceCents, 0);

  // Largest tag currently held.
  const largest = held.length > 0
    ? held.reduce((a, b) => (b.priceCents > a.priceCents ? b : a))
    : null;

  // Most contested tag held: most takeovers among domains this profile ever
  // bought. Computed from the buyer's own sales list (no per-domain queries):
  // a domain the profile bought multiple times was contested on their watch.
  let mostContested: { domain: string; sales: number } | null = null;
  if (sales.length > 0) {
    const counts = new Map<string, number>();
    for (const s of sales) counts.set(s.domain, (counts.get(s.domain) ?? 0) + 1);
    let top: { domain: string; sales: number } | null = null;
    for (const [domain, count] of counts) {
      if (count > 1 && (!top || count > top.sales)) top = { domain, sales: count };
    }
    if (top) mostContested = top;
  }

  // Is the viewer this profile's owner (for the editor + analytics link)?
  let isOwn = false;
  try {
    const { getViewer, isAuthConfigured, demoViewer } = await import("@/lib/auth");
    const { user } = await getViewer();
    if (user) isOwn = user.id === profile.id;
    else if (!isAuthConfigured) isOwn = demoViewer().user.id === profile.id;
  } catch {
    // auth not configured — stay anonymous
  }

  return (
    <div className="stack-lg">
      <LiveRefresh />
      <section className="stack">
        <p className="eyebrow">Holder profile</p>
        <h1 className="display display-section">@{profile.handle}</h1>
        {profile.displayName ? <p className="mono" style={{ margin: 0 }}>{profile.displayName}</p> : null}
        {profile.bio ? <p className="muted" style={{ margin: 0, maxWidth: 560 }}>{profile.bio}</p> : null}
        <div className="row-split" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <p className="muted" style={{ margin: 0 }}>
            {held.length > 0
              ? `Holds ${held.length} tag${held.length === 1 ? "" : "s"} worth ${money(held.reduce((a, t) => a + t.priceCents, 0))}.`
              : "Holds no tags right now. Someone probably took them."}
            {" "}Symbolic status only. Not the actual domain.
          </p>
          {profile.ctaLabel && profile.ctaUrl ? (
            <HolderCta label={profile.ctaLabel} url={profile.ctaUrl} handle={profile.handle} />
          ) : null}
        </div>
        {isOwn ? (
          <div className="row-split" style={{ alignItems: "center", flexWrap: "wrap", gap: "var(--space-3)" }}>
            <ProfileEditor
              initialBio={profile.bio}
              initialCtaLabel={profile.ctaLabel}
              initialCtaUrl={profile.ctaUrl}
            />
            <Link href={`/u/${h}/analytics`} className="btn btn-sm">Your analytics</Link>
          </div>
        ) : null}
      </section>

      <section className="section-rule stack">
        <div className="row-split">
          <h2 className="display display-section">Numbers</h2>
          <p className="small muted" style={{ margin: 0 }}>
            {salesTruncated
              ? `Latest ${sales.length} takeovers · ${money(spentCents)} paid in this view`
              : `${sales.length} takeover${sales.length === 1 ? "" : "s"} · ${money(spentCents)} paid into the market`}
          </p>
        </div>
        <dl className="stat-list">
          <div className="stat-row">
            <dt>Currently held</dt>
            <dd className="money">{held.length}</dd>
          </div>
          <div className="stat-row">
            <dt>Tags taken{salesTruncated ? ` (latest ${SALES_PAGE_SIZE})` : ", all time"}</dt>
            <dd className="money">{sales.length}</dd>
          </div>
          <div className="stat-row">
            <dt>Largest tag held</dt>
            <dd>{largest ? <><Link href={`/domain/${largest.domain}`} className="mono">{largest.domain}</Link> · <span className="money">{money(largest.priceCents)}</span></> : "—"}</dd>
          </div>
          <div className="stat-row">
            <dt>Most rebought tag</dt>
            <dd>{mostContested ? <><Link href={`/domain/${mostContested.domain}`} className="mono">{mostContested.domain}</Link> · bought <span className="money">{mostContested.sales}</span>× by this holder</> : "—"}</dd>
          </div>
        </dl>
      </section>

      <section className="section-rule stack">
        <h2 className="display display-section">Currently held</h2>
        {held.length === 0 ? (
          <p className="muted small">No active holdings.</p>
        ) : (
          <ul className="holding-list">
            {held.map((t) => (
              <li key={t.domain} className="row-split">
                <span>
                  <Link href={`/domain/${t.domain}`} className="mono">{t.domain}</Link>
                  {profile.ctaLabel && profile.ctaUrl ? (
                    <span className="muted small"> · <HolderCtaInline label={profile.ctaLabel} url={profile.ctaUrl} handle={profile.handle} /></span>
                  ) : null}
                </span>
                <span className="money">{money(t.priceCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {previouslyHeld.length > 0 ? (
        <section className="section-rule stack">
          <h2 className="display display-section">Previously held{salesTruncated ? ` (latest ${SALES_PAGE_SIZE})` : ""}</h2>
          <ul className="holding-list">
            {previouslyHeld.map((d) => (
              <li key={d} className="row-split">
                <Link href={`/domain/${d}`} className="mono">{d}</Link>
                <span className="small muted">lost to a challenger</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="section-rule stack">
        <h2 className="display display-section">Takeover history{salesTruncated ? ` (latest ${SALES_PAGE_SIZE})` : ""}</h2>
        {sales.length === 0 ? (
          <p className="muted small">No takeovers yet.</p>
        ) : (
          <ul className="holding-list">
            {sales.map((s) => (
              <li key={s.id} className="row-split">
                <span>
                  <Link href={`/domain/${s.domain}`} className="mono">{s.domain}</Link>
                  {" "}for <span className="money">{money(s.priceCents)}</span>
                  {s.previousHolderHandle ? (
                    <span className="muted small"> · from @{s.previousHolderHandle}</span>
                  ) : (
                    <span className="muted small"> · first claim</span>
                  )}
                </span>
                <span className="small muted">{s.createdAt.slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="notice">
        <strong>Reminder:</strong> these are symbolic price tags on a public game. Holdings do not
        include the domain, website, company, trademark, or anything the domain represents.
      </section>
    </div>
  );
}
