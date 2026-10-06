export const ADULT_ATTESTATION_COOKIE = "priced_adult_attestation";
export const ADULT_ATTESTATION_TTL_MS = 5 * 60_000;

function payload(userId: string, quoteId: string, issuedAt: number): Uint8Array {
  return new TextEncoder().encode(`${userId}\n${quoteId}\n${issuedAt}`);
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array | null {
  if (!/^[\da-f]{64}$/i.test(value)) return null;
  return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

export async function createAdultAttestationToken(
  secret: string,
  userId: string,
  quoteId: string,
  issuedAt = Date.now(),
): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await key(secret), payload(userId, quoteId, issuedAt));
  return `${issuedAt}.${toHex(signature)}`;
}

export async function verifyAdultAttestationToken(
  token: string | null,
  secret: string,
  userId: string,
  quoteId: string,
  now = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const [issuedAtText, signatureHex, extra] = token.split(".");
  if (!issuedAtText || !signatureHex || extra !== undefined || !/^\d{1,16}$/.test(issuedAtText)) return false;
  const issuedAt = Number(issuedAtText);
  const signature = fromHex(signatureHex);
  if (!signature || !Number.isSafeInteger(issuedAt) || issuedAt > now || now - issuedAt > ADULT_ATTESTATION_TTL_MS) return false;
  try {
    return await crypto.subtle.verify("HMAC", await key(secret), signature, payload(userId, quoteId, issuedAt));
  } catch {
    return false;
  }
}

export function getCookieValue(cookieHeader: string | null, name: string): string | null {
  const prefix = `${name}=`;
  return cookieHeader?.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length) ?? null;
}
