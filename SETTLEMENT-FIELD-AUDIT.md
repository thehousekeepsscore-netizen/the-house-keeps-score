# Step 3 — every writer and reader of the settlement fields

Done **before** the schema changed, per the requirement. The point was to be
able to say, with evidence rather than confidence, that Step 3 changes no
settlement behaviour.

Step 3 of `SETTLEMENT-HISTORY-DESIGN.md` §12.

---

## 1. The writers

*(verified — every `.create`/`.update` against both record tables was enumerated)*

| Path | Table | Engine? | `playerSummaries`/`playerStats` | `totalWinnersCut` | `rakeCollected` |
|---|---|---|---|---|---|
| `offlineSessions.settleSession` | `CashOutSettlement` | yes | engine output | **`0`** | `totalRakeCollected` |
| `clubRecords.applySessionChange` | both | yes (re-settles) | engine output | **`totalRakeCollected`** | `totalRakeCollected` |
| `clubRecords.createPastSession` | `HistoricalSessionRecord` | yes | engine output | n/a | n/a |
| `sessions.endSession` | `CashOutSettlement` | **no** | raw profit, all deductions `0` | `0` | `0` |
| `seed-history.ts` | `HistoricalSessionRecord` | **no** | `profit = cashOut − buyIn` | n/a | n/a |
| `clubRecords.linkHistoryPlayer` | both | no | **mutates identity in place** | — | — |
| the client edit form | (sends) | no | sends `0`s the server discards | — | — |

## 2. What was actually ambiguous, and what only looked it

This distinction decided the whole scope of Step 3.

### `totalWinnersCut` — genuinely ambiguous *(the one real defect)*

`0` from `settleSession`, `result.totalRakeCollected` from `applySessionChange`.
The same column, two meanings, decided by which path wrote last. A night settled
and then edited changed the column's meaning without changing its name.

**Read by exactly one place:** `getSessionHistory` maps it to
`NormalizedSession.winnersCut`. And the client **never renders it** — the field
is declared in `clubRecords-api.ts` and read by no component. That is why the
ambiguity survived unnoticed, and why pinning it changes nothing on screen.

### `winnersCutDeduction` — misnamed, not ambiguous

Every writer that means anything by it writes the **fused** `rakeDeduction` —
seat fee *and* winners' cut. So its stored meaning has always been consistent;
only its name lies. Read by `backfillRevision1` and typed on the client.

### `excessDeduction` — same shape

Always `mismatchDeduction`. Name misleading, meaning consistent.

### `rakeCollected` / `potAdjustment` — unambiguous

`totalRakeCollected` and `potContribution` from every writer. `rakeCollected` is
read by `getSessionHistory` as `rake`, which the client does consume.

## 3. What Step 3 did about each

| Field | Change | Behaviour change? |
|---|---|---|
| `totalWinnersCut` | both writers now write the **winners' cut alone**, which the engine can finally produce | a stored value changes; **nothing renders it** |
| `winnersCutDeduction` | left exactly as it is | none |
| `excessDeduction` | left exactly as it is | none |
| `rakeCollected` | untouched | none |
| `potAdjustment` | untouched | none |
| `playerSummaries` / `playerStats` | untouched | none |

Old rows keep their old `totalWinnersCut` values and cannot be repaired — the
parts were never stored. So the column has an **era boundary**: unreliable
before this change, the cut after it. `canonicalOutputs` is the source of truth
for anything written from here on, and it is the only one worth reading.

## 4. Inputs and outputs, separated

Three nullable columns on `CashOutSettlement` and `HistoricalSessionRecord`:

```
engineVersion    Int?    which semantics produced these figures
canonicalInputs  Json?   everything the engine reads
canonicalOutputs Json?   everything it returned, seat fee and cut apart
```

**Additive and nullable, so the migration is backward-compatible** — the API
running right now keeps working after it is applied, which is what makes
migrate-then-deploy the safe order.

### The contract

```
inputs + rules + engineVersion  →  engine  →  outputs
```

`replayCanonical(inputs)` takes **one argument**. There is no club parameter, no
transaction, and no `prisma` import in `canonicalSettlement.ts` — so a replay
cannot reach for today's settings for a night played under yesterday's. The
signature is the guarantee, not a convention to remember.

**Inputs** — established by reading `computeSettlement`'s signature, not by
recalling it:

| | Why it is an input |
|---|---|
| `engineVersion` | an 8× rake difference across v1/v2 on the same setting |
| `rules` | all 11 fields, copied verbatim; never a club reference |
| participants: `userId`, `displayName`, `buyIn`, `cashOut` | the money |
| participant **order** + explicit `seatIndex` | TOP_N ties, v1's remainder-to-the-last-seat, the mismatch residual tie-break |
| `manualWinner` | read when `winnerDefinition: MANUAL`; **was persisted nowhere** |
| `potState.currentPotBalance` | read by the two pot-funded strategies on an excess |
| `potState.affectsResult` | derived, so a reader can tell load-bearing from incidental |
| `mismatchAcknowledged` | gates MANUAL mismatch resolution |
| `capturedAt` / `capturedFrom` | provenance |

`seatIndex` is redundant with array position **on purpose**: a serialisation
that reorders participants becomes a detectable fault instead of a settlement
that quietly pays a different person. `replayCanonical` refuses when the two
disagree.

**Outputs** — per player `netResult`, `grossProfit`, `isWinner`,
`mismatchDeduction`, `seatFee`, `winnersCut`, `rakeDeduction`; totals for each;
`mismatchResolution`; `requiresManualResolution`; and the engine's own `steps`.

### Where the split cannot be reconstructed

```
seatFee: null
winnersCut: null
splitUnavailableReason: "Settled before the seat fee and winners cut were stored
  separately. The record holds only their sum (playerSummaries.winnersCutDeduction),
  and the parts cannot be derived from the total. Not manufactured."
```

`null`, never `0` — zero is a real answer and "unknown" is not. Nothing is
backfilled: a pre-contract row gets `NULL` and keeps it.

## 5. The engine split changed no number

`seatFee` and `winnersCut` are derived from the final `rakeDeduction` rather
than accumulated beside it, so they cannot drift from the figure every existing
caller reads. The seat fee is the exact half — a flat amount per player, or v1's
already-rounded share — so it is taken first and capped at the total, and the
cut takes what is left. Capping is what makes a refund come off the **cut**
before the chair, which is the right order: the cut is a charge on profit that
turned out not to exist, and the chair costs what it costs either way.

**Proof it moved nothing:** all three golden fixtures still pass, unchanged —
22,400 cases per version, digests recorded from each version's original source
out of git.

## 6. Two pre-existing artifacts, recorded rather than fixed

**`totalRakeCollected` is summed without rounding.** `runRake` ends with a plain
`reduce`, so three shares of `75.00000000000001` come out as
`225.00000000000003`. Pinned in a test to its actual value, so the day someone
rounds it the change has to be noticed. Left alone because it is **stored**, and
rounding it would move a figure settled nights already carry — that belongs to a
new engine version, not to a reporting change.

**`rakeCollected` is an `Int` column and Prisma coerces silently.** Verified: a
fractional value is accepted and rounded rather than rejected. So the stored
total can differ from the engine's, which is one more reason `canonicalOutputs`
(full precision, JSON) is the figure to trust.

**`applySessionChange` still drops `manualWinner`** — a `MANUAL`-rules night
re-settled by an edit comes back with no winners. Not fixed here, deliberately:
fixing it changes what an edit computes, and Step 3 changes no settlement
behaviour. It is a binding requirement on Step 5. What Step 3 adds is the
*evidence* — the canonical record states `manualWinner: false` for everybody, so
a night mis-settled this way is afterwards identifiable instead of
indistinguishable.

---

## 7. Deploying this — the migration is a manual step

*(verified)* There is **no deploy configuration in the repo** — no
`railway.json`, no `Procfile`, no `nixpacks.toml` — and neither `build`
(`prisma generate && tsc`) nor `start` (`node dist/index.js`) runs
`prisma migrate deploy`. The two existing migrations were applied by hand.

Production's schema currently matches `schema.prisma` exactly, both migrations
`finished_at` set, no drift *(verified read-only)*.

**So the order matters, and it is:**

1. apply the migration to production
   ```bash
   cd apps/api && DATABASE_URL='<production url>' npx prisma migrate deploy
   ```
2. **then** merge / deploy

Nullable additive columns are backward-compatible, so step 1 is safe to run
while the current API is live. Doing it the other way round is not: the new
client selects `canonicalInputs`, and every query against these tables would
fail until the migration landed.

Verified locally: `prisma migrate deploy` applies cleanly and
`prisma migrate diff --from-url … --to-schema-datamodel` reports **no
difference**.

**Recommended follow-up, not done here:** add `prisma migrate deploy` to the
API's release step so this stops being a thing to remember. That is a
deployment change, and putting it in the same PR as a schema change is how
outages happen.

---

## What was built

| File | What it is |
|---|---|
| `canonicalSettlement.ts` | The contract: input/output types, `buildCanonicalInputs`, `replayCanonical`, `validateCanonicalInputs`. No I/O, no club, no prisma. |
| `settlementEngine.ts` | `seatFee` + `winnersCut` on every player, `totalSeatFees` + `totalWinnersCut` on the result. No number changed. |
| `20260814000000_canonical_settlement_contract` | Three nullable columns per record table. Additive only. |
| `settlementEngine.split.test.ts` | 20 tests: the parts sum to the whole at every rounding rule and version, the refund order, and the float artifact pinned. |
| `canonicalSettlement.test.ts` | 27 tests: replay fidelity, immunity to later rule changes, order enforcement, MANUAL winners, pot-state relevance, validation. |
| `canonicalReplay.integration.test.ts` | 7 tests against a real row: the stored inputs replay to the stored outputs, and still do after the club's rules are changed underneath them. |

Not in Step 3, deliberately: revisions, overwrites, approvals, retroactive
rules, and any correction UI.
