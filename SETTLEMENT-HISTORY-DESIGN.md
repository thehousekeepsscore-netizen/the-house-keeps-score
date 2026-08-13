# Settlement history — technical design

A design for changing settled nights safely: versioned replay, club-rule
versions, single-bank edits, and deliberate retroactive rule application.

**Nothing here is implemented.** Every statement about current behaviour was
verified against the running code or the schema during the investigation that
produced this document; those are marked *(verified)*. Everything else is a
proposal.

The organising idea, and the one thing worth agreeing before the detail:

> **The latest approved settlement is the settlement.** An approved correction
> overwrites the settled night. Previous settlements are retained as audit and
> recovery history — never presented as a competing financial result.

A night therefore has exactly one current answer at any moment. History, Ranks,
player balances and the club pot all read that answer and only that answer.
What the night used to say is reachable, by an authorised user, through a
change history — the way you reach a file's previous versions, not the way you
read two files side by side.

Two consequences of that choice are load-bearing everywhere below:

**Recalculation is always from inputs, never from outputs.** A correction
replays `stored inputs → chosen engine version → chosen rules → new
settlement`. It never takes the existing settlement and adds a difference to
it. This is what makes correcting the same night twice produce the same answer
as correcting it once, and it is why inputs and outputs have to stop sharing a
column (§13.1).

**The audit copy is written before the overwrite, in the same transaction, or
the overwrite does not happen.** With nothing competing on screen, the revision
log is the *only* surviving record of what the night used to say. It stops
being documentation and becomes the recovery path. §13 is about what that costs.

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

Four facts do most of the work in this design:

**Replay inputs are preserved.** `playerSummaries` carries `totalBuyIn` and
`cashOut` per player — the engine's *inputs*, not just its outputs. Any settled
night can therefore be recomputed. `applySessionChange` already does this.

**The leaderboard is derived at read time** from `HistoricalSessionRecord` +
`CashOutSettlement`. Overwrite those rows and History, Ranks and player
balances follow with no further work. There is no stored aggregate to keep in
sync. This is the single largest reason overwrite semantics are cheap here.

**The pot already has a reverse-and-reapply pattern.** `potLedgerFor` returns
`net` and `intended` (excluding reversals), and `applySessionChange` moves the
pot by `-net` before applying the new figure. The correct shape, and reusable.

**Overwrite is already the existing behaviour.** *(verified)* `applySessionChange`
overwrites the settlement row today. This design is therefore not a change of
semantics — it is the addition of the audit copy, the approval gate and the
versioned replay that overwriting has been missing.

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
was never changed. Under overwrite semantics that reinterpretation would land
on the visible result, which is why versioned dispatch is a precondition for
correcting anything rather than a refinement of it.

### Where the version lives

*(verified)* `CashOutSettlement` does **not** record an engine version.
`AuditLog.changes.meta.settlementEngineVersion` does, but only for nights
settled after PR #12, and it is keyed by the settlement id rather than the
session id.

**Proposal.** Add `engineVersion INT` to `CashOutSettlement` and
`HistoricalSessionRecord`, backfilled per §11. The version belongs on the
record it produced, not only in an audit row that may not exist.

**A correction does not change it.** Replay uses the record's *own* engine
version, so the night keeps meaning what it meant. Moving a night onto a newer
engine is a different operation with a different name — "re-settle under engine
vN" — and it must be chosen explicitly, previewed like any other change, and
recorded as such in the revision. A rule change must never quietly carry an
engine upgrade along with it.

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
preview replays a *different version* than the server commits. Under overwrite
that drift is worse than before: the approver sees one set of numbers and a
different set becomes the night. **Extract the engine to one shared module as
part of this step.** PR #22's tests make that extraction safe; doing it later
means doing the version work twice.

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
under overwrite semantics the result it previews is the one that replaces the
night. The disagreement would surface as money, after the fact, with the
original already gone from the screen.

**Every preview must call the real engine, at the record's own version, over
the record's own stored inputs.** This is a hard constraint on §6, not advice.

---

## 3. Rake ordering and interactions

*(verified, by measurement)*

**Order within `runRake`:** winner's cut first, then the flat seat fee. Both
are summed into a single `rakeDeduction` per player and **cannot be separated
afterwards** — see finding 11 in `SETTLEMENT-REVIEW.md`.

This now has a direct cost. Your audit requirement asks for **rake differences
and winner's-cut differences separately**, and today's engine cannot supply
them: it returns one fused number. Splitting `rakeDeduction` into
`seatFee` + `winnersCut` in the engine's output is therefore **a prerequisite
of the audit trail**, not the safe-and-optional cleanup it was in the review.
It is still safe — no change to any arithmetic, only to the shape of what is
returned — but it has moved onto the critical path.

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
the original participant order, so participant order is **stored input**, not
presentation — see §13.1.

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
used, and under overwrite semantics "silently" would mean the night's visible
result no longer matches any recorded decision. Retroactive application is a
separate, explicit, approved operation (§6).

**Which version belongs to a night?** *Not by date lookup.* The night's own
snapshot is the answer where it exists — `engineState.settlementRules`, written
at `startPlaying`. Add `ruleVersionId` alongside it so the night points at the
version rather than only carrying a copy. The copy stays: it is what makes a
night replayable when the version row is unavailable, and it is the record of
what was actually in force.

Date-range lookup is the **fallback for older records only** (§11), and it is a
guess — flagged as such wherever it is used.

**What happens on a rule change?** A new version, effective now. Future nights
snapshot it at `startPlaying`. **Nothing that already exists changes.** Past
nights move only through §6, and only with approval.

**How are completed nights preserved?** Each carries its own rule snapshot and
its own engine version. A correction replays under whichever rules were
explicitly chosen and records both the before and after rule sets in the
revision (§8).

**Normal change vs retroactive correction?** Different operations, different
tables, no shared code path. A rule change writes `ClubRuleVersion` and touches
no settled night. A retroactive correction writes revisions and overwrites
settlements, and requires approval. One cannot become the other by accident.

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

It already overwrites, which is now the intended semantics. Three gaps remain:

- **it applies immediately for an owner** *(verified)* — `requestSessionChange`
  returns `{status:'applied'}` without approval when the requester is the owner
- **it keeps no before-copy**, so the overwrite is unrecoverable
- **it replays at the current engine**, not the record's own version

### Design

**Who can request:** any club admin or the owner.

**Who can approve:** any *other* admin or the owner. The requester may never
approve their own — the same rule as buy-ins, and the same helper
(`selfApprovalBlock` / `hasAnotherAdminHere`).

**No second admin?** Unlike a live buy-in, there is no game waiting. The
escape hatch that exists for buy-ins ("being alone, not being senior") should
**not** apply here: a night settled weeks ago is not urgent, and a sole admin
silently overwriting financial history is the exact outcome this design exists
to control. A single-admin club queues the request until a second admin exists.
That is a deliberate refusal, and it needs to say so on screen.

**Editable fields:** per-player `totalBuyIn` and `cashOut`, plus the night's
`notes` and `sessionDate`. **Not** the rules — changing the rules for one night
is §6, not a bank edit. **Not** `rakeDeduction` or `netResult`: those are
outputs, and editing an output is how a ledger stops reconciling.

**Recalculation:** replay the whole night through the engine at
`record.engineVersion`, with the record's own rules and the edited inputs. Not
a delta applied to the old outputs — a full recompute from inputs, which is
what makes the operation idempotent and what stops a second correction from
compounding the first.

**Balance reversal/reapplication:** the pot moves by `-ledger.net` then by the
new contribution, exactly as `applySessionChange` does today. Player balances
are derived from records, so they follow the overwrite with no separate step.

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
audit. Nothing is applied, the live settlement is untouched, and the record's
revision number does not move.

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
| Current settlement | the live record |
| Proposed settlement | replay output |
| Seat-fee difference | proposed − current *(needs §3's split)* |
| Winner's-cut difference | proposed − current *(needs §3's split)* |
| Per-player balance difference | proposed − current, per player |
| Total difference | sum |
| Pot difference | proposed contribution − ledger net |

**The preview is generated by the real engine, per §2.** No estimate, no
`players × rake`. The preview and the execution run identical code over
identical inputs; the only difference is whether the transaction commits.

Nights that cannot be replayed (§11) appear in a separate section with the
reason, and are excluded from every total. They are never silently skipped.

The preview is also the last moment anyone sees the current figures on a normal
screen. That is an argument for it being generous rather than terse — full
per-player before-and-after, not a summary — because after approval the before
lives only in the change history.

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
  reason              text, required
  status              pending | approved | rejected | applied | cancelled
  requestedBy, requestedAt
  decidedBy, decidedAt
  appliedAt
```

**Lifecycle:** propose → preview → second-admin approval → **overwrite** →
audit.

**Approval:** owner or another admin, never the requester. Single-admin clubs
queue, as in §5.

**`previewDigest` is the safety catch.** The approver approves *a specific set
of numbers*. If anything changes between approval and execution — a night
edited, another rule version created, an engine deployed — the digest no longer
matches and execution refuses rather than overwriting something nobody saw.
This is the mechanism that makes "approve what you previewed" literally true,
and it matters more under overwrite than it would have under a side-by-side
model: there is no second column afterwards in which a surprise would show up.

The digest must cover the inputs, the rules, the engine version and the full
per-player output — not the totals. Two different distributions can share a
total.

**Double-application** is prevented three ways, and any one of them suffices:

1. `status` moves to `applied` inside the same transaction that writes the
   revisions and overwrites the records, under a row lock
2. every record carries a `revision` integer; execution asserts the expected
   revision and bumps it
3. recomputation is **from inputs**, so applying twice produces the same
   numbers rather than compounding — the failure mode is a no-op, not a
   doubled rake

Point 3 is the reason the "from inputs, never from outputs" rule is not merely
stylistic. Under a delta model, a retried or duplicated apply would double the
rake and there would be no undisturbed original left on screen to notice it
against.

---

## 8. Revisions: audit and recovery

The existing `AuditLog` (actor, database timestamp, `changes` JSON) stays for
the narrative — who did what, in one feed, alongside everything else. The
structured record is new, and under overwrite semantics it is the only thing
standing between a bad replay and a lost night.

```
SettlementRevision
  id
  recordId, recordType        cashout | historical
  revision                    1 = original, increments per correction
  isLive                      exactly one true per record
  supersedesRevision          the revision this replaced (null at 1)

  engineVersion               the version used to produce THIS revision
  ruleVersionId?
  ruleSnapshot                the 11 settings actually used

  inputs                      per player: totalBuyIn, cashOut, and the
                              participant ORDER (§3 — ties depend on it)
  outputs                     per player: netResult, seatFee, winnersCut,
                              isWinner
  totals                      buy-ins, cash-outs, rake, cut, pot contribution

  causedBy                    settle | bank-edit | retro-rule | engine-migration | revert
  causeId                     the request that produced it
  reason                      text — required for everything except `settle`
  requestedBy, approvedBy
  createdAt
```

**One live revision, enforced by the database.** A partial unique index —
`UNIQUE (recordId, recordType) WHERE isLive` — makes "there are never two
competing current settlements" a constraint rather than a convention. The live
revision's `outputs` are what the `CashOutSettlement` row contains; the row and
the revision are written in the same transaction and cannot disagree.

**Revision 1 is written at settle time**, so the original is an ordinary
revision rather than a special case, and every later correction has something
to supersede.

**Nothing is ever updated in place in this table.** Correcting a night appends
revision *n+1*, flips `isLive`, and overwrites the settlement row. The previous
revision stays exactly as it was written. That is what makes the original
permanently recoverable when it is no longer permanently visible.

### What the audit contains, against your list

| You asked for | Where it comes from |
|---|---|
| Original settlement | revision 1 `outputs` |
| Corrected settlement | live revision `outputs` |
| Who requested | `requestedBy` |
| Who approved | `approvedBy` |
| When | `createdAt` |
| Reason | `reason` (required) |
| Rules before / after | `ruleSnapshot` on revisions *n* and *n+1* |
| Engine version before / used | `engineVersion` on revisions *n* and *n+1* |
| Player-by-player differences | computed from the two `outputs` |
| Pot differences | `totals.potContribution` on both, plus `ClubPotLog` |
| Rake differences | `totals.seatFee` on both — **requires §3's split** |
| Winner's-cut differences | `totals.winnersCut` on both — **requires §3's split** |

Differences are **computed on read, not stored**. A stored delta is a second
source of truth for the same fact, and it can disagree with the revisions it
claims to describe.

### Revert

Because the previous result is no longer on screen, "put it back" has to be a
real operation rather than an implied one.

**Revert to revision *k*** replays `revision_k.inputs` under
`revision_k.ruleSnapshot` at `revision_k.engineVersion`, and writes the result
as revision *n+1*. It does not copy the old outputs across and it does not move
`revision` backwards. So a revert is verified rather than trusted: if the
replay does not reproduce `revision_k.outputs` exactly, something is wrong with
the engine dispatch and the operation aborts instead of restoring numbers that
today's code can no longer explain.

Revert goes through the same approval gate as any other correction.

### Who can see it

The live settlement is visible to everyone who can see the night. The change
history is **admin and owner only** — it is the club's financial audit, and
showing every player a stack of superseded results is precisely the "two
competing answers" this design removes.

A corrected night should carry a small, unobtrusive marker (a "corrected" tag
with a date) so an admin knows a history exists without it competing with the
result. Players see the same marker but land on their adjustment (§10), not on
a diff.

---

## 9. Accounting invariants

Checked in a **shared harness** run after every settle, every replay, every
revision — not only in tests. A violation aborts the transaction, which under
overwrite semantics means the live record is left untouched rather than left
half-corrected.

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
- `totalRakeCollected` = Σ (`seatFee` + `winnersCut`)
- rake ≥ 0 for every player; no negative charge
- a winner's `netResult` ≥ 0 — the refund pass guarantees it (§2)
- `potContribution = 0` whenever `potEnabled` is false
- `Club.clubPotBalance` = Σ `ClubPotLog.amount` for the club — **not** true
  today by construction, since the balance is incremented separately

**Invariants specific to overwrite:**

- exactly one `isLive` revision per record — a database constraint, not a check
- the live revision's `outputs` equal the settlement row's `playerSummaries`,
  field for field
- `revision` on the record equals the live revision's number
- a correction's `inputs` equal the previous revision's `inputs` **unless**
  `causedBy = 'bank-edit'` — a rule change that moved a buy-in is a bug, and
  this is where it gets caught
- every record that can be corrected has a revision 1 (§13.3)

**Buy-ins are never modified by a rule change.** They are inputs.

---

## 10. Already-settled real-world money

The hardest requirement, and the one overwrite semantics make sharper rather
than softer.

People settled up in cash. Overwriting the record cannot change that a transfer
happened. After a correction the app will say Player B lost 6,000 — but B
handed over 5,000 that night, and the app no longer shows 5,000 anywhere a
player looks.

**So the obligation has to be stored explicitly.** With the original no longer
on screen, an adjustment ledger is not a nicety; it is the only remaining
representation of the gap between what the record now says and what actually
changed hands.

```
PlayerAdjustment
  id, recordId, userId
  paidBasisRevision      the revision the cash was actually settled on
  paidNet                that revision's net for this player
  currentNet             the live revision's net
  delta                  currentNet − paidNet
  status                 outstanding | settled | waived
  settledAt, settledBy, note
```

**The anchor is what was paid, not the previous revision.** This is the same
determinism rule as §5, one layer up. If a night is corrected twice before
anyone settles the difference, `delta` is recomputed against `paidBasisRevision`
and the outstanding row is **replaced**, not added to. Chaining
`revision_n − revision_{n−1}` would invent a second obligation for a difference
that was never paid — the cumulative error you ruled out at the settlement
layer, reappearing in the money-owed layer.

When an adjustment is marked settled, `paidBasisRevision` advances to the live
revision. The gap closes and the next correction measures from there.

**In History**, a corrected night shows the corrected settlement as the result —
full stop. Beneath it, for each player with an outstanding adjustment, a
separate line: *paid 5,000, should have paid 6,000, owes 1,000*. It reads as a
reconciliation item, not as an alternative net, and it is the only place the
old figure appears in a player-facing screen.

**In the leaderboard**, the corrected settlement, always. There is no
club-configurable basis and no "original vs corrected" toggle — that toggle
would be exactly the two competing results this design removes. The cost is
that the leaderboard now measures *what the rules say* rather than *what
changed hands*, and those diverge by the outstanding adjustments. That
divergence should be visible as a club-level figure ("₹3,400 in outstanding
corrections") rather than hidden inside the rankings.

**A club may waive.** Chasing 200 chips around a WhatsApp group is worse than
absorbing it, and `waived` records that decision rather than pretending the
difference never existed.

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

Under overwrite semantics this rule is stricter than it sounds: replaying an
unreplayable night does not produce a questionable extra column, it *replaces*
the only figures anyone has. A guess would become the record.

Concretely:

- backfill `engineVersion` and `ruleSnapshot` **only** where they can be read
  from the audit or the session snapshot
- everything else gets `engineVersion = NULL`, `ruleSnapshot = NULL`, and a
  `replayable = false` flag
- unreplayable nights appear in previews in their own section, with the reason,
  excluded from totals, and **cannot be selected**
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
| 1 | **Revision model + backfill of revision 1** (§8, §13.3) | Moved to the front, and now a hard gate: overwriting without a before-copy is unrecoverable. Includes the `isLive` constraint, writing revision 1 at settle time, and backfilling revision 1 for every existing record. |
| 2 | **Split `rakeDeduction` into seat fee + cut** (§3) | Small, no arithmetic change — but the audit trail you specified cannot be produced without it, so it stops being optional. |
| 3 | **Versioned engine dispatch + golden fixtures** (§1) | Before rule versions: replaying a night needs its *engine*, and the night already carries its *rules*. **Extract to one shared module here.** |
| 4 | **Invariant harness** (§9) | Runs in production, not only tests. Every later step overwrites money and this is the seatbelt that aborts before it lands. |
| 5 | **Single-bank edit** (§5) | The smallest blast radius that exercises the whole machine: request, approval, replay, revision, overwrite, adjustment, audit. Prove it on one night before offering it on fifty. |
| 6 | **Change history UI + revert** (§8) | Immediately after the first thing that can overwrite. Recovery is not a later polish item once corrections are live. |
| 7 | **Club rule versions** (§4) | Now needed, because retroactive application is the first thing that has to ask "which rules, as of when". |
| 8 | **Retroactive preview** (§6) | Read-only. Ships independently and is worth having alone — an owner can see the consequence of a rule change without being able to apply it. |
| 9 | **Bulk apply + approval** (§7) | The only step that overwrites at scale, and the last to be built. |

**The four changes to your ordering:**

**Revision model first, not fourth.** The significant one, and overwrite
semantics strengthen rather than weaken it. Replay infrastructure that lands
before the revision model *is* an unrecoverable overwrite. The before-copy has
to exist before the first correction can run.

**Audit folded into step 1** rather than standing alone. `SettlementRevision`
*is* the audit for settlement; a separate audit model built later would
duplicate it and drift.

**Engine dispatch before rule versions.** A night carries its own rules already,
so the bank edit needs versioned *replay* but not rule *versions*. Swapping
these ships step 5 sooner and defers the largest data-model change until
something concrete needs it.

**Preview split from apply.** Read-only and genuinely useful on its own. It also
means the riskiest code is exercised against real data for a while before it is
ever allowed to commit.

**One addition since the last draft:** the change-history UI and revert (step 6)
move up to sit directly behind the first overwrite. Under the previous model the
original stayed on screen, so a viewer for old revisions was a convenience.
Overwriting makes it the only way to see what a night used to say.

**Not in scope, deliberately:** unfreezing `IMMUTABLE_CLUB_RULES`. That is the
prerequisite for a *normal* rule change, and it belongs with step 7 — but until
`ClubRuleVersion` exists, unfreezing re-opens the exact hole the freeze covers.
Doing it earlier would leave a window where a rule change silently changes what
any unreplayable night claims to have used.

---

## 13. Technical consequences of overwrite semantics

Collected here rather than scattered, because these are the things that change
as a direct result of the decision, and they are what the review should push
hardest on.

### 13.1 Inputs and outputs must stop sharing a column

*(verified)* `playerSummaries` holds `totalBuyIn` and `cashOut` (inputs)
alongside `netResult` and `rakeDeduction` (outputs), in one JSON blob.
Overwriting that blob overwrites the replay basis together with the result.

For a rule change the inputs are recomputed identically, so nothing is lost by
luck. That is not a guarantee, it is a coincidence of the current code, and
"the inputs survived because we happened to write the same values back" is not
a property to build a financial ledger on.

**Consequence.** The revision's `inputs` block becomes the canonical replay
basis, written before the overwrite and never derived from a settlement row
afterwards. Participant order lives there too (§3 — `TOP_N` ties are decided by
it, so it is data, not presentation).

A bank edit is then the *only* operation that produces a new input set, and
§9's invariant enforces exactly that.

### 13.2 The revision write and the overwrite are one transaction, or neither

If the settlement row is updated and the revision write fails, the previous
result is gone with no copy. Ordering inside the transaction is not enough —
they must share it, and the invariant harness must run inside it too, before
commit. An invariant violation leaves the live record exactly as it was.

This also means the correction path cannot be a background job that "eventually"
writes its audit.

### 13.3 Every existing record needs a revision 1 before anything can be corrected

Revision 1 is written at settle time going forward. Records that already exist
have none — so the first correction of an old night would overwrite it with
nothing to fall back to.

**Consequence.** A backfill that writes revision 1 for every existing
`CashOutSettlement` and `HistoricalSessionRecord` from its current stored
state, and a hard precondition on every correction: *no revision 1, no
correction*. This is step 1, not a migration to tidy up later.

Note that a backfilled revision 1 carries `engineVersion = NULL` and
`ruleSnapshot = NULL` for the unreplayable populations (§11). It still serves
its purpose — it preserves the outputs — but such a record cannot be corrected,
because it cannot be replayed. The two facts are consistent and both need to be
stated in the UI.

### 13.4 The preview becomes the last honest look

Under a side-by-side model, a wrong correction is visible next to the original
forever. Under overwrite, once it commits, the wrong figures *are* the night
and the right ones are behind an admin-only history.

**Consequences:** the preview must be per-player and complete rather than
summarised (§6); `previewDigest` must cover the full distribution rather than
totals (§7); and the approver's screen should state plainly that this replaces
the settled result.

### 13.5 Exported and remembered figures diverge silently

People screenshot the settlement and paste it into WhatsApp. After a
correction, the app no longer agrees with that screenshot and offers no
explanation at the point of confusion.

The `corrected` marker with its date (§8) is the cheapest answer, and the
adjustment line (§10) is the complete one. Worth deciding deliberately rather
than discovering at 1am.

### 13.6 What overwrite makes cheaper

Not everything gets harder, and this is a real argument in its favour:

- **No read-path changes at all.** History, Ranks, player balances and the pot
  already read the settlement row. They keep working with no awareness that
  corrections exist. The side-by-side model would have touched every one of
  them, plus a basis choice in each.
- **No "which result is current" logic** anywhere in the app, and no way for
  two screens to disagree about it. The `isLive` index makes it structural.
- **It matches the existing behaviour** of `applySessionChange` *(verified)*,
  so the change is additive — audit, approval, versioned replay — rather than a
  reversal of how corrections already work.
- **The leaderboard needs no recomputation**, because it is derived. Overwrite
  the row and the rankings are correct on the next read.

### 13.7 What it makes riskier, stated plainly

- **A replay bug destroys the visible truth.** Mitigated by: revision-before-
  overwrite (§13.2), invariants inside the transaction (§9), golden fixtures per
  engine version (§1), verified revert (§8), and preview-digest matching (§7).
  Every one of those exists because of this decision.
- **The unreplayable population becomes dangerous rather than merely awkward.**
  Hence: cannot be selected, not just excluded from totals (§11).
- **The audit stops being documentation and becomes infrastructure.** If the
  revision table is ever wrong, incomplete, or written outside the transaction,
  there is no other copy. It deserves the same test discipline as the engine —
  which is the argument for step 1 shipping with its own tests before anything
  can write to it.
