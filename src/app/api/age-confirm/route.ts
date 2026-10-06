import { NextResponse } from "next/server";
import { getViewer, isAuthConfigured } from "@/lib/auth";
import { getQuote } from "@/lib/repo";
import {
  ADULT_ATTESTATION_COOKIE,
  ADULT_ATTESTATION_TTL_MS,
  createAdultAttestationToken,
} from "@/lib/adult-attestation";
import { clientIp } from "@/lib/client-ip";
import { rateLimitAll } from "@/lib/ratelimit";

export async function POST(req: Request) {
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
  }

  const rawBody = await req.text().catch(() => "");
  if (rawBody.length > 4_096) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody || "{}");
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const body = parsed as { quoteId?: unknown; adultConfirmed?: unknown };
  if (typeof body.quoteId !== "string" || !body.quoteId) {
    return NextResponse.json({ error: "quoteId_required" }, { status: 400 });
  }
  if (body.adultConfirmed !== true) {
    return NextResponse.json({ code: "AGE_CONFIRMATION_REQUIRED", error: "age_confirmation_required" }, { status: 400 });
  }

  // Demo checkouts never collect real money; real checkouts require auth and a signed attestation.
  if (!isAuthConfigured) return NextResponse.json({ confirmed: true });

  let user;
  try {
    ({ user } = await getViewer());
  } catch {
    return NextResponse.json({ error: "auth_unavailable" }, { status: 503 });
  }
  if (!user) return NextResponse.json({ error: "login_required" }, { status: 401 });

  const ip = clientIp(req.headers);
  const allowed = await rateLimitAll([
    { key: `checkout:${user.id}`, limit: 20, windowMs: 60_000 },
    { key: `checkout:ip:${ip}`, limit: 30, windowMs: 60_000 },
  ]);
  if (!allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const quote = await getQuote(body.quoteId);
  if (!quote) return NextResponse.json({ error: "unknown_quote" }, { status: 404 });
  if (quote.buyerUserId !== user.id) return NextResponse.json({ error: "not_your_quote" }, { status: 403 });
  if (quote.status !== "active" && quote.status !== "checkout_created") {
    return NextResponse.json({ error: `quote_${quote.status}` }, { status: 409 });
  }
  if (new Date(quote.expiresAt).getTime() < Date.now()) {
    return NextResponse.json({ error: "quote_expired" }, { status: 409 });
  }

  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return NextResponse.json({ error: "age_confirmation_unavailable" }, { status: 503 });
  const token = await createAdultAttestationToken(secret, user.id, quote.id);
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  const maxAge = Math.floor(ADULT_ATTESTATION_TTL_MS / 1_000);
  return NextResponse.json(
    { confirmed: true },
    {
      headers: {
        "cache-control": "no-store",
        "set-cookie": `${ADULT_ATTESTATION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
      },
    },
  );
}
