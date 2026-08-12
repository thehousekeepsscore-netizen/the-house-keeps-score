# Settlement — design review

Written after wiring the Phase 1 workflow (PR #8), before any settlement logic
is redesigned. **Nothing in this document has been changed in the code.** It
exists so Phase 2 starts from observations rather than assumptions.

Every numbered finding below was reproduced against the real engine, either by
running it or by reading the path that produces it. Where numbers appear, they
came out of `computeSettlement`, not out of an argument about it.

The engine itself is good: config-driven, no hardcoded percentages, an explicit
pipeline, and it explains its own reasoning in `steps[]`. The findings are about
its edges, not its shape.

---

## The one that leaked money

### 1. ~~Rake is collected even when there is no pot to collect it into~~ — FIXED

**Fixed in PR #21 (engine version 3).** `chargesRake` now requires `potEnabled`,
so a club with charges configured and the pot switched off charges nobody, and
the steps log says why instead of saying it afterwards. `sum(nets) + pot` is 0
where it was −600. Left below as the record of what it was.

`computeRake` runs whenever a rake is configured. `potContribution` is then
forced to `0` if `potEnabled` is false — but the deduction has already been
taken off every player.

Two players, `potEnabled: false`, flat rake 300 and a 10% winners' cut:

```
win   rake=450   net=+2550
lose  rake=150   net=-3150
totalRakeCollected = 600     potContribution = 0
sum(nets) = -600
```

600 chips came off the table and were credited to nobody. The engine notices
and says so in `steps[]` — *"Club Pot is disabled — no balance was updated"* —
but it says it after taking the money. Every other path in this engine holds
`sum(nets) + pot = 0`. This one does not.

**Severity: high.** Real chips, silently unaccounted, on a setting a club can
switch on by accident.

**Options for Phase 2:** skip `computeRake` entirely when `potEnabled` is
false; or keep charging and record the take somewhere else; or refuse the
configuration at the club-settings level. The first is the smallest and matches
what the steps log already claims happened.

---

### 2. A shortfall with the pot disabled vanishes from the books

Same shape, different cause. Buy-ins 10,000, cash-outs 7,000:

```
mismatch = -3000   resolution = 'shortfall_unresolved'
potContribution = 0   sum(nets) = -3000
```

3,000 chips are unclaimed and nothing records where they went. This one is at
least *named* (`shortfall_unresolved`) rather than silent, and it is arguably
correct — nobody lost anything they didn't already lose. But the night's books
do not balance, and no screen currently tells the host that.

**Severity: medium.** Correct-ish, invisible, and indistinguishable at a glance
from a night that reconciled.

---

## The ones that surprise a player

### 3. A player can end the night owing more than they brought

The flat session rake is split equally across everyone, winners and losers
alike. The refund pass at the end of `computeSettlement` only protects players
with `grossProfit > 0`, so it never sees this case.

Bought in for 5,000, lost every chip, flat rake 400 across two players:

```
bust   bought=5000   out=0   net=-5200
```

They put 5,000 on the table and owe 5,200. The 200 is their share of the table
fee, which is a defensible rule — a room costs what it costs — but it is a rule
nobody is told, and "you lost everything **and** you owe another 200" is the
single most likely thing to start an argument at 1am.

**Severity: medium (design decision, not a bug).** The code's own comment
defends it deliberately: it is a table fee, not a tax on profit, and charging
it to the pot without deducting it would mint money. That reasoning is sound.
The gap is that nothing surfaces it before the night ends.

### 4. `TOP_N` breaks ties by array order

Two players finish on exactly the same profit, `winnerTopN: 1`, 20% cut:

```
x  winner=true   cut=400
y  winner=false  cut=0
z  winner=false  cut=0
```

`x` and `y` had identical nights. `x` pays 400 and `y` pays nothing, decided by
their position in `activePlayerUids` — which is seat order, which is arrival
order. Nothing in the UI or the steps log explains why.

**Severity: medium.** Rare, but indefensible to the player it happens to.

**Options:** split the cut across tied players; include all ties (`N` becomes a
floor, not a ceiling); or make it explicit and deterministic and say so.

---

## The ones about trusting the number on screen

### 5. The client engine that produces the preview has no tests

`apps/web/src/lib/settlementEngine.ts` is a hand-maintained mirror of the API's
copy. Both files carry comments saying so. But:

- the API copy is covered by `settlementEngine.test.ts`
- the web copy has **no test file at all**
- **nothing compares the two**

The admin reviews figures produced by the untested copy and confirms them; the
server then recomputes with the tested one and commits *its* answer. If the
copies ever drift, the host approves one settlement and the club records
another, with no error and nothing to notice it.

**Severity: high, and it lands squarely on this PR** — the preview is the thing
the workflow asks a human to approve.

**Options:** run the existing engine suite against both copies (cheapest, and
it turns the mirror comment into something enforced); or extract one shared
module; or have the preview call a server endpoint instead of recomputing.

### 6. Club settings can change between preview and confirm

`computeSettlement` runs client-side with the club config held in the screen's
state. The server recomputes from the database at confirm time. Another admin
editing the rake percentage in between means the host confirms figures that are
not the ones committed. Nothing versions the settings or detects the change.

**Severity: low** (needs two admins and bad timing) **but silent when it fires.**

### 7. Buy-ins are taken from the form, not the ledger

The settlement screen seeds each buy-in from the approved `BuyInRequest` rows,
and then lets the admin edit them. `settleSession` uses what the form sent:

```ts
buyIn: Number(entry?.buyIn || 0)
```

It never re-derives the total from the approval records. So a settlement can be
committed with buy-in figures that contradict the approvals ledger, and History
will disagree with the approvals for that night.

Editable buy-ins are *intentional* — the comment on `openCashoutModal` says they
stay editable "to correct any discrepancy", which is a real need when somebody
puts cash in the pot without anybody tapping approve. The gap is that the
override is unrecorded and unbounded: nothing flags that the figure differs from
the ledger, and nothing captures why.

**Severity: medium.** Not exploitable by a player — admin-only — but it is the
one place where the ledger stops being the source of truth.

### 8. `entries` is not checked against the players being settled

The server iterates the session's players and looks each one up in the
submitted entries. A player missing from `entries` settles at `buyIn: 0,
cashOut: 0` rather than being rejected. The only count check is
`entries.length < 2`.

The real client always sends everybody, so this is a robustness gap rather than
a live defect — but it is the kind that turns a client bug into a money bug.

**Severity: low-medium.**

---

## The ones about the workflow

### 9. A locked cash-out cannot be corrected from the settlement screen

`amendCashOut` is gated to `['lobby', 'playing']`. Once the table is frozen, the
phase is `settling`, so amending is refused — and the settlement form locks
confirmed cash-outs by design, since an admin already counted them.

Both halves are individually right. Together they mean: if the host is on the
settlement screen and spots that Priya's confirmed 7,400 was misread, there is
no way to fix it from there. They have to go back to the table, amend, and
re-freeze.

That is a recoverable dead end rather than a trap, and the route out exists —
but nothing on the screen says so, and "resume the night to fix a number" is
not an obvious next move at the end of an evening.

**Severity: medium (usability, with correctness consequences** — the tempting
workaround is to leave the wrong number in).

### 10. `settleSession` is still legal directly from `playing`

The lifecycle diagram grants this deliberately, and it is unchanged. After this
PR the UI never uses it: both doors freeze first. But the endpoint still accepts
it, so a night can be settled through the API while players are mid-buy-in, with
no freeze and no guarantee the queue is empty (`beginSettling` is where that
check lives).

**Severity: low.** API-only, admin-only, and documented. Worth deciding in Phase
2 whether the direct path should survive now that nothing uses it.

*(This PR did add the missing `assertPhase` to `settleSession` — it was the only
mutation not declaring its phases, which also made it legal from `lobby`, where
a night that never started could be settled on the buy-ins players had put up
while waiting. Both documented paths are unchanged.)*

### 11. The engine's per-player rake cannot be split back into its parts

`rakeDeduction` is the sum of two different charges: the winners' cut, and this
player's share of the flat session rake. They are added into one field in
`computeRake` and cannot be separated afterwards.

This is why the preview shows one combined line per player rather than the
separate "Rake" and "Player Cut" columns the Phase 1 brief asks for. The label
adapts to whichever charges are switched on, which is honest, but a player who
wants to know how much of their deduction was the table fee cannot be told.

**Severity: low (reporting fidelity).** Splitting it is a small change to the
engine's output shape and no change at all to its arithmetic — a good Phase 2
candidate precisely because it is safe.

### 12. Negative amounts are not rejected anywhere

The engine does no input validation. The API coerces with `Number(x || 0)` and
does not clamp. The UI sets `min={0}`, which is a browser hint, not a
constraint — `fireEvent.change` bypasses it and so does any direct API call.

A negative cash-out produces arithmetically consistent nonsense that settles
without complaint.

**Severity: low-medium.** Admin-only, but zero-cost to close.

---

## What Phase 1 verified

Covered by tests added in this PR:

- the table freezes before the screen opens, and does not re-freeze on reopen
- every participant appears exactly once, including anyone who stood up early
- confirmed cash-outs are pre-filled and locked; the rest are editable
- Auto Calculate stays shut until every player has a figure
- calculating commits nothing
- editing a figure invalidates a reviewed preview and re-locks the commit
- confirming sends exactly the entered figures
- settling from the lobby is refused, and books nothing when it refuses

Each of these was checked by breaking the implementation and confirming the test
went red.

**Not verified:** a real night settled end-to-end against a live database with
two devices. The integration tests added here need Postgres and run in CI, not
locally.

---

## Suggested order for Phase 2

1. **Finding 5** — test the client engine, or stop having two. It undermines the
   preview, which is the whole point of the workflow.
2. ~~**Finding 1**~~ — done, see above.
3. **Finding 9** — a way to correct a locked figure without leaving settlement.
4. **Findings 4, 11, 12** — ties, the split rake line, and input clamping. All
   small, all safe.
5. **Findings 2, 3** — surface what the rules already do, rather than change
   them. These need a real night's observations more than the others do.
6. **Findings 6, 7, 8, 10** — hardening, once the above are settled.
