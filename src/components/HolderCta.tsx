"use client";

import { track } from "@/lib/analytics";

function isSafeCtaUrl(url: string): boolean {
  // Read-time guard: write-time validation enforces https, but a legacy or
  // directly-written row must never render as a javascript:/data: link.
  // React escapes text; it does not sanitize href schemes.
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Holder CTA: links offsite. Always https, always rel="noopener noreferrer",
 * never implies the holder operates the domain the tag belongs to.
 */
export function HolderCta({ label, url, handle }: { label: string; url: string; handle: string }) {
  if (!isSafeCtaUrl(url)) return <span className="btn btn-take">{label}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="btn btn-take"
      onClick={() => track("cta_clicked", { handle, url })}
    >
      {label}
    </a>
  );
}

/** Compact inline CTA for list rows (same safety rules). */
export function HolderCtaInline({ label, url, handle }: { label: string; url: string; handle: string }) {
  if (!isSafeCtaUrl(url)) return <span className="cta-inline mono">{label}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="cta-inline mono"
      onClick={() => track("cta_clicked", { handle, url })}
    >
      {label} ↗
    </a>
  );
}
