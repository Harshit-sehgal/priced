# Priced Credits — specification (V1, INACTIVE)

Status: **designed, not active.** Credits are off because no code path, UI,
or feature flag exists yet — `PRICED_CREDITS_ENABLED` is a planned name, not a
variable anything reads today (grep-verify: `PRICED_CREDITS` matches no source
file). Nothing in checkout, payment handling, receipts, refunds, or accounting
reads or writes credits. This document is the contract the implementation must
satisfy before any flag can exist.

## What credits are

Priced Credits are a non-monetary scoreboard counter. When someone takes a
tag from you, you may receive credits. Credits are:

- worth nothing. No cash value, ever.
- not withdrawable, not sellable, not transferable between users.
- not equity, not investment, not yield, not profit.
- not a resale royalty. The amount is a fixed reward per displacement, not a
  percentage of the challenger's payment.
- not marketed as returns. Copy must never use the words earn, yield, ROI,
  income, payout, or investment in connection with credits.

They exist for one reason: losing a tag to a challenger should feel like a
notable event rather than a pure loss.

## How credits are earned (proposed)

- Trigger: a successful takeover finalization where the displaced holder is
  not the buyer.
- Amount: fixed. Proposed V1: 100 credits per displacement, regardless of
  the tag price. Fixed amounts prevent any interpretation as a proportional
  return and keep the accounting trivial.
- Issuance: inside the same transaction as `finalize_takeover`, via a ledger
  insert (see Data model). If the credit insert fails, the takeover still
  succeeds: credits are decorative, money is not.
- Expiry: never.

## Where they are stored

`public.credit_ledger` — append-only, one row per issuance. Balances are
derived (`sum`), never stored as mutable state. No update or delete path
exists in code or DB grants.

## Redemption

V1 proposes no redemption at all. Credits display on the holder profile as a
count and in the takeover receipt as context ("@x receives 100 credits").
Any future redemption (say, cosmetic flair) requires:

1. a separate spec update,
2. explicit language that redemption grants nothing monetary,
3. its own tests.

Redemption can never discount a tag price, apply to checkout, or reduce any
amount of real money. The market price a challenger pays is always the full
`next_price` in real currency, independent of credits.

## Refund interaction

- Stale/wrong-amount/failed payments never create a sale, so no credits are
  issued. No coupling.
- If a provider refund ever reversed a finalized takeover (not a current
  flow: sales are immutable), the credits for that displacement would remain.
  Displacement happened; the scoreboard doesn't rewind. This must be stated
  in user-facing copy if the flag turns on.
- Stale checkout refunds refund the buyer's payment. Credits are untouched
  because no displacement occurred.

## Abuse prevention

- Credits accrue only via `finalize_takeover`'s single atomic path — no
  direct API, no client writes. RLS blocks all anon/authenticated access;
  only the service role inserts, only from the RPC.
- Self-takeover is already impossible (`ALREADY_HOLDER`), so a user cannot
  farm credits from themselves.
- Two accounts colluding (A takes from B, B takes back) costs both the full
  price in real money each cycle. Credits issued: fixed 100 per cycle.
  Real money spent per cycle: two full tag prices. The economics make
  farming strictly expensive; V1 additionally caps nothing because the
  reward is decorative.

## Accounting records

`credit_ledger` rows carry: `id`, `user_id` (displaced holder), `domain`,
`sale_id` (the displacement sale, unique constraint), `amount`, `reason`
(always "displaced" in V1), `created_at`. The unique constraint on
`sale_id` makes issuance idempotent under webhook retries: the same sale can
never issue credits twice.

## Legal description (must appear verbatim in Terms when activated)

"Priced Credits are a decorative scoreboard count. They have no cash value,
cannot be withdrawn, sold, or transferred, are not equity, investment, or
any form of financial return, and do not represent a royalty on any purchase.
Receiving credits does not depend on paying anything and confers no rights
whatsoever."

## Consistency gates before activation

The flag may only be enabled when all of the following hold, with tests:

- [ ] `finalize_takeover` (or its immediate caller, in-transaction) writes
      the credit row exactly once per displacement sale.
- [ ] Duplicate webhook deliveries issue no duplicate credits (unique
      `sale_id`).
- [ ] Refund paths (stale, wrong amount, unknown quote, already-holder)
      never issue credits.
- [ ] Profile display shows the derived balance with the exact legal wording
      nearby.
- [ ] Receipt display shows credits only when the flag is on.
- [ ] MARKET_RULES, Terms, Refunds pages updated in the same release.
- [ ] Checkout flow does not mention credits pre-purchase (no incentive
      framing before payment).

## Data model

Created by migration `20260910000002_credit_ledger.sql` (table exists but is
unused while the flag is off):

```sql
create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  domain text not null,
  sale_id uuid not null unique references public.sales(id),
  amount bigint not null check (amount > 0),
  reason text not null default 'displaced',
  created_at timestamptz not null default now()
);
alter table public.credit_ledger enable row level security;
-- no policies: service-role only
```

## Flag (planned)

`PRICED_CREDITS_ENABLED` (env, default unset = off) is the planned toggle; it
does not exist in code yet. While credits are off:
- no read or write of `credit_ledger` anywhere in request paths,
- no UI mentions credits,
- this document is the only artifact.
