"use client";

import { useEffect, useState } from "react";

// The server renders in its own timezone (UTC on Workers), so a wall-clock
// "expires 10:10 PM" was wrong for most buyers. A countdown is timezone-free.
function remaining(expiresAt: string): number {
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

export function QuoteCountdown({ expiresAt }: { expiresAt: string }) {
  const [left, setLeft] = useState(() => remaining(expiresAt));

  useEffect(() => {
    const id = setInterval(() => setLeft(remaining(expiresAt)), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (left === 0) return <span className="field-error">price expired</span>;
  const m = Math.floor(left / 60);
  const s = String(left % 60).padStart(2, "0");
  return (
    <span suppressHydrationWarning style={left < 60 ? { color: "var(--danger)" } : undefined}>
      price held for {m}:{s}
    </span>
  );
}
