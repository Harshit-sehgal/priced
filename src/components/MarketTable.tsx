import Link from "next/link";
import { money } from "@/lib/game.ts";
import { quoteFor } from "@/lib/game.ts";
import type { RepoDomain } from "@/lib/repo.ts";

export function MarketTable({ rows }: { rows: RepoDomain[] }) {
  if (rows.length === 0) {
    return (
      <div className="market-table">
        <div className="market-row">
          <span className="muted" style={{ padding: "16px 0" }}>
            The market is empty. Be the first to claim a tag for $5.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="market-table">
      {rows.map((row, i) => {
        const next = quoteFor({
          domain: row.domain,
          holder: row.holderHandle,
          priceCents: row.priceCents,
          version: row.version,
          history: [],
        });
        return (
          <Link key={row.domain} href={`/domain/${row.domain}`} className="market-row">
            <span className="rank">{String(i + 1).padStart(2, "0")}</span>
            <span className="cell-domain">{row.domain}</span>
            <span className="cell-holder">@{row.holderHandle ?? "—"}</span>
            <span className="cell-price money">{money(row.priceCents)}</span>
            <span className="cell-price small muted money">
              min {money(next.nextPriceCents)}
            </span>
            <span className="btn btn-sm btn-take">Take</span>
          </Link>
        );
      })}
    </div>
  );
}
