# Settlement history — technical design

A design for changing settled nights safely: versioned replay, club-rule
versions, single-bank edits, and deliberate retroactive rule application.

**Nothing here is implemented.** Every statement about current behaviour was
verified against the running code or the schema during the investigation that
produced this document; those are marked *(verified)*. Everything else is a
proposal.

The organising idea, and the one thing worth agreeing before the detail:

> A settled night is a **financial record**, not a view over current settings.
> It is never overwritten. A correction is a **new revision** plus a
> per-player **adjustment**, and both stay visible forever.

That single decision resolves most of the questions below, because it removes
the need to ever decide "what the night really was" — the original stands, and
the correction sits beside it.

---

## 0. What exists today

*(verified)*

| Thing | Where | Shape |
|---|---|---|
| Club rules | `Club`, 11 columns | `sessionRakeAmount`, `winnersCutPercent`, `potEnabled`, `mismatchStrategy`, `rakeOrder`, `winnerDefinition`, `winnerTopN`, `roundingRule`, + 3 legacy rake fields |
| Rule mutability | `IMMUTABLE_CLUB_RULES` | all 11 frozen after club creation |
| Night's own rules | `PokerSession.engineState.settlementRules` | 12 fields incl. `capturedAt`; written at `startPlaying` |
| Settled result | `CashOutSettlement` | totals + `playerSummaries` JSON |
| Back-dated result | `HistoricalSessionRecord` | totals + `playerStats` JSON |
| Pot ledger | `ClubPotLog` | append-only, keyed by session, `amount` + `source` |
| Pot balance | `Club.clubPotBalance` | denormalised running total |
| Audit | `AuditLog` | actor, DB timestamp, `changes` JSON |
| Change approval | `PendingChangeRequest` | `edit_session` \| `delete_session` |

Three facts do most of the work in this design:

**Replay inputs are preserved.** `playerSummaries` carries `totalBuyIn` and
`cashOut` per player — the engine's *inputs*, not just its outputs. Any settled
night can therefore be recomputed. `applySessionChange` already does this.

**The leaderboard is derived at read time** from `HistoricalSessionRecord` +
`CashOutSettlement`. Recompute those rows and History and Ranks follow. There
is no stored aggregate to keep in sync.

**The pot already has a reverse-and-reapply pattern.** `potLedgerFor` returns
`net` and `intended` (excluding reversals), and `applySessionChange` moves the
pot by `-net` before applying the new figure. This is the correct shape and is
reusable.

---

## 1. Settlement engine versioning

### The problem, with numbers

*(verified)* Three versions have shipped, and two of them changed what the same
configuration means:

| Version | `sessionRakeAmount` means | 8 players at 1,000 |
|---|---|---|
| 1 | total for the night, split across players | 125 each → **1,000 total** |
| 2 | per participating player | 1,000 each → **8,000 total** |
| 3 | per player, and **nothing** when `potEnabled === false` | 8,000, or 0 |

An 8× difference on the same stored rule. Replaying a v1 night under today's
engine does not "apply the new rake" — it silently reinterprets a setting that
was never changed.

### Where the version lives

*(verified)* `CashOutSettlement` does **not** record an engine version.
`AuditLog.changes.meta.settlementEngineVersion` does, but only for nights
settled after PR #12, and it is keyed by the settlement id rather than the
session id.

**Proposal.** Add `engineVersion INT` to `CashOutSettlement` and
`HistoricalSessionRecord`, backfilled per §11. The version belongs on the
record it produced, not only in an audit row that may not exist.

### How dispatch should work

Two options were considered.

**Frozen copies** — `settlementEngine.v1.ts`, `.v2.ts`, `.v3.ts`, never edited
again. Perfect fidelity, but triples a 500-line file and guarantees three
copies of every future bug fix. We have just spent a PR proving how expensive
two hand-maintained copies already are.

**Versioned branches in one engine** — recommended.

```ts
export function computeSettlement(
  players, settings, opts, engineVersion: EngineVersion = CURRENT
): SettlementResult
```

with explicit branches at the three known divergence points:

```ts
// v1 divided the flat fee; v2 onward charges it per player.
const flatPerPlayer = engineVersion >= 2 ? flat : flat / players.length;

// v3 onward refuses to charge anything with no pot to receive it.
const chargesRake = (engineVersion >= 3 ? potEnabled : true) && (flat > 0 || cut > 0);
```

This works because the divergences are **small, known and enumerable**. It
stops working the moment a future change is structural rather than a
conditional — at which point a frozen copy for the old version is the honest
answer, and the golden fixtures below make that switch safe.

### Locking each version's behaviour

A version's arithmetic must never move again. Every version gets a **golden
fixture**: a set of tables × settings with the exact expected output, checked
in as data.

```
fixtures/engine-v1.json   fixtures/engine-v2.json   fixtures/engine-v3.json
```

A change that alters any golden output fails, and the only legitimate response
is a **new version**, never an edit to an old one.

The parity infrastructure from PR #22 is directly reusable: it already runs
both engine copies over a cross product of tables and settings and compares
field by field. The same harness generates and checks fixtures.

### Consequence for the current duplication

Versioned dispatch is the point at which two hand-maintained copies stop being
tolerable — the client would need the same branches, and drift would mean the
preview replays a *different version* than the server. **Extract the engine to
one shared module as part of this step.** PR #22's tests make that extraction
safe; doing it later means doing the version work twice.

---

## 2. Rake definition

*(verified)* The rule is **per participating player**, and the total is
normally `players × rake` — 8 players at 1,000 is 8,000.

### Who participates

```
activePlayerUids ∪ everyone with a confirmed cash-out
```

Computed in `settleSession`. So:

- someone who stood up at 10pm and left **is** charged
- a seated player with `buyIn = 0` **is** charged *(verified)*

Participation means *seated*, not *invested*.

### The exception that breaks the arithmetic

**A winner is never charged more rake than their profit.** The refund pass caps
it. Measured on an over-declared table:

```
A: gross +3,000, mismatch −2,500, remaining 500
   seat fee charged 500, not 1,000
B, C: charged the full 1,000
```

Losers get no such protection — a busted player pays in full and can finish
owing more than they brought.

### The rule this imposes on every preview

> **Never estimate impact as `participatingPlayers × rake`.**

The winner cap, rounding, the mismatch and `potEnabled` all move the real
figure. A preview that estimates will disagree with the result it previews, and
the disagreement will surface as money.

**Every preview must call the real engine, at the record's own version, over
the record's own stored inputs.** This is a hard constraint on §6, not advice.

---

## 3. Rake ordering and interactions

*(verified, by measurement)*

**Order within `runRake`:** winner's cut first, then the flat seat fee. Both
are summed into a single `rakeDeduction` per player and **cannot be separated
afterwards** — see finding 11 in `SETTLEMENT-REVIEW.md`. A revision that wants
to show "rake changed by X, cut changed by Y" needs the engine to return them
separately; today it cannot.

**`rakeOrder`** affects only the cut:

| | A's mismatch | A's cut |
|---|---|---|
| `MISMATCH_FIRST` | 2,500 | 50 (10% of the 500 left) |
| `RAKE_FIRST` | 2,500 | 300 (10% of gross 3,000) |

The flat fee is identical either way — it is flat, so ordering has nothing to
change. Verified: seat fees `500, 1000, 1000` under both.

**`potEnabled: false`** (v3): nothing is charged at all. 8 players, 1,000 rake
→ 0 total, 0 pot.

**Rounding** applies to the fee: 333 under `NEAREST_10` becomes 330 each, 990
total. The residual from rounding mismatch shares is pushed onto the largest
deduction so the books still reconcile.

**Mismatch strategy** does not touch the fee directly. It changes `remaining`,
which changes the cut, and can trigger the winner refund.

**`winnerDefinition` / `winnerTopN`** decide who the cut applies to. `TOP_N`
breaks ties by array order — seat order, which is arrival order (finding 4).
**This is a replay hazard**: if participant ordering is not stable across a
replay, a tie can resolve differently and change who paid. Replay must preserve
the original participant order, so `playerSummaries` ordering has to be treated
as significant data rather than presentation.

---

## 4. Club rule versions

### Model

```
ClubRuleVersion
  id
  clubId
  version            monotonic per club, starting 1
  effectiveFrom      timestamptz
  supersededAt       timestamptz?      null on the current version
  createdBy, createdAt
  reason             text?
  ...the 11 settlement fields
```

`Club`'s 11 columns become a **cache of the current version**, or are dropped
entirely. Keeping them as a cache is less churn and keeps existing reads
working; the version table is the source of truth.

### Answers to the stated questions

**How are versions created?** Only by an explicit rule change. Creating a club
writes version 1. Each subsequent change closes the current row
(`supersededAt = now`) and inserts the next.

**What makes a version effective?** `effectiveFrom`, which defaults to the
moment of the change. Back-dating `effectiveFrom` is *not* how retroactivity
works — that would silently change which rules a past night claims to have
used. Retroactive application is a separate, explicit operation (§6).

**Which version belongs to a night?** *Not by date lookup.* The night's own
snapshot is the answer where it exists — `engineState.settlementRules`, written
at `startPlaying`. Add `ruleVersionId` alongside it so the night points at the
version rather than only carrying a copy. The copy stays: it is what makes a
night replayable when the version row is unavailable, and it is the record of
what was actually in force.

Date-range lookup is the **fallback for older records only** (§11), and it is a
guess — flagged as such wherever it is used.

**What happens on a rule change?** A new version, effective now. Future nights
snapshot it at `startPlaying`. **Nothing that already exists changes.**

**How are completed nights preserved?** They already carry their own snapshot,
and their `CashOutSettlement` carries the figures. Neither is written again —
corrections create revisions (§10).

**Normal change vs retroactive correction?** They are different operations
against different tables. A rule change writes `ClubRuleVersion`. A retroactive
correction writes `SettlementRevision` rows and requires approval. One cannot
become the other by accident because they do not share a code path.

### `0 → 1,000 → 500`

Three versions, each with its own effective window. A night settled between the
second and third changes points at version 2 and replays under 1,000, whatever
the club says today. The meaning of each period survives.

---

## 5. Historical bank editing

The nearest thing that exists *(verified)*: `requestSessionChange` →
`decidePendingChange` → `applySessionChange`, with `PendingChangeRequest`
carrying `edit_session` / `delete_session`. PR #15 made the applier re-settle
from the session's own snapshot rather than the club's current rules.

Two gaps make it unsuitable as-is:

- **it applies immediately for an owner** *(verified)* — `requestSessionChange`
  returns `{status:'applied'}` without approval when the requester is the owner
- **it overwrites** the settlement row rather than creating a revision

### Design

**Who can request:** any club admin or the owner.

**Who can approve:** any *other* admin or the owner. The requester may never
approve their own — the same rule as buy-ins, and the same helper
(`selfApprovalBlock` / `hasAnotherAdminHere`).

**No second admin?** Unlike a live buy-in, there is no game waiting. The
escape hatch that exists for buy-ins ("being alone, not being senior") should
**not** apply here: a night settled weeks ago is not urgent, and a sole admin
silently rewriting financial history is the exact outcome this design exists to
prevent. A single-admin club queues the request until a second admin exists.
That is a deliberate refusal, and it needs to say so on screen.

**Editable fields:** per-player `totalBuyIn` and `cashOut`, plus the night's
`notes` and `sessionDate`. **Not** the rules — changing the rules for one night
is §6, not a bank edit. **Not** `rakeDeduction` or `netResult`: those are
outputs, and editing an output is how a ledger stops reconciling.

**Recalculation:** replay the whole night through the engine at
`record.engineVersion`, with the record's own rules and the edited inputs. Not
a delta applied to the old outputs — a full recompute from inputs, which is
what makes the operation idempotent.

**Balance reversal/reapplication:** the pot moves by `-ledger.net` then by the
new contribution, exactly as `applySessionChange` does today. Player balances
are derived from records, so they follow — no separate reversal.

**Later settlements already occurred?** They are unaffected: each night's
figures depend only on its own inputs and rules. The one shared, stateful thing
is the pot, and the ledger is per-session so a later night's contribution is
untouched. `Club.clubPotBalance` must be **recomputed from the ledger** rather
than incremented, which also fixes the drift it can accumulate today.

**Concurrency:** one open request per record, enforced inside the row lock —
the same pattern as `entryChanges`. A second request is refused by name. The
apply step re-checks that the record has not been revised since the request was
raised (§7 `expectedRevision`).

**Rejected or cancelled:** the request closes with its status, and stays in the
audit. Nothing is applied. The record's revision number does not move.

---

## 6. Retroactive club-rule application

### Shape

An explicit action, never automatic: **Apply to past nights**, offered after a
rule change, listing the nights it can affect.

### Preview

For each candidate night the preview replays the night in a transaction that is
**never committed**, and shows:

| Column | Source |
|---|---|
| Night, date, players | record |
| Engine version used for replay | `record.engineVersion` |
| Original settlement | stored `playerSummaries` |
| Proposed settlement | replay output |
| Rake difference | proposed − original |
| Per-player balance difference | proposed − original, per player |
| Total difference | sum |
| Pot difference | proposed contribution − ledger net |

**The preview is generated by the real engine, per §2.** No estimate, no
`players × rake`. The preview and the execution run identical code over
identical inputs; the only difference is whether the transaction commits.

Nights that cannot be replayed (§11) appear in a separate section with the
reason, and are excluded from every total. They are never silently skipped.

### Scope selection

The owner chooses which nights, defaulting to none. "All nights" is available
but is a deliberate selection, not the default — a default of "everything" is
how an unnoticed rule change becomes a month of restated results.

---

## 7. Approval for retroactive changes

```
RetroRuleApplication
  id, clubId
  fromRuleVersionId, toRuleVersionId
  sessionIds          the selected nights
  previewDigest       hash of the previewed outcome
  status              pending | approved | rejected | applied | cancelled
  requestedBy, requestedAt
  decidedBy, decidedAt
  appliedAt
```

**Lifecycle:** propose → preview → second-admin approval → execute → audit.

**Approval:** owner or another admin, never the requester. Single-admin clubs
queue, as in §5.

**`previewDigest` is the safety catch.** The approver approves *a specific set
of numbers*. If anything changes between approval and execution — a night
edited, another rule version created — the digest no longer matches and
execution refuses rather than applying something nobody saw. This is the
mechanism that makes "approve what you previewed" literally true.

**Double-application** is prevented three ways, and any one of them suffices:

1. `status` moves to `applied` inside the same transaction that writes the
   revisions, under a row lock
2. every night carries a `revision` integer; execution asserts the expected
   revision and bumps it
3. recomputation is **from inputs**, so applying twice produces the same
   numbers rather than compounding — the failure mode is a no-op, not a
   doubled rake

---

## 8. Audit trail

The existing `AuditLog` (actor, database timestamp, `changes` JSON) stays for
the narrative. The structured record is new.

```
SettlementRevision
  id
  recordId, recordType        cashout | historical
  revision                    1 = original, increments per correction
  engineVersion
  ruleVersionId?
  ruleSnapshot                the 11 settings actually used
  playerSummaries             the full result at this revision
  totals                      buy-ins, cash-outs, rake, pot contribution
  causedBy                    settle | bank-edit | retro-rule | reversal
  causeId                     the request that produced it
  createdBy, createdAt
```

Revision 1 is written **at settle time**, so the original is a revision like any
other rather than a special case. Every correction appends. **Nothing is ever
updated in place**, which is what makes the original permanently recoverable —
your explicit requirement.

For a rule change: old rule, new rule, requester, timestamp, affected nights,
approval, approver, execution result — all present across `ClubRuleVersion` +
`RetroRuleApplication` + the revisions it caused.

For a bank edit: original values, proposed values, requester, approver, before
and after settlements, affected players, balance differences — the before is
revision *n*, the after is revision *n+1*, and the difference is computed rather
than stored.

---

## 9. Accounting invariants

Checked in a **shared harness** run after every settle, every replay, every
revision — not only in tests. A violation aborts the transaction.

**The primary invariant** *(already enforced in tests as `expectBooksBalance`)*:

```
sum(player netResult) + potContribution = 0
```

No chips created, none destroyed.

**The physical invariant** *(`expectTableReconciles`)*:

```
sum(cashOut − deductions) + potContribution = sum(buyIn)
```

What people carry away plus what the pot keeps equals what was bought on. This
one can fail on rounding alone, which is why it is separate.

**Others that must hold:**

- `totalBuyIns` = Σ `totalBuyIn`; `totalCashOuts` = Σ `cashOut`
- `mismatchAmount` = `totalCashOuts − totalBuyIns`
- `totalRakeCollected` = Σ `rakeDeduction`
- rake ≥ 0 for every player; no negative charge
- a winner's `netResult` ≥ 0 — the refund pass guarantees it (§2)
- `potContribution = 0` whenever `potEnabled` is false
- `Club.clubPotBalance` = Σ `ClubPotLog.amount` for the club — **not** true
  today by construction, since the balance is incremented separately
- across revisions: `Σ adjustments = revision_n − revision_1` per player

**Buy-ins are never modified by a rule change.** They are inputs. Any
recalculation that changes a buy-in is a bug.

---

## 10. Already-settled real-world money

The hardest requirement, and the one that decides whether this feature is
honest.

People settled up in cash. Changing a record cannot change that a transfer
happened. So the application must never say "Priya won 4,000" about a night
where she was paid 5,000 — it must say she was paid 5,000, and that under the
corrected rules she should have been paid 4,000, and therefore owes 1,000.

**Three distinct quantities, all persisted:**

| Quantity | Meaning | Source |
|---|---|---|
| **Original settlement** | what the app said at the time, and what people paid on | revision 1 |
| **Corrected settlement** | what the current rules say the night should have been | latest revision |
| **Adjustment** | corrected − original, per player | derived |

```
PlayerAdjustment
  id, revisionId, userId
  originalNet, correctedNet, delta
  status          outstanding | settled | waived
  settledAt, settledBy, note
```

The adjustment is **a new obligation between players**, not a rewriting of the
old one. It has its own lifecycle because it is real money that may or may not
change hands — a club may well decide to waive corrections below some figure
rather than chase 200 chips around a WhatsApp group.

**In History**, a corrected night shows the original result as it was, with the
adjustment beneath it. **In the leaderboard**, the club chooses: totals from
original settlements (what was actually paid) or from corrected ones (what the
rules say). Both are defensible; the choice must be explicit and labelled,
because an unlabelled leaderboard that silently switched basis would be the
same class of problem as the one this design exists to fix.

**The default should be original + settled adjustments** — that is what has
actually moved between people, which is the thing a ledger is for.

---

## 11. Backward compatibility

*(verified)* Three populations, and only one is cleanly replayable.

**Post-PR #12 live nights.** Carry `engineState.settlementRules`. Rules known.
Engine version recoverable from `AuditLog.changes.meta.settlementEngineVersion`
where the audit exists. **Fully replayable.**

**Pre-PR #12 live nights.** No snapshot. Rules were the club's at settle time —
and because `IMMUTABLE_CLUB_RULES` froze them, today's club values *are* the
values that were in force, unless someone bypasses the freeze. Engine version is
whatever shipped at `settledAt`, inferable from the deployment timeline but not
recorded. **Reconstructable with a stated assumption, not from data.**

**Back-dated records.** Never had a session, so never had a snapshot. Rules were
the club's at *recording* time. Same reasoning, same assumption.

### The rule for missing data

> **Do not invent rules.** A record whose original rules cannot be read from
> data is **not replayable** and is excluded from every recalculation.

Concretely:

- backfill `engineVersion` and `ruleSnapshot` **only** where they can be read
  from the audit or the session snapshot
- everything else gets `engineVersion = NULL`, `ruleSnapshot = NULL`, and a
  `replayable = false` flag
- unreplayable nights appear in previews in their own section, with the reason,
  excluded from totals
- a one-off **owner-confirmed** backfill may set rules for those nights
  explicitly — the same shape as `initSettlementRules`: stated by a human,
  audited, once, never guessed

**Triage first.** Before any of this is designed further, run a query that
counts each population for real clubs. If the unreplayable set is empty the
handling is a formality; if it is most of the history, that changes the value of
the whole feature. This is a query, not a feature, and it should happen first.

---

## 12. Proposed sequence

Your order, with four changes and the reasons.

| # | Step | Why here |
|---|---|---|
| 0 | **Replayability triage** | A query. Decides whether the rest is worth building, and sizes §11. Hours, not days. |
| 1 | **Revision + adjustment model** (§8, §10) | Moved to the front. Every later step writes revisions; if replay lands first it has nothing to write into and will overwrite. Includes writing revision 1 at settle time, which is behaviour-preserving and provable on its own. |
| 2 | **Versioned engine dispatch + golden fixtures** (§1) | Before rule versions: replaying a night needs its *engine*, and the night already carries its *rules*. This unblocks the bank edit without the rule-version model existing. **Extract to one shared module here.** |
| 3 | **Invariant harness** (§9) | Runs in production, not only tests. Every later step is a money mutation and this is the seatbelt. |
| 4 | **Single-bank edit on revisions** (§5) | The smallest blast radius that exercises the whole machine: request, approval, replay, revision, adjustment, audit. Prove it on one night before offering it on fifty. |
| 5 | **Club rule versions** (§4) | Now needed, because retroactive application is the first thing that has to ask "which rules, as of when". |
| 6 | **Retroactive preview** (§6) | Read-only. Ships independently and is worth having alone — an owner can see the consequence of a rule change without being able to apply it. |
| 7 | **Bulk apply + approval** (§7) | The only step that writes at scale, and the last to be built. |
| 8 | **History UI** (§5) | Last, on machinery already proven by API tests. |

**The four changes to your ordering:**

**Revision model first, not fourth.** This is the significant one. Replay
infrastructure with nowhere to write produces an overwrite, and overwriting is
the thing we are trying to stop. The representation has to exist before the
first correction runs.

**Audit folded into step 1** rather than standing alone. `SettlementRevision`
*is* the audit for settlement; a separate audit model built later would
duplicate it and drift.

**Engine dispatch before rule versions.** A night carries its own rules already,
so the bank edit needs versioned *replay* but not rule *versions*. Swapping
these ships step 4 sooner and defers the largest data-model change until
something concrete needs it.

**Preview split from apply.** Read-only and genuinely useful on its own. It also
means the riskiest code is exercised against real data for a while before it is
ever allowed to commit.

**Not in scope, deliberately:** unfreezing `IMMUTABLE_CLUB_RULES`. That is the
prerequisite for a *normal* rule change, and it belongs with step 5 — but until
`ClubRuleVersion` exists, unfreezing re-opens the exact hole the freeze covers.
Doing it earlier would leave a window where a rule change silently changes what
any unreplayable night claims to have used.
