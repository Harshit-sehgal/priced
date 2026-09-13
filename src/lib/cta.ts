// Holder CTA validation (§7). Shared by /api/profile and UI hints.
// A CTA is a short label plus an https destination. http is rejected so a
// misconfigured http:// checkout page can never downgrade a click target.

export const CTA_LABEL_MAX = 40;
export const BIO_MAX = 280;

export type CtaValidation =
  | { ok: true; label: string; url: string }
  | { ok: false; reason: "label_required" | "label_too_long" | "url_required" | "url_invalid" | "url_too_long" | "host_reserved" };

/**
 * @param extraSelfHosts hosts the CALLER knows are us — normally the host the
 * request actually arrived on. See the self-host note below for why the
 * configured URL alone is not enough.
 */
export function validateCta(rawLabel: unknown, rawUrl: unknown, extraSelfHosts: string[] = []): CtaValidation {
  const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
  const url = typeof rawUrl === "string" ? rawUrl.trim() : "";

  if (!label && !url) return { ok: false, reason: "label_required" };
  if (!label) return { ok: false, reason: "label_required" };
  if (label.length > CTA_LABEL_MAX) return { ok: false, reason: "label_too_long" };
  if (!url) return { ok: false, reason: "url_required" };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "url_invalid" };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "url_invalid" };
  if (url.length > 300) return { ok: false, reason: "url_too_long" };

  // The CTA must not point back into Priced itself. The mild reading is
  // self-promotion loops and holder-vs-site confusion; the sharp one is that a
  // CTA on our own domain, labelled something like "Verify ownership", borrows
  // the site's legitimacy to phish our own users.
  //
  // NEXT_PUBLIC_APP_URL alone is not a sufficient definition of "us". It is a
  // build-time constant that goes stale the moment the deployment moves — this
  // app has already moved Vercel -> Cloudflare Workers, and during that window
  // the guard was blocking a host nobody was served from while the live host
  // was allowed. So callers also pass the host the request actually arrived
  // on, which cannot drift by definition.
  const selfHosts = new Set<string>();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) {
    try {
      selfHosts.add(new URL(appUrl).host.toLowerCase());
    } catch {
      /* ignore */
    }
  }
  for (const host of extraSelfHosts) {
    const clean = host?.trim().toLowerCase();
    if (clean) selfHosts.add(clean);
  }
  if (selfHosts.has(parsed.host.toLowerCase())) return { ok: false, reason: "host_reserved" };

  return { ok: true, label, url: parsed.toString() };
}

export function validateBio(raw: unknown): { ok: true; bio: string | null } | { ok: false; reason: "bio_too_long" } {
  if (raw == null || raw === "") return { ok: true, bio: null };
  if (typeof raw !== "string") return { ok: false, reason: "bio_too_long" };
  const bio = raw.trim();
  if (bio.length > BIO_MAX) return { ok: false, reason: "bio_too_long" };
  return { ok: true, bio: bio || null };
}

/**
 * Moderation visibility: a suspended profile is hidden, so its outbound CTA
 * must be hidden everywhere the profile is otherwise linked — otherwise the
 * suspension is half-applied and a moderated account keeps a live link on
 * every tag it still holds. The handle itself stays visible (holdings are
 * ledger truth).
 */
export function holderCtaVisible(profile: { suspendedAt: string | null } | null | undefined): boolean {
  return Boolean(profile && !profile.suspendedAt);
}
