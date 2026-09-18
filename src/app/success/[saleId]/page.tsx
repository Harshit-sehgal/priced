import type { Metadata } from "next";
import Link from "next/link";
import { money, quoteFor } from "@/lib/game.ts";
import { getSale } from "@/lib/repo";
import { ShareButtons } from "@/components/ShareButtons";
import { LiveRefresh } from "@/components/LiveRefresh";
import { persistViewEvent } from "@/lib/view-events";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ saleId: string }> };

async function load(saleId: string) {
  const sale = await getSale(saleId);
  if (!sale) return null;
  const { getDomainForDisplay, isDomainReserved } = await import("@/lib/repo");
  // Reserved means the STATIC blocklist AND the operator-managed
  // reserved_domains table, exactly as the domain page computes it. Checking
  // only evaluateDomain() left a DB-reserved tag's receipt saying "anyone can
  // take it" while /domain/<tag> said operator-reserved. Display reads are
  // tolerant; the strict money read (getDomain) throws for reserved tags.
  const unavailable = await isDomainReserved(sale.domain);
  const current = unavailable ? null : await getDomainForDisplay(sale.domain);
  return { sale, current, unavailable };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { saleId } = await params;
  const data = await load(saleId);
  if (!data) return { title: "Receipt not found" };
  const { sale } = data;
  return {
    title: `@${sale.buyerHandle} took ${sale.domain} for ${money(sale.priceCents)}`,
    description: `@${sale.buyerHandle} just took the ${sale.domain} tag on Priced for ${money(sale.priceCents)}. Not the actual domain.`,
    openGraph: {
      title: `@${sale.buyerHandle} took ${sale.domain} for ${money(sale.priceCents)}`,
      description: "not the actual domain lol",
    },
  };
}

export default async function SuccessPage({ params, searchParams }: Params & { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const { saleId } = await params;
  const data = await load(saleId);
  // Share attribution (§36): inbound visitors that arrived via a /success share link
  // set ?via=share on the URL; count that funnel entry.
  if (data && searchParams) {
    const sp = await searchParams;
    if (sp.via === "share" || sp.via === "x") {
      // Guarded like the other view writes: link unfurlers (Slack/Discord/X)
      // hit share URLs constantly and must not count as human share visits.
      await persistViewEvent({
        event: "share_visit",
        resource: `sale:${saleId}`,
        domain: data.sale.domain,
        handle: data.sale.buyerHandle,
        props: { saleId, via: String(sp.via) },
      });
    }
  }

  if (!data) {
    return (
      <div className="stack">
        <h1 className="display display-section">Receipt not found.</h1>
        <Link href="/" className="btn">Back to the market</Link>
      </div>
    );
  }

  const { sale, current, unavailable } = data;
  const stillHolder = !unavailable && current?.holderUserId === sale.buyerUserId;
  const next = quoteFor({
    domain: sale.domain,
    holder: current?.holderHandle ?? null,
    priceCents: current?.priceCents ?? 0,
    version: current?.version ?? 0,
    history: [],
  });

  return (
    <div className="stack-lg" style={{ maxWidth: 720 }}>
      <LiveRefresh />
      <section className="receipt stack">
        <span className="stamp">{stillHolder ? "Tag taken" : "Receipt"}</span>
        <p className="eyebrow" style={{ margin: 0 }}>
          {sale.domain}
        </p>
        <div className="money money-hero">{money(sale.priceCents)}</div>
        <p style={{ margin: 0 }}>
          Held by <span className="mono">@{sale.buyerHandle}</span>
          {sale.previousHolderHandle ? (
            <span className="muted"> · taken from @{sale.previousHolderHandle}</span>
          ) : null}
        </p>
        <p className="small muted" style={{ margin: 0 }}>
          symbolic holder status only. Not the actual domain.
        </p>
        {stillHolder ? (
          <p className="small" style={{ margin: 0 }}>
            Next challenge minimum: <span className="money money-up">{money(next.nextPriceCents)}</span>
          </p>
        ) : unavailable ? (
          <p className="small muted" style={{ margin: 0 }}>
            This tag was reserved by the operator after it changed hands and cannot be claimed
            again. Your receipt is preserved in the ledger.
          </p>
        ) : (
          <p className="small field-error" style={{ margin: 0 }}>
            Someone already took this tag for {money(current?.priceCents ?? 0)}. Your receipt is
            preserved in the ledger.
          </p>
        )}
      </section>

      <ShareButtons
        domain={sale.domain}
        priceCents={sale.priceCents}
        handle={sale.buyerHandle}
        saleId={sale.id}
      />

      <section className="notice">
        <strong>What just happened?</strong> You paid for temporary symbolic holder status on this
        website&apos;s price tag for {sale.domain}. The previous holder received nothing.{" "}
        {unavailable
          ? "The tag was later reserved by the operator and can no longer be challenged."
          : `Anyone can take the tag from you by offering at least ${money(next.nextPriceCents)}.`}
      </section>

      <div className="row-split">
        <Link href={`/domain/${sale.domain}`} className="btn">Defend it · view the tag</Link>
        <Link href="/" className="btn btn-primary">Back to the market</Link>
      </div>
    </div>
  );
}
