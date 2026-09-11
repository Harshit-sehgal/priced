# Verification mechanics

How to actually prove a money-path claim instead of reasoning about it. Every
technique here was used to find or confirm a real defect in this repo.

## Contents

- [Forcing a concurrency interleaving](#forcing-a-concurrency-interleaving)
- [Mutation-testing a regression test](#mutation-testing-a-regression-test)
- [Proving two implementations agree](#proving-two-implementations-agree)
- [Tracing a webhook retry to its conclusion](#tracing-a-webhook-retry-to-its-conclusion)
- [Fuzzing a sanitiser](#fuzzing-a-sanitiser)
- [Harness hygiene](#harness-hygiene)

## Forcing a concurrency interleaving

Firing N parallel requests does **not** reliably hit a TOCTOU window — the
window is microseconds and the requests usually miss it. A parallel run that
passes proves nothing.

Drive the interleaving deterministically with two connections and explicit
transactions: let the winner do its work but hold its transaction open, start
the loser so it parks on the row lock, then commit the winner and read what the
loser concluded.

```js
const winner = await pool.connect();
const loser  = await pool.connect();

await winner.query("begin");
const first = await call(winner);          // takes the row lock

await loser.query("begin");
const pending = call(loser).then(          // blocks on that lock
  r => ({ ok: true, row: r.rows[0] }),
  e => ({ ok: false, code: String(e.message).split(" ")[0] }),
);
await new Promise(r => setTimeout(r, 400)); // let it reach the lock
await winner.query("commit");               // loser now wakes to NEW state

const second = await pending;
```

The bug shows as `second` failing (`STALE_QUOTE`) where it should return the
row `first` created. This exact script turned "I think there is a race" into a
reproduction in one run.

Keep the sleep: without it the loser may not have reached the lock yet, and
you silently test nothing.

## Mutation-testing a regression test

A regression test you have never seen fail is an assumption. Always confirm it
detects the bug it was written for.

```bash
cp src/lib/thing.ts /tmp/thing.keep          # 1. save
sed -i 's/if (!alreadyConsumed) {/if (true) {/' src/lib/thing.ts   # 2. reintroduce
node --test tests/integration/the-test.ts    # 3. MUST fail
cp /tmp/thing.keep src/lib/thing.ts          # 4. restore
node --test tests/integration/the-test.ts    # 5. MUST pass
```

Also check the *guard* cases still pass under mutation. If reintroducing the
bug flips every test in the file, the file is probably asserting something
coarser than you think.

Mutation-test the sanitiser guards individually too. Two guards that each
independently catch the payload are genuine defence in depth; two guards where
removing either still passes may mean one is dead code.

## Proving two implementations agree

Do not eyeball parity between a TypeScript mirror and a SQL function. Run both
over the same ladder and assert equality, including boundaries where the rule
changes shape (here: unclaimed, $5, $499, $500, $501, and values where the
percentage overtakes the floor).

Two refinements that matter:

- **Derive, don't re-implement.** If you compute the expected value in the test
  you have written a *fifth* copy of the formula. Better to read what the SQL
  itself demands — e.g. parse the `WRONG_PRICE expected %, got %` diagnostic.
- **Compound it.** Walk a dozen successive real operations, not just isolated
  rungs, so drift accumulates instead of resetting each time.

For whole-schema equivalence, boot two databases, apply one source to each, and
diff fingerprints. Structure alone is not enough — the security properties live
in privileges. Compare columns, constraints, indexes, **function bodies**
(whitespace-normalised), table/column/function grants, RLS flags, policies, and
publication membership.

Then **negative-test the checker**: introduce a loosened grant and a dropped
index, and confirm it exits non-zero. A drift checker that cannot fail is worse
than none, because it manufactures confidence.

## Tracing a webhook retry to its conclusion

For every non-2xx return in a webhook handler, answer concretely: *what does
the next delivery of this same event do?*

Walk it: which row was written, what status does it hold now, and which branch
does the duplicate handler take for that status? If that branch returns 2xx,
your 500 asked for a retry and then threw it away.

A quick audit for the "forgot to mark state" shape:

```bash
grep -n "status: 500" src/app/api/webhooks/payments/route.ts | while IFS=: read -r ln _; do
  start=$((ln-12))
  echo "line $ln marks status: $(sed -n "${start},${ln}p" file | grep -c markPaymentEventStatus)"
done
```

Zero near a 500 is a flag, not a verdict — some early returns legitimately have
no row to mark yet. Read each one.

## Fuzzing a sanitiser

Hand-picked corpora encode the author's blind spots, which are the same blind
spots that produced the bug. Generate exhaustively over the dangerous alphabet
instead: `/ \ . % 2 f 5 c @ : ? # tab newline space` plus unicode slash
lookalikes (U+2044, U+FF0F) and zero-width characters.

Assert the real end-to-end property, not the intermediate one. For a redirect
sanitiser that is: `new URL(result, realOrigin).origin === realOrigin` — because
that resolution is what the caller actually performs.

## Harness hygiene

Test infrastructure that fails confusingly trains people to ignore red, which
is worse than no test at all.

- **Never hardcode container names or ports.** Fixed names plus a pre-boot
  `docker rm -f` mean two concurrent runs delete each other's database, and
  every money-path test fails at once — indistinguishable from a real
  regression. Use a unique name per run and let Docker assign the port
  (`-p 0:5432`, then read it back with `docker port`).
- **Glob migrations, never list them.** A hardcoded list rots and then
  certifies an outdated function (see SKILL.md §7).
- **Skip cleanly when Docker is absent** so CI stays green on runners without
  it — but make sure the skip is visible, not silent.
- **Clean up containers in a `finally`,** and check for strays afterwards.

One caution learned the hard way: `grep` in some sandboxes silently returns
nothing on files it cannot handle. If a grep result is load-bearing for a
security conclusion, confirm it with a second method before trusting it.
