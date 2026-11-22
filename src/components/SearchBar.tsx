"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

export function SearchBar({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const hintId = useId();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = value.trim().toLowerCase();
    if (!cleaned) {
      setHint("Type a domain, like google.com.");
      return;
    }
    // Mirror the server normalizer enough for pleasant URLs: scheme →
    // userinfo? ignore, then path/query/fragment → host, strip leading
    // www. and any :port, then trim trailing dots. Server re-normalizes
    // definitively, so this only needs to avoid obvious mismatches.
    let host = cleaned.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    host = host.split("@").pop() ?? host;
    host = host.split(/[/?#]/)[0] ?? host;
    host = host.replace(/:\d{1,5}$/, "");
    host = host.replace(/^www\./, "");
    host = host.replace(/\.+$/, "");
    if (!host || !host.includes(".")) {
      setHint(`Add the ending, like ${host ? `${host}.com` : "google.com"}.`);
      return;
    }
    setHint(null);
    router.push(`/domain/${encodeURIComponent(host)}`);
  }

  return (
    <div className="stack" style={{ gap: "var(--space-1)", ...(compact ? {} : { maxWidth: 560 }) }}>
      <form
        className="searchbar"
        onSubmit={submit}
        role="search"
        aria-label="Search any domain"
      >
        <input
          type="text"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="search any domain…"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setHint(null);
          }}
          aria-label="Domain"
          aria-invalid={hint ? true : undefined}
          aria-describedby={hint ? hintId : undefined}
        />
        <button type="submit" className="btn btn-primary">
          Price it
        </button>
      </form>
      {hint ? (
        <p id={hintId} className="field-error small" role="alert" style={{ margin: 0 }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
