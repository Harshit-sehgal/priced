# Iteration 1 results

Two seeded-bug fixtures, each reviewed by an independent subagent with the
skill and without it (baseline = Opus 5, no skill). Fixtures and full reviews
in this directory.

| | A w/skill | A baseline | B w/skill | B baseline |
|---|---|---|---|---|
| Found the seeded bug | yes | yes | yes | yes |
| Mentions mutation-testing | 1 | 0 | 1 | 0 |
| Forced interleaving / held-open txn | 1 | 0 | 3 | 0 |
| Explicit clean bills of health | yes | no | yes | no |

## What this showed

**Detection was a tie.** Both baselines found both seeded bugs, and baseline A
additionally found a NULL-comparison price hole that was not seeded
(`p_paid_cents <> NULL` is NULL, not true, so the WRONG_PRICE guard is skipped
on a freshly-inserted row). A strong model does not need a catalogue to spot
these.

**Verification rigor was not a tie.** Only the with-skill runs said the
regression tests they proposed must be mutation-tested, and only they noted
that a plain parallel fire cannot reproduce a TOCTOU — it needs two connections
with the winner's transaction held open.

That distinction is the whole point. Both bugs that reached production in this
repo passed a green suite: `navigation.test.ts` asserted exactly the right
invariant over a corpus containing no `..`, and a `Promise.all` probe against
the real finalizer printed "IDEMPOTENT (good)" before a forced interleaving
proved otherwise.

## Change made

Reframed the skill to lead with verification rather than the pattern catalogue,
and rewrote the description to trigger on "prove this race is fixed" / "write a
test for this money bug", not only on "review this payment code".
