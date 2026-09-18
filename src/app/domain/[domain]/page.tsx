import type { Metadata } from "next";
import Link from "next/link";
import { money, quoteFor } from "@/lib/game.ts";
import { getDomain, getDomainForDisplay, getProfileByHandle, isDomainReserved, listSalesForDomain, type RepoDomain } from "@/lib/repo";
import { TakeoverCTA } from "@/components/TakeoverCTA";
import { HistoryLedger } from "@/components/HistoryLedger";
import { LiveRefresh } from "@/components/LiveRefresh";
import { HolderCta } from "@/components/HolderCta";
import { holderCtaVisible } from "@/lib/cta";
import { persistViewEvent } from "@/lib/view-events";
import { safeDecodeURIComponent } from "@/lib/navigation";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ domain: string }> };

// Provenance ledger page size. The ledger is labelled truncated when the slice
// is full, so its totals and "oldest" line are never presented as all-time.
const LEDGER_PAGE_SIZE = 30;

async function loadDomain(raw: string): Promise<{ canonical: string | null; reason: string; row: RepoDomain | null; sales: Awaited<ReturnType<typeof listSalesForDomain>> }> {
  const { evaluateDomain } = await import("@/lib/domains.ts");
  const evalResult = evaluateDomain(safeDecodeURIComponent(raw));
  if (!evalResult.eligible || !evalResult.canonicalDomain) {
    // Reserved domains have a canonical form but are ineligible — surface them
    // as a dedicated "unavailable" state instead of the generic error page.
    // Display reads are tolerant, so a domain reserved AFTER it had sales still
    // shows its immutable ledger (strict reads throw for reserved tags).
    if (evalResult.reason === "reserved" && evalResult.canonicalDomain) {
      const canonical = evalResult.canonicalDomain;
      const [row, sales] = await Promise.all([
        getDomainForDisplay(canonical),
        listSalesForDomain(canonical, LEDGER_PAGE_SIZE),
      ]);
      return { canonical, reason: "reserved", row, sales };
    }
    return { canonical: null, reason: evalResult.reason, row: null, sales: [] };
  }
  const canonical = evalResult.canonicalDomain;
  // DB-backed reserved check: domains in reserved_domains must surface as
  // unavailable (no CTA, noindex). Keep holder/history visible when the
  // domain was reserved after sales existed, so the ledger stays honest.
  const [reservedInDb, row, sales] = await Promise.all([
    isDomainReserved(canonical),
    getDomain(canonical),
    listSalesForDomain(canonical, LEDGER_PAGE_SIZE),
  ]);
  if (reservedInDb) {
    return { canonical, reason: "reserved", row, sales };
  }
  return { canonical, reason: evalResult.reason, row, sales };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { domain } = await params;
  const { canonical, reason, row } = await loadDomain(domain);
  if (!canonical) return { title: "Unknown domain" };
  if (reason === "reserved") {
    return {
      title: `${canonical} is reserved`,
      description: `${canonical} is reserved by the operator and cannot be claimed on Priced.`,
      robots: { index: false, follow: true },
    };
  }
  if (!row || !row.holderUserId) {
    return {
      title: `${canonical} is unclaimed · $5 first claim`,
      description: `Nobody holds ${canonical}'s tag on Priced yet. First claim costs $5.`,
      // Empty generated pages stay out of the index (§38).
      robots: { index: false, follow: true },
    };
  }
  return {
    title: `${canonical} is ${money(row.priceCents)} · held by @${row.holderHandle}`,
    description: `@${row.holderHandle} currently holds the ${canonical} tag on Priced for ${money(row.priceCents)}. Not the actual domain.`,
  };
}

export default async function DomainPage({ params }: Params) {
  const { domain } = await params;
  const { canonical, reason, row, sales } = await loadDomain(domain);

  if (!canonical) {
    return (
      <div className="stack">
        <h1 className="display display-section">That&apos;s not a domain we can price.</h1>
        <p className="muted">Rejected input: <span className="mono">{reason}</span></p>
        <Link href="/" className="btn">Back to the market</Link>
      </div>
    );
  }

  const unclaimed = !row || !row.holderUserId;
  const reserved = reason === "reserved";
  // Holder analytics input: a claimed, non-reserved tag render counts as a
  // tag view (best-effort, never blocks render). persistViewEvent drops bot
  // traffic and collapses repeat (IP, domain) renders — including every
  // LiveRefresh-driven re-render — into one row per dedup window.
  if (!unclaimed && !reserved) {
    await persistViewEvent({
      event: "tag_viewed",
      resource: `domain:${canonical}`,
      domain: canonical,
      handle: row?.holderHandle ?? null,
    });
  }
  // Holder's public CTA (bio/CTA live on the profile; shown here so a
  // holding actually generates exposure for its holder). Suspension hides the
  // profile page, so holderCtaVisible() hides the profile's outbound CTA here
  // too. The handle itself stays visible: holdings are ledger truth.
  const holderProfile = !unclaimed && row?.holderHandle
    ? await getProfileByHandle(row.holderHandle).catch(() => null)
    : null;
  const quote = quoteFor({
    domain: canonical,
    holder: row?.holderHandle ?? null,
    priceCents: row?.priceCents ?? 0,
    version: row?.version ?? 0,
    history: [],
  });

  return (
    <div className="stack-lg">
      <LiveRefresh />
      <section className="stack">
        <p className="eyebrow">Priced tag</p>
        <h1 className="display display-domain">{canonical}</h1>

        {reserved ? (
          <div className="panel" style={{ borderColor: "var(--danger, #c0392b)" }}>
            <div className="panel-header">
              <span className="eyebrow">Unavailable</span>
              <span className="small muted">operator-reserved</span>
            </div>
            <div className="panel-body stack">
              <p className="muted" style={{ margin: 0 }}>
                This tag has been reserved by the operator and cannot be claimed. Impersonation and sensitive
                identity domains are permanently held off-market.
              </p>
            </div>
          </div>
        ) : unclaimed ? (
          <div className="panel unclaimed-bg">
            <div className="panel-header">
              <span className="eyebrow">Unclaimed</span>
              <span className="small muted">nobody holds this tag yet</span>
            </div>
            <div className="panel-body stack">
              <p className="muted" style={{ margin: 0 }}>
                Nobody holds this tag yet. First claim sets the market.
              </p>
              <div className="row-split">
                <span className="eyebrow">Minimum first claim</span>
                <span className="money money-big">{money(quote.nextPriceCents)}</span>
              </div>
              <TakeoverCTA
                domain={canonical}
                priceCents={quote.nextPriceCents}
                kind="claim"
              />
            </div>
          </div>
        ) : (
          <div className="stack">
            <div className="row-split">
              <div className="stack" style={{ gap: "var(--space-1)" }}>
                <span className="eyebrow">Current holder</span>
                <Link href={`/u/${row?.holderHandle}`} className="holder-chip" style={{ textDecoration: "none" }}>
                  <span className="holder-dot" />
                  @{row?.holderHandle}
                </Link>
                {holderCtaVisible(holderProfile) && holderProfile?.ctaLabel && holderProfile?.ctaUrl ? (
                  <div className="stack" style={{ gap: "var(--space-1)" }}>
                    <HolderCta label={holderProfile.ctaLabel} url={holderProfile.ctaUrl} handle={holderProfile.handle} />
                    <span className="small muted" style={{ fontSize: 11 }}>
                      the holder&apos;s link, not {canonical}&apos;s
                    </span>
                  </div>
                ) : null}
              </div>
              <div className="stack" style={{ gap: "var(--space-1)", textAlign: "right" }}>
                <span className="eyebrow">Current price</span>
                <span className="money money-hero">{money(row!.priceCents)}</span>
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <span className="eyebrow">Next takeover</span>
                <span className="small muted">pay what you want above the minimum</span>
              </div>
              <div className="panel-body stack">
                <div className="row-split">
                  <span className="money money-big money-up">{money(quote.nextPriceCents)}</span>
                  <span className="small muted">minimum offer; previous holder gets nothing</span>
                </div>
                <TakeoverCTA
                  domain={canonical}
                  priceCents={quote.nextPriceCents}
                  kind="takeover"
                  expectedVersion={row!.version}
                />
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <span className="eyebrow">How this price is calculated</span>
              </div>
              <div className="panel-body">
                <div className="calc-grid">
                  <span>Current price</span>
                  <span className="dots" />
                  <span className="money">{money(quote.currentPriceCents)}</span>

                  <span>1% of current</span>
                  <span className="dots" />
                  <span className="money">{money(quote.percentIncrementCents)}</span>

                  <span>Minimum increase</span>
                  <span className="dots" />
                  <span className="money">{money(quote.minimumIncrementCents)}</span>

                  <span className="calc-total">Required increase</span>
                  <span className="dots calc-total" />
                  <span className="money calc-total">{money(quote.requiredIncrementCents)}</span>

                  <span className="calc-total">Next price</span>
                  <span className="dots calc-total" />
                  <span className="money calc-total money-up">{money(quote.nextPriceCents)}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="section-rule stack">
        <h2 className="display display-section">Tag History</h2>
        <HistoryLedger sales={sales} truncated={sales.length >= LEDGER_PAGE_SIZE} />
      </section>

      <section className="notice">
        <strong>What is this?</strong> A public game. Paying makes this website show your handle on
        {` ${canonical}'s`} price tag until someone pays more. You are not buying the domain,
        the website, or anything it represents.
      </section>
    </div>
  );
}
