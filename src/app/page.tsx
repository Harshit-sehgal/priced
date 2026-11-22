import type { Metadata } from "next";
import { listMarket, listRecentSales, listMostContested, listFastestRising, listNewlyClaimed, marketValueCents, seedDemoMarket } from "@/lib/repo";
import Link from "next/link";
import { money } from "@/lib/game.ts";
import { SearchBar } from "@/components/SearchBar";
import { MarketTable } from "@/components/MarketTable";
import { ActivityFeed } from "@/components/ActivityFeed";
import { MostContested } from "@/components/MostContested";
import { LiveRefresh } from "@/components/LiveRefresh";
import { evaluateDomain } from "@/lib/domains.ts";

export const metadata: Metadata = { alternates: { canonical: "/" } };

// Demo seed only runs when no production datastore is configured (§41).
seedDemoMarket([
  { domain: "google.com", holderHandle: "@indexfund", priceCents: 428000 },
  { domain: "x.com", holderHandle: "@timeline", priceCents: 231000 },
  { domain: "openai.com", holderHandle: "@latentspace", priceCents: 94000 },
  { domain: "apple.com", holderHandle: "@onebutton", priceCents: 72000 },
  { domain: "reddit.com", holderHandle: "@upvote", priceCents: 43000 },
  { domain: "linear.app", holderHandle: "@shipfast", priceCents: 10500 },
]);

export const dynamic = "force-dynamic";

// While the market is thin, a first visitor gets one-click starting points
// instead of a wall of empty sections.
const STARTER_DOMAINS = ["google.com", "openai.com", "apple.com", "x.com", "github.com", "netflix.com", "reddit.com", "wikipedia.org"];
const THIN_MARKET = 6;

export default async function Home() {
  const [rows, sales, contested, rising, fresh, value] = await Promise.all([
    listMarket(25),
    listRecentSales(8),
    listMostContested(5),
    listFastestRising(5),
    listNewlyClaimed(5),
    marketValueCents(),
  ]);
  const held = new Set(rows.map((r) => r.domain));
  const starters = rows.length < THIN_MARKET
    ? STARTER_DOMAINS.filter((d) => !held.has(d) && evaluateDomain(d).eligible).slice(0, 6)
    : [];

  return (
    <div className="stack-lg">
      <LiveRefresh />
      <section className="stack">
        <p className="eyebrow">Priced</p>
        <h1 className="display display-hero">How much is the internet worth?</h1>
        <p className="muted" style={{ maxWidth: 640, margin: 0 }}>
          Every domain has a price now. Somebody holds each tag until someone makes a higher
          offer and takes it. <strong>Not the actual domain.</strong> Just the tag.
        </p>
        <SearchBar />
      </section>

      <section className="section-rule stack">
        <div className="row-split">
          <h2 className="display display-section">The Market</h2>
          <p className="small muted" style={{ margin: 0 }}>
            the internet is currently worth <span className="money money-up">{money(value)}</span>*
            {value === 0 ? " Fix that." : null}
          </p>
        </div>
        {rows.length > 0 ? <MarketTable rows={rows} /> : null}
        {starters.length > 0 ? (
          <div className="stack" style={{ gap: "var(--space-2)" }}>
            <p className="small" style={{ margin: 0 }}>
              {rows.length === 0
                ? "Opening bell. Every tag is $5 right now. Somebody is going to be the first name on google.com."
                : "Still unclaimed, still $5:"}
            </p>
            <div className="starter-chips">
              {starters.map((d) => (
                <Link key={d} href={`/domain/${d}`} className="starter-chip">
                  <span className="mono">{d}</span> <span className="small muted">$5 · unclaimed</span>
                </Link>
              ))}
            </div>
          </div>
        ) : null}
        <p className="small muted" style={{ margin: 0 }}>
          * according to this ridiculous website, sampled from the top 1,000 tags by price. Ranked
          by current symbolic price.
        </p>
      </section>

      {rows.length > 0 ? (
        <section className="section-rule stack">
          <h2 className="display display-section">Most Fought Over</h2>
          <MostContested rows={contested} />
        </section>
      ) : null}

      {sales.length > 0 ? (
        <section className="section-rule stack">
          <h2 className="display display-section">Recent Takeovers</h2>
          <ActivityFeed sales={sales} />
        </section>
      ) : null}

      {rising.length > 0 ? (
        <section className="section-rule stack">
          <h2 className="display display-section">Fastest Rising</h2>
          <ul className="holding-list">
            {rising.map((r) => (
              <li key={r.domain} className="row-split">
                <Link href={`/domain/${r.domain}`} className="mono">{r.domain}</Link>
                <span className="small">
                  up <span className="money money-up">+{money(r.roseCents)}</span> this week · now{" "}
                  <span className="money">{money(r.priceCents)}</span> · @{r.holderHandle}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {fresh.length > 0 ? (
        <section className="section-rule stack">
          <h2 className="display display-section">Newly Claimed</h2>
          <ul className="holding-list">
            {fresh.map((r) => (
              <li key={r.domain} className="row-split">
                <Link href={`/domain/${r.domain}`} className="mono">{r.domain}</Link>
                <span className="small">
                  first claim by @{r.holderHandle} · <span className="money">{money(r.priceCents)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="notice">
        <strong>What am I buying?</strong> The right for this website to publicly show your handle
        on a domain&apos;s price tag until somebody pays more and takes it. No domain registration,
        no DNS, no equity, no affiliation. Previous holders get nothing. That&apos;s how the list works.
      </section>
    </div>
  );
}
