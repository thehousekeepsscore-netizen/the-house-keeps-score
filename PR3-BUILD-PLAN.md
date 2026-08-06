# PR #3 — Poker Night Experience · build plan

**Date:** 2026-08-06 · **Base:** `main` @ `5ce45fa` · **Status:** plan only, no code
**Scope:** action queue · new player table · player sheet · admin buy-in ·
contextual cash-out · better session flow · progressive settlement · review
screen · reconciliation language · balance indicator

**Deliberately excluded:** `requestedBy` · `approvedAt` · provenance ·
notification wording · Meta templates · activity timeline · database migrations.
No schema change, no settlement-rule change, no permission change.

---

## 1. The one consequence of that exclusion, recorded

Admin-initiated buy-in **works today** without the provenance fix:
`requestBuyIn` writes `requestedBy: userId` — the *target* — so the
self-approval guard at
[offlineSessions.service.ts:544](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:544)
never fires when an admin banks someone else.

The cost: every host-initiated buy-in is recorded as though the player asked for
it. That is true today, but today nobody does it — there is no UI. **This PR
makes it the primary flow**, so the volume of unattributable records goes from
roughly zero to most of them, until the ledger PR lands.

Decided and proceeding. Written down so it is not rediscovered as a surprise.

---

## 2. Two corrections to the Part 2 design, before it is built

### 2.1 The difference is only benign in one direction

`mismatchAmount = totalCashOuts − totalBuyIns`
([settlementEngine.ts:379](apps/web/src/lib/settlementEngine.ts:379)).

| Sign | Meaning | Where the money goes | Benign? |
|---|---|---|---|
| **Negative** — buy-ins exceed cash-outs | Unclaimed chips | Club pot, or untracked if the pot is off | **Yes** |
| **Positive** — cash-outs exceed buy-ins | The club owes more than it collected | **Deducted from the winners** | **No** |

The proposed copy — *"This is expected"* — is right for the first and wrong for
the second. In the positive case two named people earn less than they counted,
and §12.2 of the brief requires saying who paid. The engine already builds that
sentence into `SettlementResult.steps`; it is simply never rendered.

### 2.2 The difference is not "distributed as rake and winner's cut"

Those are computed **separately** in `computeRake` — a flat table fee plus a
percentage of each winner's profit. Both also land in the pot, but they are a
different figure entirely. With a ₹500 flat rake, copy claiming a ₹350
difference "became" the rake would be off by ₹150 and wrong in kind.

Correct framing for the sketch's own example (₹42,000 in, ₹41,650 out):

```
   ₹350 was bought in but never cashed out.
   Your club sends this to the pot.

   [ That's right ]        [ Recount ]
```

And "choose where it belongs" is not implementable: for every strategy except
`MANUAL` the club has already decided, and `settleSession` accepts
`mismatchAcknowledged` — not a destination. Stating the rule and confirming it
is the same number of decisions with no engine change.

---

## 3. The night's phases, derived from data that already exists

No schema change. Every phase is computable from `activePlayerUids`, `cashOuts`
and `status`.

| Phase | Condition | Screen leads with | One action |
|---|---|---|---|
| **Dark** | no active session | last night's result | Start tonight |
| **Opening** | active · no approved buy-in yet | who's here | Bank a player |
| **Running** | ≥1 banked · no confirmed cash-out | queue, else scoreboard | contextual |
| **Winding down** | ≥1 confirmed cash-out · `activePlayerUids` non-empty | who is still counted in | Count next player out |
| **Ready** | `activePlayerUids` empty · ≥2 settlement uids | "Everyone has left" | **Review & settle** |
| **Closed** | `status === 'settled'` | the receipt | — |

`settlementUids` = `activePlayerUids` ∪ confirmed cash-out uids
([ClubDetailView:697](apps/web/src/components/ClubDetailView.tsx:697)) — someone
who stood up has left the seat list but still settles.

**Ready requires ≥2 settlement uids.** `settleSession` rejects a one-player
night, and the current screen only discovers that on submit.

---

## 4. The indicator changes meaning at the phase boundary

This is the subtlety in "progressive settlement", and getting it wrong would
manufacture alarm.

**During play, the app cannot compute a meaningful difference** — most of the
money is still on the table as chips it does not know about. Buy-ins ₹42,000
against cash-outs ₹8,200 is not a ₹33,800 discrepancy; it is a night in
progress.

So the indicator is **two different things** with an explicit label change:

```
   Winding down          ▓▓▓▓▓▓▓▓▓░░░░░   5 of 8 counted out
                         progress — no money claim

   Ready                 ₹42,000 in  ·  ₹41,650 out
                         ₹350 to the pot
                         reconciliation — money claim
```

Never a "difference" figure before every player is counted out.

---

## 5. Commit slices

Built alongside the existing screen behind a flag; the old tab stays default
until the final commit. Fifteen commits, each green.

### Part 1 — Live session

| # | Commit | Notes |
|---|---|---|
| 1 | Phase derivation + tests | Pure function, no UI. The spine everything reads. |
| 2 | Player identity — stable colour/motif per uid | Consumed by 3, 4, 8, 12 |
| 3 | New session screen skeleton behind a flag | Renders phases 1–3, old screen untouched |
| 4 | Player table — five seat states, adaptive geometry | Photos, generated placeholders, second channel for every colour |
| 5 | Action queue with countdown + 400ms debounce + expiry corpse | The 5-minute TTL made visible |
| 6 | Player sheet — top action is whatever is pending | Makes the one-pending 409 unreachable |
| 7 | Buy-in sheet — personal presets, keypad, labelled commit | Amount on the button |
| 8 | Admin-initiated buy-in — composes the two existing calls | Degrades to the request flow on failure |
| 9 | Contextual cash-out — typed, explicit commit, never presets | Removes the permanent button |
| 10 | Session naming — `Fri 8 Aug` + `Night 12` metadata | Club name once |

### Part 2 — End of night

| # | Commit | Notes |
|---|---|---|
| 11 | Winding-down phase + progress indicator | Progress only, no money claim |
| 12 | Ready phase — "Everyone has left · Review & settle" | Blocks below 2 players, with a reason |
| 13 | Review screen — people not transactions, derivation on tap | Pre-filled from approved buy-ins + confirmed cash-outs |
| 14 | Reconciliation language + direction-aware difference | Names who paid when winners absorb it |
| 15 | Flag flip — new screen default, old tab deleted | The revert point |

**Commit 15 is the revert target.** Everything before it is inert for users.

---

## 6. What must not change, and how that is proven

- `computeSettlement` untouched; both engine copies stay in lockstep. **If an
  existing engine test needs editing, the change is wrong.**
- `settleSession` still receives `entries` + `mismatchAcknowledged`, nothing more.
- Permissions untouched — the self-approval guard keeps its current predicate.
- No migration.

Regression gate before commit 15: replay Nights 1–5 from
[`IA-PRESSURE-TEST.md`](IA-PRESSURE-TEST.md) §5 through both screens and assert
**identical settlement figures**, byte for byte. Presentation is the only
difference.

---

## 7. Open, non-blocking

- The review screen assumes every player cashed out **through the app**. Someone
  who left without one leaves a blank the host must type. Commit 13 must handle
  that rather than assume a pre-filled form.
- Existing sessions mid-flight when this deploys: the phase derivation reads
  fields they already have, so they land in the right phase. Worth one manual
  check against the live club before flipping the flag.
