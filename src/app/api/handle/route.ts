import { NextResponse } from "next/server";
import { claimHandle, getViewer, demoViewer } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";
import { sanitizeInternalPath } from "@/lib/navigation";
import { clientIp } from "@/lib/client-ip";

export async function POST(req: Request) {
  // JSON-only: cross-origin form posts cannot produce this content type (§46 CSRF).
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/json")) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
  }

  let user;
  try {
    ({ user } = await getViewer());
    if (!user) {
      const { isAuthConfigured } = await import("@/lib/auth");
      if (!isAuthConfigured) user = demoViewer().user;
    }
  } catch {
    return NextResponse.json({ error: "auth unavailable" }, { status: 500 });
  }
  if (!user) return NextResponse.json({ error: "login_required" }, { status: 401 });

  if (!(await rateLimit(`handle:${user.id}`, 5, 60_000))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const ipForHandle = clientIp(req.headers);
  if (!(await rateLimit(`handle:ip:${ipForHandle}`, 15, 60_000))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let handle = "";
  let next = "/";
  try {
    const raw = await req.text();
    if (raw.length > 4_096) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    const body = JSON.parse(raw || "{}") as { handle?: unknown; next?: unknown };
    if (typeof body.handle !== "string") {
      return NextResponse.json({ error: "invalid_handle", reason: "INVALID_HANDLE" }, { status: 400 });
    }
    handle = body.handle ?? "";
    next = sanitizeInternalPath(typeof body.next === "string" ? body.next : null);
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const result = await claimHandle(user.id, handle);
  if (!result.ok) {
    return NextResponse.json({ error: "invalid_handle", reason: result.reason }, { status: 400 });
  }
  return NextResponse.json({ ok: true, handle: result.handle, next });
}
