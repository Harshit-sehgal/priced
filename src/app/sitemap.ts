import type { MetadataRoute } from "next";
import { isDomainReserved, listMarket } from "@/lib/repo";

export const dynamic = "force-dynamic";

/**
 * Index only meaningful market pages (§38): the homepage, claimed domains, and
 * holder profiles that actually hold something. Unclaimed tags, quotes,
 * checkouts, receipts and empty holder pages stay out of the index.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Filter out reserved domains (static blocklist + DB reserved_domains).
  // DB-reserved entries must not be crawled even if they have a live row
  // (e.g. grandfathered before reservation) — holder stays visible via
  // /domain/[domain] but stays out of the index.
  const base = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const raw = await listMarket(500);
  const reservedFlags = await Promise.all(raw.map((r) => isDomainReserved(r.domain)));
  const rows = raw.filter((_, i) => !reservedFlags[i]);
  // Static pages that explain the product and carry the disclaimers. These
  // were previously missing, so the one page that says in full what a buyer is
  // and is not getting was invisible to search — for a product whose defence
  // is "we say it everywhere", the explainer has to be indexable.
  const staticPages: MetadataRoute.Sitemap = [
    { url: `${base}/about`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/terms`, changeFrequency: "monthly", priority: 0.3 },
    { url: `${base}/privacy`, changeFrequency: "monthly", priority: 0.3 },
    { url: `${base}/refunds`, changeFrequency: "monthly", priority: 0.3 },
  ];

  return [
    {
      url: base,
      changeFrequency: "hourly",
      priority: 1,
    },
    ...staticPages,
    ...rows.map((row) => ({
      url: `${base}/domain/${row.domain}`,
      lastModified: row.updatedAt ? new Date(row.updatedAt) : undefined,
      changeFrequency: "hourly" as const,
      priority: 0.8,
    })),
    ...Array.from(new Set(rows.map((r) => r.holderHandle).filter(Boolean) as string[])).map((handle) => ({
      url: `${base}/u/${handle}`,
      changeFrequency: "weekly" as const,
      priority: 0.5,
    })),
  ];
}
