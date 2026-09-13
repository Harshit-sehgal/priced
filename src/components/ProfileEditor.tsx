"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Own-profile editor for bio + CTA. Handle is immutable (ledger identity),
 * so only the optional fields are editable.
 */
export function ProfileEditor({
  initialBio,
  initialCtaLabel,
  initialCtaUrl,
}: {
  initialBio: string | null;
  initialCtaLabel: string | null;
  initialCtaUrl: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [bio, setBio] = useState(initialBio ?? "");
  const [ctaLabel, setCtaLabel] = useState(initialCtaLabel ?? "");
  const [ctaUrl, setCtaUrl] = useState(initialCtaUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bio: bio || null,
          ctaLabel: ctaLabel || null,
          ctaUrl: ctaUrl || null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!res.ok) {
        const messages: Record<string, string> = {
          cta_label_required: "Add a short label for your CTA.",
          cta_label_too_long: "Label is too long. 40 characters max.",
          cta_url_required: "Add the destination URL.",
          cta_url_invalid: "Use a full https:// URL.",
          cta_url_too_long: "URL is too long.",
          cta_host_reserved: "Point your CTA somewhere other than Priced.",
          bio_too_long: "Bio is too long. 280 characters max.",
        };
        // Route codes arrive upper-cased (CTA_URL_INVALID); map lower-cased.
        const key = body.code ? body.code.toLowerCase() : "";
        setError(messages[key] ?? "Could not save. Try again.");
        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError("Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="btn btn-sm" onClick={() => setOpen(true)}>
        Edit profile
      </button>
    );
  }

  return (
    <form className="panel" onSubmit={submit} style={{ maxWidth: 520 }}>
      <div className="panel-header">
        <span className="eyebrow">Your public profile</span>
        <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <div className="panel-body stack">
        <div className="field">
          <label htmlFor="bio">Short bio (optional, 280 chars)</label>
          <textarea
            id="bio"
            rows={3}
            value={bio}
            maxLength={280}
            onChange={(e) => setBio(e.target.value)}
            placeholder="what you want the internet to know"
          />
        </div>
        <div className="field">
          <label htmlFor="cta-label">CTA label (optional, 40 chars)</label>
          <input
            id="cta-label"
            value={ctaLabel}
            maxLength={40}
            onChange={(e) => setCtaLabel(e.target.value)}
            placeholder="Visit my startup"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <div className="field">
          <label htmlFor="cta-url">CTA link (https only)</label>
          <input
            id="cta-url"
            type="url"
            inputMode="url"
            value={ctaUrl}
            maxLength={300}
            onChange={(e) => setCtaUrl(e.target.value)}
            placeholder="https://example.com"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <p className="small muted" style={{ margin: 0 }}>
            Shown on your profile and every tag you hold. Goes wherever you point it. Never a claim on the domain itself.
          </p>
        </div>
        <div className="row-split" style={{ gap: "var(--space-3)" }}>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
          {saved ? <span className="small muted" style={{ alignSelf: "center" }}>Saved.</span> : null}
        </div>
        {error ? <p className="field-error small" style={{ margin: 0 }}>{error}</p> : null}
      </div>
    </form>
  );
}
