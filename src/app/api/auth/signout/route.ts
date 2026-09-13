import { NextResponse } from "next/server";
import { createAuthClient, isAuthConfigured } from "@/lib/auth";

export async function POST(req: Request) {
  // JSON-only gate like every other mutating route: a cross-origin HTML form
  // cannot produce this content type, which closes logout-CSRF. SameSite=Lax
  // remains the backstop for older clients.
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/json")) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
  }
  if (!isAuthConfigured) return NextResponse.json({ ok: true, demo: true });
  const client = await createAuthClient();
  await client.auth.signOut();
  return NextResponse.json({ ok: true });
}
