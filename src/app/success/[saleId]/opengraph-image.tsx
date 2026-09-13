import { ImageResponse } from "next/og";
import { money, quoteFor } from "@/lib/game.ts";
import { getSale, getDomainForDisplay, isDomainReserved } from "@/lib/repo";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Priced receipt";

// [saleId] is unbounded and every miss costs two Supabase reads plus a
// Satori/resvg render, so an attacker could mint infinite cache keys for free.
// The underlying sale row is immutable; only the "next challenge" line moves,
// which an hour-long ISR window tracks closely enough for a share card.
// No headers()/cookies() here on purpose — a request-scoped rate limit would
// force dynamic rendering and throw away this cache.
export const revalidate = 3600;

const CACHE_CONTROL = "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400";

const appHost = process.env.NEXT_PUBLIC_APP_URL
  ? new URL(process.env.NEXT_PUBLIC_APP_URL).host
  : "priced.game";

export default async function SaleOgImage({ params }: { params: Promise<{ saleId: string }> }) {
  const { saleId } = await params;
  const sale = await getSale(saleId);
  // Display read, not the strict money read: a domain reserved AFTER the sale
  // made getDomain() throw, so every unfurl of that receipt 500'd its card.
  // Reserved must consult the operator table too, or a DB-reserved tag's card
  // would advertise a challenge that /domain/<tag> refuses.
  const available = sale ? !(await isDomainReserved(sale.domain)) : false;
  const current = sale && available ? await getDomainForDisplay(sale.domain) : null;
  // Next challenge price only when the buyer still holds the tag.
  const stillHolds = !!(sale && current && current.holderUserId === sale.buyerUserId);
  const next = current ? quoteFor({
    domain: sale!.domain,
    holder: current.holderHandle,
    priceCents: current.priceCents,
    version: current.version,
    history: [],
  }) : null;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#16150f",
          color: "#f4f1ea",
          padding: 64,
          fontFamily: "monospace",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, letterSpacing: 4, color: "#cdc8ba" }}>
          <span style={{ color: "#7ee2b1", fontWeight: 700 }}>PRICED</span>
          <span>NOT THE ACTUAL DOMAIN</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 84, fontWeight: 700 }}>{sale?.domain ?? "unknown"}</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 28 }}>
            <span style={{ fontSize: 120, fontWeight: 700, color: "#7ee2b1" }}>
              {sale ? money(sale.priceCents) : "—"}
            </span>
            <span style={{ fontSize: 38 }}>
              {sale ? `taken by @${sale.buyerHandle}` : "receipt not found"}
            </span>
          </div>
          <div style={{ fontSize: 30, color: "#cdc8ba" }}>
            {sale
              ? !available
                ? "operator-reserved · receipt remains in the ledger"
                : stillHolds
                  ? `next challenge: ${money(next!.nextPriceCents)} · anyone can take it`
                  : `taken from @${sale.previousHolderHandle ?? "nobody"} · now held by @${current?.holderHandle ?? "nobody"}`
              : ""}
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 26, borderTop: "4px solid #f4f1ea", paddingTop: 20 }}>
          <span>THINK YOU CAN TAKE IT?</span>
          <span>{appHost}</span>
        </div>
      </div>
    ),
    { ...size, headers: { "cache-control": CACHE_CONTROL } },
  );
}
