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

**Two of the three settled nights in production are correctable today. The
third is not, and the reason is not fixable.**

```
TOTAL RECORDS                  3       CashOutSettlement 3 · Historical 0

FULL POPULATION BY VERDICT            TOTAL    %   LIVE  DELETED
  engine-settled / replayable            2   67%      2        0
  engine-settled, input missing          1   33%      1        0
  never engine-settled                   0    0%      0        0
  fundamentally unrecoverable            0    0%      0        0
  ------------------------------------------------------------
  accounted for                          3   of 3

"ENGINE-SETTLED, INPUT MISSING" BY REASON — 1 record
  engine version unknown                 0
  rules unknown                          1   ← the only cause
  manual winner missing                  0
  pot state missing                      0
  participant identity missing           0
  replay disagreed                       0
  other                                  0

EVIDENCE
  replay reproduced the record           2   both, to the cent
  replay DISAGREED                       0
  participant order changes the money    1   ← see below
  order corroborated by a second copy    3   all of them

RECONCILIATION
  sessions marked settled with NO settlement row   0
  settlements pointing at a missing session        0
  settlements sharing one session id               0
```

Run read-only, on a single pooled connection, against the production database
on 2026-08-14. No transaction, no write, no row created, and not one `Club`
settlement column selected.

```bash
cd apps/api && DATABASE_URL='<production url>' npx tsx src/scripts/auditReplayability.ts --json audit.json
```

### The four things worth knowing

**The history is three nights.** Small enough that "is this feature viable
across the whole history" has a concrete answer: yes, with a boundary of one
record, and the value of the feature is overwhelmingly in nights not yet
played.

**Production has run v1 and v2, and never v3.**

| Record | Club | Settled | Engine | Verdict |
|---|---|---|---|---|
| `cmsf5a2gt…` | Texas Holdem | 2026-08-04 | **1** | input missing — rules unknown |
| `cmsl1zrnr…` | All in 2026 | 2026-08-09 | **1** | replayable, **order-sensitive** |
| `cmsmbsezu…` | All in 2026 | 2026-08-09 | **2** | replayable |

So versioned dispatch is not hypothetical: two live records need v1 semantics
and one needs v2, and replaying any of them under today's v3 would restate real
money. The v1→v2 divergence is the 8× rake change, and it sits between two
records settled on the same day.

**The order hazard is real, in production, on money.** `cmsl1zrnr…` is
order-sensitive: it is a v1 night, and v1 divides the flat rake across the
table and gives the rounding remainder to the last seat. Reorder its
participants and a different player pays. This is no longer a theoretical
finding — it is one of the two records we are proposing to make correctable.

All three records had their order **corroborated** by the audit's independently
written second copy, and both replayable ones reproduced their stored figures
exactly, which is stronger evidence still: a wrong order would not have
reproduced an order-sensitive record.

**A population that was not in the original three.** The Texas Holdem record
has a `settle_session` audit stamped `settlementEngineVersion: 1` and **no
rules at all** — not in the audit meta, not on the session. Engine-version
stamping shipped *before* rules stamping did, so there is a window where a
record knows which engine ran and not what it was told. Classified correctly by
cause rather than by date, which is why the reason breakdown matters more than
the category count.

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
  chips do not equal banks, `sum(nets) + pot ≠ 0` **by construction**.
- **`seed-history.ts`** transcribed two real July nights out of a PDF ledger
  with `profit = cashOut − totalBuyIn` and `importedBy: 'system'`.

The audit distinguishes them by `sessionType === 'Virtual Table Session'` and
`importedBy === 'system'` respectively, **and** the absence of a creation audit
row. Both halves are required, so a record some future path does settle
properly is never misread as transcribed.

### Decision: legacy records are preserved, not converted

Agreed and now binding on every later step:

- **stay visible in History**
- **leaderboard contribution unchanged** — no recomputation, no restatement
- **classified internally as legacy / non-engine-settled**, so the distinction
  is queryable rather than a comment
- **excluded from the correction and replay workflow entirely**
- **no rules inferred, no settlement reconstructed**
- **their existing financial result is not modified by this project**

Whether to offer a *"convert legacy history to a settlement"* workflow later is
an explicit product decision, made deliberately and separately. It is not
something the replay system may arrive at by guessing.

## 2. Five inputs decide a settlement. Three are not stored.

*(verified against `computeSettlement`'s signature)*

| Input | Stored? | Where |
|---|---|---|
| per-player `buyIn` / `cashOut` | **yes** | `playerSummaries` / `playerStats` |
| the 11 settlement rules | **sometimes** | session snapshot (post-#12) or settle audit |
| participant **order** | yes, implicitly | array order — never declared as meaningful |
| `manualWinner` | **NO** | nowhere |
| `currentPotBalance` | **NO** | nowhere on the record |

### `manualWinner` — a hard blocker, not a degradation

`SettlementPlayerInput.manualWinner` is consulted when
`winnerDefinition === 'MANUAL'`, and it is written into neither
`playerSummaries` nor `playerStats`. Nor is `isWinner`. For a club on
`PROFIT_POSITIVE` or `TOP_N` this costs nothing — the flag is never read. For a
club on `MANUAL`, **the winner set is unrecoverable**, and with it the cut.

It cannot be inferred from the outputs either: a seat fee gives every player a
non-zero `rakeDeduction`, so a positive deduction does not identify a winner.

**A `MANUAL` historical settlement therefore cannot safely be replayed.** The
audit blocks it (`manual-winners-lost`), and the integration test proves the
block fires against a real settled night rather than a fixture.

### Flagged separately: `applySessionChange` loses `manualWinner` too

`clubRecords.applySessionChange` re-runs the engine on edit and **does not pass
`manualWinner`**. Any `MANUAL`-rules night that has ever been edited was
silently re-settled with *no* winners.

**Not fixed here, deliberately.** It is existing behaviour and fixing it inside
an investigation step would be exactly the kind of silent change this project
exists to prevent. It is instead a **binding requirement on step 5**:

> The new correction path must carry every engine input through the replay,
> `manualWinner` included — and must refuse to replay a record whose required
> inputs are absent rather than substituting a default.

The old path's behaviour is a defect to be addressed on its own terms; the new
path must not inherit it.

### `currentPotBalance` — only two strategies, and only sometimes

Consulted only when `mismatchStrategy` is `EXCESS_FROM_POT` or
`SHORTFALL_TO_POT`, **and** cash-outs exceeded buy-ins, **and** the pot was
enabled. Then `potBalance >= excess` decides whether the pot covered the excess
or the winners did — two completely different distributions.

The balance at that instant is not stored. `ClubPotLog` cannot pin it down
either: the settlement's own pot rows are written in the same transaction, and
`Club.clubPotBalance` is a separately incremented denormalisation that can
drift. The audit flags only records where the branch actually fired.

### Participant order is a canonical input, not presentation

Agreed and recorded as a model decision: **participant order is part of the
canonical inputs** and is preserved verbatim into revision 1.

Three mechanisms make it arithmetic:

1. **`TOP_N` ties** resolve by array position (finding 4 in the review).
2. **v1's seat fee** divides the flat rake across the table and hands the
   rounding remainder to `players[length - 1]`. Verified: 100 across three
   players is `[33.33, 33.33, 33.34]`, and reversing the seats moves who pays
   the extra cent. So order matters for v1 nights with an indivisible fee, not
   only for ties.
3. The mismatch rounding residual is pushed onto the largest deduction, chosen
   with a `sort` whose ties break by position.

Rather than rely on that list being complete, the audit **replays each record
with its seats reversed and rotated** and reports whether the money moved.
Proving that ordering changes the result beats knowing every place it might.

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
— `settleSession` writes one object into both, in one transaction. The audit
compares them and reports any disagreement.

## 4. All three engine versions are recoverable from git

*(verified)* — and this de-risks step 2, so it is worth stating plainly.

| Version | Commit | What changed |
|---|---|---|
| 1 | `a865e06^` | flat rake is a **total**, split across the table, remainder to the last seat |
| 2 | `a865e06` | flat rake became a **per-player** seat fee; nothing divides, nothing rounds |
| 3 | `a8d7734` | `chargesRake` gains `potEnabled &&` — no pot, no take |

**Those two conditionals are the entire divergence.** Winners, mismatch,
rounding, the residual and the refund pass are byte-identical across all three.
That is what makes versioned branches in one engine the honest choice rather
than the cheap one — and with PR #22's parity harness already protecting
behaviour, the branch approach carries the smaller risk of the two.

`versionedEngine.ts` implements it, and `versionedEngine.test.ts` pins both
claims: `computeSettlementAt(3, …)` reproduces the live engine field for field
across a 400-case cross product, and each divergence moves exactly the figure
git says it moves.

**The requirement it exists to satisfy:**

> A historical record replays under the engine semantics that originally
> produced it — never today's engine with yesterday's data.

## 5. Two column names that will mislead step 3

*(verified — both matter for splitting seat fee from winner's cut)*

- **`playerSummaries[].winnersCutDeduction` holds the FUSED `rakeDeduction`** —
  seat fee *and* cut, summed. The name says otherwise. Any code reading it as
  "the winner's cut" is wrong today.
- **`CashOutSettlement.totalWinnersCut` means different things by path.**
  `settleSession` hard-codes it to `0`; `applySessionChange` sets it to
  `result.totalRakeCollected`.

### Decision: do not pretend the split can be reconstructed

Agreed and implemented in the backfill plan:

- historical `winnersCutDeduction` is **not** decomposed — it cannot be
- backfilled rows carry `seatFee: null` and `winnersCut: null`
- each row carries a **`splitUnavailableReason`** stating exactly why, so a
  screen showing a blank seat fee can say whether that means *zero* or *never
  stored* without dating the record against a release
- from step 3 onward, seat fee and winner's cut are stored independently

---

## 6. The report

Produced by the command at the top. **Every record lands in exactly one of four
verdicts, and deleted records are a column rather than a filter** — an undelete
puts a record straight back into scope, so dropping them would be an audit that
flatters itself.

```
TOTAL RECORDS                 <n>
  CashOutSettlement           <n>
  HistoricalSessionRecord     <n>

FULL POPULATION BY VERDICT            TOTAL    %   LIVE  DELETED
  engine-settled / replayable          <n>
  engine-settled, input missing        <n>
  never engine-settled                 <n>
  fundamentally unrecoverable          <n>
  ------------------------------------------------------------
  accounted for                        <n>   of <n>
```

### What each verdict means

**Engine-settled / replayable** — every input needed to reproduce the stored
result is in the data, *and* replaying it at its own engine version under its
own rules reproduced the stored figures to the cent. Not "looks complete":
proven. Correctable.

**Engine-settled, input missing** — the engine did run, and the inputs (who
played, in and out) are intact and consistent with the record's own totals, but
something needed to *recompute* is absent. Revision 1 can be written and the
night stays visible and correct; it cannot be corrected.

**Never engine-settled** — §1. Legacy: visible, unchanged, never correctable.

**Fundamentally unrecoverable** — the record's own inputs are missing,
malformed, or contradict its stored totals. Not even a faithful revision 1 can
be written without a human stating what happened.

### Every reason a record fails, and what each means

| Code | Verdict | Why it happens |
|---|---|---|
| `engine-version-unknown` | input missing | No audit row carries `meta.settlementEngineVersion` — settled before PR #12, or by a path that writes no audit. |
| `rules-unknown` | input missing | No session snapshot and no audit copy of the rules. Back-dated records reach this even *with* an audit, because `record_past_session` never stored rules. **The club's current rules are not a substitute.** |
| `manual-winners-lost` | input missing | `winnerDefinition: MANUAL` and `manualWinner` was never persisted. The winner set is gone. |
| `pot-balance-unknown` | input missing | A pot-funded mismatch strategy fired on an excess; the deciding balance was never recorded. |
| `replay-mismatch` | input missing, **loud** | Every input appeared present and the replay still disagreed. An input nobody has identified. |
| `inputs-missing` | unrecoverable | The record stores no player rows at all. |
| `inputs-malformed` | unrecoverable | A buy-in or cash-out is not a finite, non-negative number. |
| `inputs-contradict-totals` | unrecoverable | Σ player rows ≠ the record's own stored totals. One of the two is wrong and the data cannot say which. |

A record may raise several blockers, so the codes do not sum to the verdict
counts; the report says so rather than leaving it to be tripped over.

`replay-mismatch` is the one to escalate. Every other code names a thing we
*know* is missing; this one means our model of what a settlement needs is
incomplete. **Any occurrence must be resolved before step 4**, because the
backfill would otherwise write a revision 1 nobody can explain.

### Reconciliation — rows without their counterpart

Also reported, because a night that never became a record would otherwise never
appear in any verdict table:

- sessions marked `settled` with **no** `CashOutSettlement`
- settlements pointing at a session that no longer exists
- two settlements sharing one session id

---

## 7. The local dev database, for contrast

Run first, and worth keeping because the contrast with production is the point:
a database can look 0% replayable for a reason that says nothing about the
system.

```
TOTAL RECORDS                 14
  CashOutSettlement           12
  HistoricalSessionRecord      2

FULL POPULATION BY VERDICT            TOTAL    %   LIVE  DELETED
  engine-settled / replayable            0    0%      0        0
  engine-settled, input missing         12   86%      0       12
  never engine-settled                   2   14%      2        0
  fundamentally unrecoverable            0    0%      0        0
  ------------------------------------------------------------
  accounted for                         14   of 14

WHY NON-REPLAYABLE RECORDS CANNOT BE REPLAYED
  engine-version-unknown — 12 record(s)
  rules-unknown          — 12 record(s)

RECONCILIATION
  sessions marked settled with NO settlement row   0
  settlements pointing at a missing session        0
  settlements sharing one session id               0
```

All 14 accounted for, deleted rows included.

**This database has zero `AuditLog` rows.** That is why all 12 settlements come
back `engine-version-unknown` + `rules-unknown` — they predate PR #12 entirely.
It established that the pipeline works and that the population reconciles, and
it said nothing about production: **0% here was not a forecast**, and production
came back 67%.

The two live records are the July 25th/26th nights `seed-history.ts` imported.
The audit identified them as transcribed rather than settled without being told
which ids to look for.

### What proves the replayable path actually works

`replayability.integration.test.ts` settles a night through the **real**
`settleSession` — snapshot, engine, audit row, pot ledger — then reads the row
back out of Postgres and audits it:

| Assertion | Result |
|---|---|
| verdict | **replayable** |
| replay vs stored figures | matched, worst Δ **0.00** |
| engine version found | 3 |
| rules found at | `session-snapshot`, audit copy agreed |
| participant order | corroborated by the audit's second copy |
| order sensitivity | false — v3 divides nothing, and no tie |

The same file settles a `MANUAL`-winner night and confirms the audit refuses it
with `manual-winners-lost`, and drives the Virtual Table path to confirm it
writes `sessionType: 'Virtual Table Session'` with **no audit row** — the two
facts the classifier keys on.

That is the evidence the local population could not supply: a record written by
today's app today is replayable, provably, to the cent.

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

The escape hatch, and the only one: a **one-off, owner-confirmed backfill**
where a human states what the rules were, audited, once, per record — the same
shape as `initSettlementRules`. Stated by a person, never guessed by a query.
A step 4+ decision, deliberately not built here.

---

## 9. What this step changed in the plan

**Nothing shipped changes.** These are amendments to steps 2–5.

1. **Legacy records are preserved, never converted** (§1) — visible, leaderboard
   untouched, internally classified, excluded from replay. Conversion is a
   separate, explicit product decision if it happens at all.
2. **Step 5 must carry `manualWinner` through the replay** and refuse rather
   than default (§2). `applySessionChange`'s loss of it is flagged as its own
   defect, not fixed inside this step.
3. **Participant order is a canonical input** (§2), preserved verbatim into
   revision 1, with sensitivity measured by permutation rather than assumed.
4. **The fused rake split is not reconstructable** (§5) — `seatFee: null` plus a
   recorded `splitUnavailableReason`; independent storage from step 3 onward.
5. **Step 2 proceeds with versioned branches** (§4), under the requirement that
   a record replays under the semantics that produced it.
6. **The invariant harness (step 4) must expect `sum(nets) + pot ≠ 0` on
   Virtual Table records** and treat it as a known property of that population
   rather than corruption.

---

## What was built

| File | What it is |
|---|---|
| `apps/api/src/modules/settlementHistory/replayability.ts` | The classifier and the evidence reader. Pure — no I/O, no club, so "never consult current rules" is structural rather than remembered. |
| `apps/api/src/modules/settlementHistory/versionedEngine.ts` | v1/v2/v3 replay. **Investigation instrument**; step 2 replaces it with real dispatch and deletes this. v3 delegates to the live engine so it cannot drift. |
| `apps/api/src/scripts/auditReplayability.ts` | The audit. Read-only. |
| `apps/api/src/scripts/backfillRevision1.ts` | The revision-1 backfill, planned against the step-4 schema. **Cannot execute** — `EXECUTION_ENABLED = false`, and the model it writes into does not exist yet. |
| `*.test.ts` | 35 unit tests + 6 integration tests. Every guard was mutation-tested: the rules fallback, the replay check, the pot-balance condition and the totals cross-check were each broken in turn, and each turned a test red. |

Run the audit before the backfill planner: the plan is only as good as the
verdicts it is built on.
