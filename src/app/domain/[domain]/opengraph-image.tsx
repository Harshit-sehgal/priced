import { ImageResponse } from "next/og";
import { money } from "@/lib/game.ts";
import { evaluateDomain } from "@/lib/domains.ts";
import { getDomain, isDomainReserved } from "@/lib/repo";
import { safeDecodeURIComponent } from "@/lib/navigation";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Priced";

// [domain] is unbounded, so every random value used to be a distinct CDN cache
// key that always missed, and each miss cost a Supabase read plus a CPU-heavy
// Satori/resvg render. ISR-cache the rendered PNG for an hour: crawlers and
// repeat unfurls then cost nothing, and a takeover still refreshes the card
// well inside the window social platforms keep their own copy.
//
// Deliberately no request-scoped rate limit here: reading headers()/cookies()
// would opt this route into dynamic rendering and disable exactly the cache
// that makes the abuse cheap to absorb. Caching is the stronger control.
export const revalidate = 3600;

const CACHE_CONTROL = "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400";

const appHost = process.env.NEXT_PUBLIC_APP_URL
  ? new URL(process.env.NEXT_PUBLIC_APP_URL).host
  : "priced.game";

export default async function OgImage({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;
  const evalResult = evaluateDomain(safeDecodeURIComponent(domain));
  const canonical = evalResult.canonicalDomain;
  // getDomain() calls requireEligibleDomain() and THROWS on an ineligible
  // domain (static blocklist / malformed), which used to make this route a
  // guaranteed 500. Display reads are tolerant; the card renders an
  // unavailable state instead.
  const reserved = canonical ? await isDomainReserved(canonical) : false;
  const row = canonical && evalResult.eligible && !reserved ? await getDomain(canonical) : null;
  const unclaimed = !row || !row.holderUserId;
  // Nothing ineligible may advertise a $5 first claim: reserved tags say so,
  // and malformed/unsupported ones render as unknown rather than purchasable.
  const priceText = reserved ? "RESERVED" : !evalResult.eligible ? "—" : unclaimed ? "$5" : money(row.priceCents);
  const holderText = reserved
    ? "operator-reserved · not claimable"
    : !evalResult.eligible
      ? "not a priced tag"
      : unclaimed
        ? "unclaimed · first claim costs $5"
        : `held by @${row.holderHandle}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#f4f1ea",
          color: "#16150f",
          padding: 64,
          fontFamily: "monospace",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, letterSpacing: 4, color: "#615d4e" }}>
          <span style={{ color: "#16150f", fontWeight: 700 }}>PRICED</span>
          <span>NOT THE ACTUAL DOMAIN</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 92, fontWeight: 700 }}>{canonical ?? "unknown"}</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 24 }}>
            <span style={{ fontSize: 120, fontWeight: 700, color: "#0a5c3d" }}>
              {priceText}
            </span>
            <span style={{ fontSize: 30, color: "#615d4e" }}>
              {holderText}
            </span>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 26, borderTop: "4px solid #16150f", paddingTop: 20 }}>
          <span>TAKE IT BEFORE SOMEONE ELSE DOES</span>
          <span>{appHost}</span>
        </div>
      </div>
    ),
    { ...size, headers: { "cache-control": CACHE_CONTROL } },
  );
}
