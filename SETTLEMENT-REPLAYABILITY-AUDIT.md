# Step 1 — replayability audit

What can actually be corrected, and what cannot be corrected without inventing
something. Investigation and preparation only: **nothing in this step changes
settlement behaviour, and nothing writes.**

Step 1 of `SETTLEMENT-HISTORY-DESIGN.md` §12.

> **The rule this whole step obeys:** never infer a night's settlement rules
> from the club's current rules. Where the original data is not recoverable,
> the record is marked as such and stays marked.

That rule is not a preference. `IMMUTABLE_CLUB_RULES` freezes a club's rules
today, which makes the inference *probably right* — and therefore especially
dangerous. It would be right until step 9 unfreezes them, at which point every
record backfilled by inference silently starts claiming rules it never used.

---

## The headline

**The production numbers are not in this document, because I cannot reach
production.** The audit is a script; running it is one read-only command:

```bash
cd apps/api && DATABASE_URL='<production url>' npx tsx src/scripts/auditReplayability.ts --json audit.json
```

It opens no transaction, issues no write, creates no row, and never selects a
single `Club` settlement column. It prints the table below filled in.

What this document does contain is everything that can be established without
the data: **which inputs the engine needs, which of them the database keeps,
and therefore which categories exist at all.** Those findings are what decide
steps 2 through 4, and several of them change the plan.

---

## 1. Four ways a record gets created, and two of them never ran the engine

*(verified — every writer of both tables was enumerated)*

| Path | Writes | Engine ran? | Audit row? | Rules recorded? |
|---|---|---|---|---|
| `offlineSessions.settleSession` | `CashOutSettlement` | yes | `settle_session` | **yes** — `changes.meta.settlementRules`, post-PR #12 |
| `clubRecords.createPastSession` | `HistoricalSessionRecord` | yes | `record_past_session` | **no** — meta carries the engine version and *not* the rules |
| `sessions.endSession` | `CashOutSettlement` | **no** | **none** | n/a |
| `seed-history.ts` | `HistoricalSessionRecord` | **no** | **none** | n/a |

The bottom two are the finding. Both write a settlement-shaped row that no
settlement engine ever touched:

- **`endSession`** (Virtual Table) stores `winnersCutDeduction: 0`,
  `excessDeduction: 0`, `netResult = cashOut − buyIn`, `rakeCollected: 0`,
  `potAdjustment: 0`. No rake, no mismatch handling, no pot movement. When
  chips do not equal banks, `sum(nets) + pot ≠ 0` **by construction** — the
  invariant harness in step 4 will flag these, correctly, and it must not treat
  that as corruption.
- **`seed-history.ts`** transcribed two real July nights out of a PDF ledger
  with `profit = cashOut − totalBuyIn` and `importedBy: 'system'`.

Neither is a degraded settlement. Applying rules to one would be a **first
settlement wearing the word "correction"** — a different operation, with a
different meaning for the people who already settled up. They get their own
verdict (`never-engine-settled`), are excluded from correction, and must never
appear in a retroactive selection list.

The audit distinguishes them by `sessionType === 'Virtual Table Session'` and
`importedBy === 'system'` respectively, **and** the absence of a creation audit
row. Both halves are required, so a record that some future path does settle
properly is never misread as transcribed.

## 2. Five inputs decide a settlement. Three are not stored.

*(verified against `computeSettlement`'s signature)*

| Input | Stored? | Where |
|---|---|---|
| per-player `buyIn` / `cashOut` | **yes** | `playerSummaries` / `playerStats` |
| the 11 settlement rules | **sometimes** | session snapshot (post-#12) or settle audit |
| participant **order** | yes, implicitly | array order — never declared as meaningful |
| `manualWinner` | **NO** | nowhere |
| `currentPotBalance` | **NO** | nowhere on the record |

### `manualWinner` — the winner set can be lost outright

`SettlementPlayerInput.manualWinner` is consulted when
`winnerDefinition === 'MANUAL'`, and it is written into neither
`playerSummaries` nor `playerStats`. Nor is `isWinner`. For a club on
`PROFIT_POSITIVE` or `TOP_N` this costs nothing — the flag is never read. For a
club on `MANUAL`, **the winner set is unrecoverable**, and with it the cut.

It cannot be inferred from the outputs either: a seat fee gives every player a
non-zero `rakeDeduction`, so a positive deduction does not identify a winner.

Worse, and already live: **`applySessionChange` does not pass `manualWinner`
either.** Any MANUAL-rules night that has ever been edited was silently
re-settled with *no* winners. That is existing behaviour, not something this
step introduces, and it is recorded here rather than fixed — but step 5 must
not build on it.

### `currentPotBalance` — only two strategies, and only sometimes

Consulted only when `mismatchStrategy` is `EXCESS_FROM_POT` or
`SHORTFALL_TO_POT`, **and** cash-outs exceeded buy-ins, **and** the pot was
enabled. Then `potBalance >= excess` decides whether the pot covered the excess
or the winners did — two completely different distributions.

The balance at that instant is not stored. `ClubPotLog` cannot pin it down
either: the settlement's own pot rows are written in the same transaction, and
`Club.clubPotBalance` is a separately incremented denormalisation that can
drift. The audit flags only the records where the branch actually fired, so
this is a real count rather than a blanket warning.

### Participant order is arithmetic, not presentation — and in more ways than we thought

Two known mechanisms, and the audit measures a third case empirically rather
than reasoning about it:

1. **`TOP_N` ties** resolve by array position (finding 4 in the review).
2. **v1's seat fee** divides the flat rake across the table and hands the
   rounding remainder to `players[length - 1]`. Verified: 100 across three
   players is `[33.33, 33.33, 33.34]`, and reversing the seats moves who pays
   the extra cent. **This is new** — it means order matters for v1 nights with
   an indivisible fee, not only for ties.
3. The mismatch rounding residual is pushed onto the largest deduction, chosen
   with a `sort` whose ties break by position.

Rather than enumerate, the audit **replays each record with its seats reversed
and rotated** and reports whether the money moved. That catches mechanisms
nobody listed, including any added later.

## 3. Where provenance lives, and where it does not

*(verified)*

`CashOutSettlement` and `HistoricalSessionRecord` carry **no engine version
column**. The only record of it is `AuditLog.changes.meta.settlementEngineVersion`,
keyed by the *record's* id, written only by the two engine paths, only since
PR #12.

The rules are worse: `settle_session` audits carry
`changes.meta.settlementRules`, and `record_past_session` audits **do not** —
their meta has `auditSchemaVersion`, `settlementEngineVersion` and
`createdFrom`, and stops. So a back-dated night can know which engine ran and
not know what it was told.

Where both a session snapshot and an audit copy exist they should be identical
— settleSession writes one object into both, in one transaction. The audit
compares them and reports any disagreement, which would mean something other
than the settle path wrote one of them.

## 4. All three engine versions are recoverable from git

*(verified)* — and this de-risks step 2, so it is worth stating plainly.

| Version | Commit | What changed |
|---|---|---|
| 1 | `a865e06^` | flat rake is a **total**, split across the table, remainder to the last seat |
| 2 | `a865e06` | flat rake became a **per-player** seat fee; nothing divides, nothing rounds |
| 3 | `a8d7734` | `chargesRake` gains `potEnabled &&` — no pot, no take |

**Those two conditionals are the entire divergence.** Winners, mismatch,
rounding, the residual and the refund pass are byte-identical across all three.
That is what makes the design's recommendation — versioned branches in one
engine rather than three frozen copies — the honest choice rather than the
cheap one.

`versionedEngine.ts` implements it, and `versionedEngine.test.ts` pins both
claims: `computeSettlementAt(3, …)` reproduces the live engine field for field
across a 400-case cross product, and each divergence moves exactly the figure
git says it moves. Step 2 inherits working dispatch and a test suite rather
than a research problem.

## 5. Two column names that will mislead step 3

*(verified — both matter for splitting seat fee from winner's cut)*

- **`playerSummaries[].winnersCutDeduction` holds the FUSED `rakeDeduction`** —
  seat fee *and* cut, summed. The name says otherwise. Any code that reads it
  as "the winner's cut" is wrong today.
- **`CashOutSettlement.totalWinnersCut` means different things by path.**
  `settleSession` hard-codes it to `0`; `applySessionChange` sets it to
  `result.totalRakeCollected`. So the same column is zero on settle and the
  full rake after an edit.

Neither can be un-fused retroactively. Backfilled revision-1 rows therefore
carry `seatFee: null` and `winnersCut: null` and say so — step 3 splits them
for records written from then on, and history keeps its single number.

---

## 6. The report

Produced by the command at the top. The shape, with every category it can
report:

```
TOTAL HISTORICAL NIGHTS       <n>     CashOutSettlement + HistoricalSessionRecord
  of which deleted            <n>     isDeleted — out of correction scope
  live (correctable scope)    <n>

LIVE RECORDS BY VERDICT
  replayable                  <n>     every input present, AND a replay reproduced the record
  partially-recoverable       <n>     inputs intact, recomputation impossible
  unrecoverable               <n>     the record cannot state what happened
  never-engine-settled        <n>     no engine ever ran (§1)
```

### What each verdict means

**Replayable** — every input needed to reproduce the stored result is in the
data, *and* replaying it at its own engine version under its own rules
reproduced the stored figures to the cent. Not "looks complete": proven.
Correctable.

**Partially recoverable** — the inputs (who played, in and out) are intact and
consistent with the record's own totals, but something needed to *recompute* is
absent. Revision 1 can be written and the night stays visible and correct;
it cannot be corrected.

**Unrecoverable** — the record's own inputs are missing, malformed, or
contradict its stored totals. Not even a faithful revision 1 can be written
without a human stating what happened.

**Never engine-settled** — §1. Its own thing, not a degraded settlement.

### Every reason a record fails, and what each one means

| Code | Verdict | Why it happens |
|---|---|---|
| `engine-version-unknown` | partial | No audit row carries `meta.settlementEngineVersion` — settled before PR #12, or by a path that writes no audit. |
| `rules-unknown` | partial | No session snapshot and no audit copy of the rules. Back-dated records reach this even *with* an audit, because `record_past_session` never stored rules. **The club's current rules are not a substitute.** |
| `manual-winners-lost` | partial | `winnerDefinition: MANUAL` and `manualWinner` was never persisted. The winner set is gone. |
| `pot-balance-unknown` | partial | A pot-funded mismatch strategy fired on an excess; the deciding balance was never recorded. |
| `replay-mismatch` | partial, **loud** | Every input appeared present and the replay still disagreed. An input nobody has identified. |
| `inputs-missing` | unrecoverable | The record stores no player rows at all. |
| `inputs-malformed` | unrecoverable | A buy-in or cash-out is not a finite, non-negative number. |
| `inputs-contradict-totals` | unrecoverable | Σ player rows ≠ the record's own stored totals. One of the two is wrong and the data cannot say which. |

`replay-mismatch` is the one to escalate. Every other code names a thing we
know is missing; this one means our model of what a settlement needs is
incomplete. **Any occurrence must be resolved before step 4**, because the
backfill would otherwise write a revision 1 we cannot explain.

---

## 7. Run against the local dev database

Not the answer — dev seed data, and posted only to show the pipeline works end
to end against a real Postgres rather than against fixtures.

```
TOTAL HISTORICAL NIGHTS       14
  of which deleted            12
  live (correctable scope)     2

  replayable                   0
  partially-recoverable        0
  unrecoverable                0
  never-engine-settled         2      ← both PDF transcriptions
```

Both live records are the July 25th/26th nights `seed-history.ts` imported, and
the audit identified them as transcribed rather than settled without being told
which ids to look for. The 12 deleted ones are development debris.

If production looks like this, the honest conclusion is not "ship the
correction feature anyway" — it is that **most of the value is in nights not
yet played**, and the sequence should be weighted accordingly.

---

## 8. What cannot be safely reconstructed, and is not going to be

Recorded rather than solved, per the rule at the top.

1. **Rules for any pre-#12 settled night, and for every back-dated record.**
   Today's frozen club values are almost certainly the values that were in
   force. Almost certainly is not a basis for overwriting money, and the freeze
   lifts in step 9.
2. **The engine version for any pre-#12 record.** Inferable from the deployment
   timeline; that is a guess about dates, not a fact in the data.
3. **`manualWinner` for any MANUAL-rules night.** Not stored, not inferable
   from the outputs.
4. **`currentPotBalance` at the instant a pot-funded mismatch was resolved.**
5. **The seat-fee/winner's-cut split for every existing record.** Fused at
   write time; step 3 fixes it going forward only.

The escape hatch, and it is the only one: a **one-off, owner-confirmed
backfill** where a human states what the rules were, audited, once, per record
— the same shape as `initSettlementRules`. Stated by a person, never guessed by
a query. That is a step 4+ decision and is deliberately not built here.

---

## 9. What this step changed in the plan

**Nothing shipped changes.** These are amendments to steps 2–5.

1. **Step 3 (split seat fee / cut) is confirmed necessary and confirmed
   forward-only.** `winnersCutDeduction` already holds the fused figure under a
   misleading name; `totalWinnersCut` means two different things depending on
   which path last wrote it. Both need renaming or retiring, and no historical
   row can be un-fused.
2. **The `never-engine-settled` population needs a product decision**, not just
   a filter. Virtual Table nights and the PDF imports are visible in History and
   count toward the leaderboard, but were never settled by any rules. Deciding
   they can never be corrected is defensible; deciding it silently is not.
3. **Order is data.** Revision 1 must preserve participant order verbatim,
   which the backfill script does. v1's remainder-to-the-last-seat makes this
   concrete rather than theoretical.
4. **The invariant harness (step 4) must expect `sum(nets) + pot ≠ 0` on
   Virtual Table records** and treat it as a known property of that population
   rather than corruption.
5. **`applySessionChange` drops `manualWinner`.** Existing bug, unfixed here,
   and step 5 must not inherit it.

---

## What was built

| File | What it is |
|---|---|
| `apps/api/src/modules/settlementHistory/replayability.ts` | The classifier and the evidence reader. Pure — no I/O, no club, so "never consult current rules" is structural rather than remembered. |
| `apps/api/src/modules/settlementHistory/versionedEngine.ts` | v1/v2/v3 replay. **Investigation instrument**; step 2 replaces it with real dispatch and deletes this. v3 delegates to the live engine so it cannot drift. |
| `apps/api/src/scripts/auditReplayability.ts` | The audit. Read-only. |
| `apps/api/src/scripts/backfillRevision1.ts` | The revision-1 backfill, planned against the step-4 schema. **Cannot execute** — `EXECUTION_ENABLED = false`, and the model it writes into does not exist yet. Prints the plan and a sample row. |
| `*.test.ts` | 35 tests. Every guard was mutation-tested: the rules fallback, the replay check, the pot-balance condition and the totals cross-check were each broken in turn, and each turned a test red. |

Run the audit before the backfill planner: the plan is only as good as the
verdicts it is built on.
