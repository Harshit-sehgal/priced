export type PriceEvent = {
  holder: string;
  priceCents: number;
  at: string;
};

export type DomainRecord = {
  domain: string;
  holder: string | null;
  priceCents: number;
  version: number;
  history: PriceEvent[];
};

export type PriceQuote = {
  kind: "claim" | "takeover";
  expectedVersion: number;
  currentPriceCents: number;
  percentIncrementCents: number;
  minimumIncrementCents: number;
  requiredIncrementCents: number;
  nextPriceCents: number;
};

export const START_PRICE_CENTS = 500;
export const MIN_TAKEOVER_INCREMENT_CENTS = 500;
export const TAKEOVER_RATE_BPS = 100; // 1.00%

/** A browser may suggest an offer, but the server must keep it integer-cent and finite. */
export function isValidOfferCents(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** The computed minimum offer for the market state represented by `record`. */
export function minimumOfferCents(record: DomainRecord): number {
  return quoteFor(record).nextPriceCents;
}

const seedTime = {
  d1: "2026-09-04T12:00:00.000Z",
  d2: "2026-09-05T09:00:00.000Z",
  d3: "2026-09-06T14:30:00.000Z",
  d4: "2026-09-07T08:00:00.000Z",
  d5: "2026-09-07T14:00:00.000Z",
  d6: "2026-09-08T08:00:00.000Z",
};

export const seededDomains: DomainRecord[] = [
  {
    domain: "google.com",
    holder: "@indexfund",
    priceCents: 428000,
    version: 3,
    history: [
      { holder: "@firstclick", priceCents: 247700, at: seedTime.d1 },
      { holder: "@pagerank", priceCents: 356700, at: seedTime.d2 },
      { holder: "@indexfund", priceCents: 428000, at: seedTime.d6 },
    ],
  },
  {
    domain: "x.com",
    holder: "@timeline",
    priceCents: 231000,
    version: 2,
    history: [
      { holder: "@handledealer", priceCents: 160400, at: seedTime.d1 },
      { holder: "@timeline", priceCents: 231000, at: seedTime.d5 },
    ],
  },
  {
    domain: "openai.com",
    holder: "@latentspace",
    priceCents: 94000,
    version: 2,
    history: [
      { holder: "@tokens", priceCents: 65100, at: seedTime.d2 },
      { holder: "@latentspace", priceCents: 94000, at: seedTime.d6 },
    ],
  },
  {
    domain: "apple.com",
    holder: "@onebutton",
    priceCents: 72000,
    version: 1,
    history: [{ holder: "@onebutton", priceCents: 72000, at: seedTime.d3 }],
  },
  {
    domain: "microsoft.com",
    holder: "@clippyreturns",
    priceCents: 56000,
    version: 1,
    history: [{ holder: "@clippyreturns", priceCents: 56000, at: seedTime.d4 }],
  },
  {
    domain: "reddit.com",
    holder: "@upvote",
    priceCents: 43000,
    version: 1,
    history: [{ holder: "@upvote", priceCents: 43000, at: seedTime.d5 }],
  },
];

export function normalizeDomain(input: string) {
  let s = input.trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  s = s.split("@").pop() ?? ""; // userinfo
  s = s.split(/[/?#]/)[0] ?? ""; // path, query, fragment
  s = s.replace(/:\d{1,5}$/, ""); // port
  s = s.replace(/^www\./, ""); // leading www
  s = s.replace(/\.+$/, ""); // trailing dots
  return s;
}

export function isPlausibleDomain(input: string) {
  const domain = normalizeDomain(input);
  return /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain);
}

function percentOfCents(valueCents: number, basisPoints: number) {
  return Math.ceil((valueCents * basisPoints) / 10_000);
}

export function quoteFor(record: DomainRecord): PriceQuote {
  if (!record.holder || record.priceCents <= 0) {
    return {
      kind: "claim",
      expectedVersion: record.version,
      currentPriceCents: 0,
      percentIncrementCents: 0,
      minimumIncrementCents: START_PRICE_CENTS,
      requiredIncrementCents: START_PRICE_CENTS,
      nextPriceCents: START_PRICE_CENTS,
    };
  }

  const percentIncrementCents = percentOfCents(record.priceCents, TAKEOVER_RATE_BPS);
  const requiredIncrementCents = Math.max(MIN_TAKEOVER_INCREMENT_CENTS, percentIncrementCents);

  return {
    kind: "takeover",
    expectedVersion: record.version,
    currentPriceCents: record.priceCents,
    percentIncrementCents,
    minimumIncrementCents: MIN_TAKEOVER_INCREMENT_CENTS,
    requiredIncrementCents,
    nextPriceCents: record.priceCents + requiredIncrementCents,
  };
}

export type TakeoverResult =
  | { ok: true; record: DomainRecord }
  | { ok: false; code: "STALE_QUOTE" | "WRONG_PRICE" | "INVALID_HOLDER" | "ALREADY_HOLDER" };

export function applyTakeover(
  record: DomainRecord,
  holder: string,
  expectedVersion: number,
  paidPriceCents: number,
  at = new Date().toISOString(),
): TakeoverResult {
  const cleanHolder = holder.trim();
  if (!cleanHolder || cleanHolder === "@") return { ok: false, code: "INVALID_HOLDER" };
  if (record.holder?.toLowerCase() === cleanHolder.toLowerCase()) {
    return { ok: false, code: "ALREADY_HOLDER" };
  }
  if (record.version !== expectedVersion) return { ok: false, code: "STALE_QUOTE" };

  const quote = quoteFor(record);
  if (!isValidOfferCents(paidPriceCents) || paidPriceCents < quote.nextPriceCents) {
    return { ok: false, code: "WRONG_PRICE" };
  }

  const event: PriceEvent = { holder: cleanHolder, priceCents: paidPriceCents, at };
  return {
    ok: true,
    record: {
      ...record,
      holder: cleanHolder,
      priceCents: paidPriceCents,
      version: record.version + 1,
      history: [...record.history, event],
    },
  };
}

export function marketValueCents(records: DomainRecord[]) {
  return records.reduce((sum, record) => sum + (record.holder ? record.priceCents : 0), 0);
}

export function money(cents: number) {
  const dollars = cents / 100;
  const hasFraction = cents % 100 !== 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(dollars);
}
