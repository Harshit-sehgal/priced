import { NextResponse } from "next/server";
import { createHmac } from "node:crypto";
import { rateLimit } from "@/lib/ratelimit";
import { demoWebhookSecret } from "@/lib/demo-secret";
import { clientIp } from "@/lib/client-ip";

export async function POST(req: Request) {
  const ip = clientIp(req.headers);

  // Demo-only endpoint: disabled in any production-like environment.
  // A configured payment provider implies real money; isProdDatastore
  // (Supabase service key) would otherwise leave a signing oracle available
  // to abuse the webhook.
  if (process.env.DODO_PAYMENTS_API_KEY || process.env.STRIPE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "not_available" }, { status: 404 });
  }
  if (!(await rateLimit(`demo-sign:ip:${ip}`, 30, 60_000))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/json")) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
  }

  let payload = "";
  try {
    const body = (await req.json()) as { payload?: string };
    if (typeof body.payload !== "string") {
      return NextResponse.json({ error: "payload_required" }, { status: 400 });
    }
    payload = body.payload;
    if (payload.length > 16_000) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
    // Must be valid JSON with the expected top-level shape. This prevents
    // the endpoint from becoming a generic signing oracle.
    const parsed = JSON.parse(payload) as {
      id?: unknown;
      type?: unknown;
      payment_intent?: unknown;
      metadata?: unknown;
    };
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.type !== "string" ||
      typeof parsed.payment_intent !== "string" ||
      (parsed.metadata !== undefined &&
        (typeof parsed.metadata !== "object" ||
          parsed.metadata === null ||
          !("quote_id" in (parsed.metadata as Record<string, unknown>))))
    ) {
      return NextResponse.json({ error: "invalid_payload_shape" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const secret = demoWebhookSecret();
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  return NextResponse.json({ signature });
}
