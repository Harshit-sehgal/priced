"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function signOut() {
    setBusy(true);
    try {
      const { createAuthBrowserClient } = await import("@/lib/auth-browser");
      try {
        const client = await createAuthBrowserClient();
        await client.auth.signOut();
      } catch {
        // Demo mode or unconfigured auth — server route still clears cookies.
      }
      await fetch("/api/auth/signout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
    } finally {
      setBusy(false);
      router.push("/");
      router.refresh();
    }
  }

  return (
    <button className="btn btn-sm" disabled={busy} onClick={signOut} type="button">
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
