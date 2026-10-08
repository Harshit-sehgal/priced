"use client";

import { useState } from "react";
import { money } from "@/lib/game.ts";
import { track } from "@/lib/analytics";

export function ShareButtons({
  domain,
  priceCents,
  handle,
  saleId,
  unclaimed = false,
  reserved = false,
}: {
  domain: string;
  priceCents: number;
  handle: string | null;
  saleId?: string;
  unclaimed?: boolean;
  reserved?: boolean;
}) {
  const [copied, setCopied] = useState<"post" | "link" | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copyFallback, setCopyFallback] = useState<string | null>(null);

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/$/, "");
  const path = saleId ? `/success/${saleId}` : `/domain/${encodeURIComponent(domain)}`;
  const baseShareUrl = `${appUrl}${path}`;
  const shareUrl = `${baseShareUrl}${baseShareUrl.includes("?") ? "&" : "?"}via=share`;
  const post = saleId
    ? `I just took ${domain} for ${money(priceCents)} on Priced.\n\nnot the actual domain lol`
    : reserved
      ? `${domain} is reserved on Priced and cannot be claimed. Not the actual domain.`
      : unclaimed
        ? `${domain} is unclaimed on Priced. First claim starts at ${money(priceCents)}. Not the actual domain.`
        : handle
          ? `@${handle} holds ${domain}'s tag on Priced at ${money(priceCents)}. Not the actual domain.`
          : `${domain} is listed on Priced at ${money(priceCents)}. Not the actual domain.`;

  function shareOnX() {
    track("share_clicked", { domain, saleId });
    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(post)}&url=${encodeURIComponent(shareUrl)}`;
    window.open(intent, "_blank", "noopener,noreferrer");
  }

  async function nativeShare() {
    if (typeof navigator === "undefined" || !navigator.share) return copy("link");
    track("share_clicked", { domain, saleId, native: true });
    try {
      await navigator.share({ title: `${domain} on Priced`, text: post, url: shareUrl });
    } catch {
      // user dismissed the share sheet — nothing to do
    }
  }

  async function copy(kind: "post" | "link") {
    const text = kind === "post" ? post : shareUrl;
    setCopyError(null);
    setCopyFallback(null);
    try {
      await navigator.clipboard.writeText(text);
      track(kind === "post" ? "share_copied" : "share_clicked", { kind, domain, saleId });
      setCopied(kind);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      // Clipboard permissions can be denied or unavailable (non-secure
      // context). Silent failure looked like a dead button.
      setCopied(null);
      setCopyFallback(text);
      setCopyError("Couldn't copy automatically — long-press to select the text.");
    }
  }

  return (
    <div className="stack" style={{ gap: "var(--space-3)" }}>
      <button className="btn btn-take btn-block" onClick={shareOnX}>
        {saleId ? `Post on X · I just took ${domain}` : `Post on X · ${domain} on Priced`}
      </button>
      <button className="btn btn-block" onClick={nativeShare}>
        Share…
      </button>
      <div className="row-split" style={{ gap: "var(--space-3)" }}>
        <button className="btn" onClick={() => copy("post")} style={{ flex: 1 }}>
          {copied === "post" ? "Copied!" : "Copy post"}
        </button>
        <button className="btn" onClick={() => copy("link")} style={{ flex: 1 }}>
          {copied === "link" ? "Copied!" : "Copy link"}
        </button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {saleId
          ? `Sharing helps new challengers find you. @${handle} · ${money(priceCents)}`
          : "Share this Priced tag with others. It does not represent the real domain."}
      </p>
      {copyError ? (
        <div className="stack" role="status" style={{ gap: "var(--space-1)" }}>
          <p className="field-error small" style={{ margin: 0 }}>{copyError}</p>
          <p className="small mono" style={{ margin: 0, overflowWrap: "anywhere", userSelect: "all" }}>{copyFallback}</p>
        </div>
      ) : null}
    </div>
  );
}
