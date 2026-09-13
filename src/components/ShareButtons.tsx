"use client";

import { useState } from "react";
import { money } from "@/lib/game.ts";
import { track } from "@/lib/analytics";

export function ShareButtons({ domain, priceCents, handle, saleId }: { domain: string; priceCents: number; handle: string; saleId: string }) {
  const [copied, setCopied] = useState<"post" | "link" | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || (typeof window !== "undefined" ? window.location.origin : "");
  const baseShareUrl = `${appUrl}/success/${saleId}`;
  const shareUrl = `${baseShareUrl}${baseShareUrl.includes("?") ? "&" : "?"}via=share`;
  const post = `I just took ${domain} for ${money(priceCents)} on Priced.\n\nnot the actual domain lol`;

  function shareOnX() {
    track("share_clicked", { domain, saleId });
    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(post)}&url=${encodeURIComponent(shareUrl)}`;
    window.open(intent, "_blank", "noopener,noreferrer");
  }

  async function nativeShare() {
    if (typeof navigator === "undefined" || !navigator.share) return shareOnX();
    track("share_clicked", { domain, saleId, native: true });
    try {
      await navigator.share({ title: `${domain} on Priced`, text: post, url: shareUrl });
    } catch {
      // user dismissed the share sheet — nothing to do
    }
  }

  const supportsNative = typeof navigator !== "undefined" && typeof navigator.share === "function";

  async function copy(kind: "post" | "link") {
    const text = kind === "post" ? post : shareUrl;
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(text);
      track(kind === "post" ? "share_copied" : "share_clicked", { kind, domain, saleId });
      setCopied(kind);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      // Clipboard permissions can be denied or unavailable (non-secure
      // context). Silent failure looked like a dead button.
      setCopied(null);
      setCopyError("Couldn't copy automatically — long-press to select the text.");
    }
  }

  return (
    <div className="stack" style={{ gap: "var(--space-3)" }}>
      <button className="btn btn-take btn-block" onClick={shareOnX}>
        Post on X · I just took {domain}
      </button>
      {supportsNative ? (
        <button className="btn btn-block" onClick={nativeShare}>
          Share…
        </button>
      ) : null}
      <div className="row-split" style={{ gap: "var(--space-3)" }}>
        <button className="btn" onClick={() => copy("post")} style={{ flex: 1 }}>
          {copied === "post" ? "Copied!" : "Copy post"}
        </button>
        <button className="btn" onClick={() => copy("link")} style={{ flex: 1 }}>
          {copied === "link" ? "Copied!" : "Copy link"}
        </button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Sharing is the whole game: your post is how challengers find you. @{handle} ·{" "}
        {money(priceCents)}
      </p>
      {copyError ? <p className="field-error small" style={{ margin: 0 }}>{copyError}</p> : null}
    </div>
  );
}
