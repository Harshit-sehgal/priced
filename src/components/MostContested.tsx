import Link from "next/link";
import { money } from "@/lib/game.ts";

type Row = { domain: string; sales: number; priceCents: number; holderHandle: string };

/**
 * "Most fought over" module (§39/P1): domains that changed hands more than
 * once, ranked by sale count. This is the social proof of the platform — tags
 * people thought were worth fighting for.
 */
export function MostContested({ rows }: { rows: Row[] }) {
  if (rows.length === 0) {
    return (
      <p className="muted small">
        Nothing has been fought over yet. A tag becomes contested when someone takes it from
        somebody else.
      </p>
    );
  }
  return (
    <div className="market-table">
      {rows.map((r, i) => (
        <Link key={r.domain} href={`/domain/${r.domain}`} className="market-row">
          <span className="rank">{String(i + 1).padStart(2, "0")}</span>
          <span className="cell-domain">{r.domain}</span>
          <span className="small muted">{r.sales} takeovers · held by @{r.holderHandle}</span>
          <span className="cell-price money">{money(r.priceCents)}</span>
        </Link>
      ))}
    </div>
  );
}
