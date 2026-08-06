# Pressure test — five real nights, and a fourth concept

**Date:** 2026-08-06 · **Branch:** `product-polish` · **Status:** design only, no code
**Supersedes parts of:** [`MOBILE-IA-CONCEPTS.md`](MOBILE-IA-CONCEPTS.md)
**Followed by:** [`BUY-IN-FLOWS.md`](BUY-IN-FLOWS.md) — §5 Night 1's finding worked
into a full dual-initiator interaction design.
**Written because:** the recommendation was host-biased, was missing an
organising principle, and had not been run against a real night.

Concept A survived, but **not as written**. Two of the five scenarios broke it.
Six revisions below, each traceable to the scenario that forced it.

---

## 0. What changed, up front

| | Before | After | Forced by |
|---|---|---|---|
| Organising principle | Time (A) | Time, **governed by a law of subtraction** | Concept D |
| Nav destinations | 3 | **4** | player-first critique |
| Home for a player | A reordering of the host's screen | **A different screen** | player-first critique |
| Live P&L | "You · 5,000 in · even" | **Removed — the app cannot know it** | player-first critique |
| Settlement | One document, everything visible | **Two levels: result, then derivation on tap** | Scenario 4 |
| Opening a night | Players request, host approves | **Host banks the table directly** | Scenario 1 |
| Buy-in presets | Table ceiling | **Personal — your last buy-in** | Scenario 2 |

---

## 1. Concept D — Game State

It is a genuine fourth principle and it should have been in the first document.

> **Organising principle: state.** The interface is *replaced* at each stage of
> the night. What doesn't matter now doesn't exist now. Waiting to start = one
> control. Running = four things. Players leaving = cash-outs only, buy-ins
> gone. Everyone finished = settlement only, no player controls at all.

This is not Concept A with different words, and the difference is precise:

|  | **A · Ledger** | **D · Game State** |
|---|---|---|
| Between phases | **Additive** — the night accretes | **Substitutive** — the screen is replaced |
| What leaves | Nothing; things reorder | Everything not relevant to this state |
| Mental model | One document you scroll | One app that becomes several apps |
| Failure mode | Grows into a spreadsheet | **Strands you when it guesses wrong** |

D is more elegant, more Apple, and lower cognitive load at every single moment.
It is also, I think, wrong as a *spine* — for one checkable reason.

### Why D loses as the spine: poker phases are not exclusive

D's premise is that the night has hard, ordered boundaries. Count them:

| Boundary | Hard? | Evidence |
|---|---|---|
| Dark → Opening | **Hard** | `status: 'active'` is created once |
| Opening → Running | Soft | nothing marks it; the first bank just lands |
| Running → Winding down | **Soft and bidirectional** | see below |
| Winding down → Reconciling | Soft, and **reversible** | `clearCashOutFor` |
| Reconciling → Closed | **Hard** | `status: 'settled'`, one way |

Two hard boundaries. And notice what they are: exactly the two the data model
already has — `active` and `settled`. The schema agrees.

The bidirectional one is the killer. Seating a player who had already cashed out
**voids that cash-out**
([offlineSessions.service.ts:78](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:78)):

```
function clearCashOutFor(state, userId) { ... filter out their cash-out ... }
```

So "players are leaving" and "players are buying in" are not successive states
of a poker night. They are **concurrent** states, all night, in both directions.
Scenario 5 walks straight into it: at 11pm three people have cashed out and six
are still playing, and one of the six wants to rebuy. An interface where
"buy-ins disappear" has locked out a paying customer because it decided the
night was over.

D would be right if there were five hard boundaries. There are two.

### What D wins, and what I'm adopting from it

D's underlying observation is correct and Concept A was too weak about it: **as
the night narrows, the interface must show less.** A, as written, keeps
everything present at every phase — which is exactly how it drifts into a
spreadsheet.

So D contributes the governing rule, and I'd hold the implementation to it:

> **Demote, never delete.**
>
> At each phase, exactly one action is promoted to primary. Everything else
> drops **one level** — primary → secondary → behind a tap — and nothing is ever
> removed, because poker phases overlap.

Concretely, at Reconciling: settlement is the screen; buy-ins are not gone, they
are one tap away behind `Someone still playing?`; the night's activity is not
gone, it is behind `Tonight's activity`. Cognitive load matches D. Recoverability
matches A.

**Verdict: spine = A (time). Law of emphasis = D. Not a merge — a spine and a
rule, and the rule is D's whole contribution.**

---

## 2. The player-first correction

You were right, and it is worse than you put it.

### Players are ~80% of all app opens

One night, one host, six players, rough counts from the journeys in
[`LIVE-SESSION-IA.md`](LIVE-SESSION-IA.md):

| | Opens per night | × people | Total |
|---|---|---|---|
| Host — approvals, glances, settlement | ~26 | 1 | **26** |
| Player — glances, 2 buy-ins, 1 cash-out | ~18 | 6 | **108** |

**~81% of the times this app is opened, it is opened by someone who is not
running the night.** And the single most common thing any human does with this
app is J4 — *glance, take no action*.

Which means: **for most opens, by most users, the correct screen has nothing to
tap.** I designed four concepts around decisions. That was the bias.

### The finding that came out of chasing this — and it is the important one

I went to design a player home leading with "am I up or down." Then checked
whether the app can answer it.

**It cannot.** The app knows what you *bought in for* — the sum of approved
`BuyInRequest`s. It does not know what is in front of you. A chip count enters
the system exactly once, when you declare it at cash-out. There is no live stack
anywhere in the model.

So `LIVE-SESSION-IA.md` §7.1's `You · 5,000 in · even` is **wrong** — "even" is
an assumption that your stack equals your buy-in, which is true only in the
instant before the first hand. It is the same error as the current screen's
`Arjun · 0 Chips`: a buy-in total wearing the word "chips."

Three options, and this decides what kind of product this is:

- **(a) Fake it** — infer a stack. Never. This is money between friends; a
  displayed P&L that is quietly wrong is the worst thing this app could do.
- **(b) Let players self-report** — no field exists, and `requestCashOut` frees
  the seat on approval, so it is the wrong tool.
- **(c) Answer the question the app can actually answer.**

Take (c), and state the identity plainly:

> **This is not a chip counter. It is a ledger of money in and money out.**

Tonight, the true statement is *what you're in for*. The up-or-down question the
app **can** answer honestly is the **season** one — the leaderboard is real,
settled, audited data. So the player's home answers tonight with a fact and
answers up-or-down with the season.

```
┌──────────────────────────────────────┐
│  Friday Night                 3h 20m │
│                                      │
│      You're in for                   │
│       ₹8,000                         │
│      2 buy-ins · 5,000 + 3,000       │
│                                      │
│      Up ₹12,400 over 11 nights   →   │  ← the honest up/down
├──────────────────────────────────────┤
│  ⏳ Your ₹3,000 · 4:12 left          │  only when pending
├──────────────────────────────────────┤
│  6 at the table · ₹48,000 in play    │
│  Arjun · Priya · Sam · Meera · …     │
├──────────────────────────────────────┤
│         [ Buy chips ]                │
│   Tonight   Ranks   Club   You       │
└──────────────────────────────────────┘
```

Zero taps to the two things a player wants. One tap to the only thing a player
does. And it never states a number it cannot stand behind.

This also promotes **Ranks** to a top-level destination — see §4.

---

## 3. The five-minute expiry, fully specified

Your sketch, developed — and it turns out the backend already supports all of it.

`expireStaleRequests`
([offlineSessions.service.ts:121](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:121))
emits a socket event for **every** expired request, of all three types, carrying
`expired: true` and the rejected row. So the client can be told authoritatively,
in real time, that a request died. Nothing is missing. It is simply not used.

### Player side — three states

```
   waiting                    ⏳  Your ₹3,000
                                  Rahul hasn't seen this yet
                                  ┌────────────────────┐
                                  │      04:12         │
                                  └────────────────────┘

   under a minute             ⏳  Your ₹3,000
                                  Expiring soon — give Rahul a nudge
                                  ┌────────────────────┐
                                  │      00:30         │  amber
                                  └────────────────────┘

   expired                    ✕   Your ₹3,000 expired
                                  Rahul didn't get to it in time.
                                  [ Ask again ]              ← one tap
```

`Ask again` re-submits the same amount. Legal: the old request is now `rejected`,
so the one-pending-per-player rule
([offlineSessions.service.ts:493](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:493))
is satisfied. Zero backend work.

The wording matters more than the timer. **"Rahul didn't get to it in time"** is
true, blames a clock rather than a person, and is the difference between a
system that feels indifferent and one that feels fair.

### Host side

- Every queue item shows **time remaining**, not time waited. Same ordering
  (all TTLs are equal), better meaning — waited-4-min asks you to do arithmetic.
- Under 1:00 the item changes tone and rises to the top.
- **The corpse stays for 60 seconds:** `Arjun's ₹3,000 expired before you saw it`
  — so a host who picks up their phone at the wrong moment sees evidence rather
  than an empty queue.

### One engineering caveat

The countdown is client-side from `createdAt`; the sweep is a server interval.
The client must never say **"expired"** on its own authority — it says
**"expiring"** at 0:00 and switches to "expired" only when the socket event
arrives. Otherwise a clock skew shows a player a rejection the server has not
made, and `Ask again` would collide with the still-pending original.

---

## 4. Navigation — the evidence you asked for before deleting anything

You were right not to take 6 → 3 on assertion. Having done the work, **3 was
wrong. The answer is 4**, and the item I was about to demote is the one the
player-first analysis says to promote.

### Today's information architecture

Two unrelated nav systems:

```
Dashboard          myClubs · browse · create · requests · superuser      (5)
Club               activeSession · history · leaderboard · approvals     (4 shown)
                   + pot · auditTrail                                    (2 orphaned)
Buried in modals   members · club settings · audit entry point
```

The orphans are the tell. `pot` and `auditTrail` have no nav presence, so while
you are on them **no nav item is selected** — the app claims you are somewhere
you are not ([`NAVIGATION-AUDIT.md`](NAVIGATION-AUDIT.md) §2). And `pot`'s entry
control only renders when there is no active session, so starting a night makes
the way back in vanish.

Six destinations, and two of them can't be navigated to.

### Proposed

```
   Tonight              Ranks              Club              You
   the live night       season table       everything        account,
   (all 6 phases)       (the player's      durable:          clubs,
                        second home)       history · pot ·   profile
                                           members ·
                                           approvals ·
                                           audit · settings
```

### Tap counts, weighted by real frequency

| Destination | Uses / night | Today | Proposed | Δ |
|---|---:|---|---|:---:|
| Tonight's session | ~26 host / ~18 player | 0 — home | 0 — home | 0 |
| Ranks | ~1.5 | 1 | 1 | 0 |
| History | ~0.5 | 1 | 2 | **+1** |
| Join / change approvals | ~0.2 | 1 | 2 | **+1** |
| Club pot | ~0.1 | 1, **and only when no session is live** | 2, always | better |
| Audit trail | ~0.05 | 3 — via Settings modal | 2 | **−1** |
| Members | ~0.1 | 3 — via Settings modal | 2 | **−1** |

The two regressions land on **~0.7 uses per night combined**. The unchanged
zero-tap and one-tap items carry **~28 uses per night**. Two currently-orphaned
destinations become reachable and correctly selected.

### One-handed reach

At 390px, portrait, right thumb:

| | 6 items | 4 items |
|---|---|---|
| Cell width | 65px | **97.5px** |
| Label size | 8–9px (measured, per brief) | **11–12px**, clears rule 8 |
| Adjacent-target error risk | high — 65px cells, 44px targets | low |
| Worst position | far-left cell, cross-body stretch | same, but 1.5× the target |

Fitts's law gives a modest movement-time gain from 65 → 97.5px. The **error
rate** is the real win, and error rate is what matters one-handed, in a dim room,
mid-conversation — which is the entire premise of
[`PRODUCT-PRINCIPLES.md`](PRODUCT-PRINCIPLES.md).

### Discoverability — what gets harder to find, and the mitigation

Two things lose a permanent label. Both get a better route than they had:

- **History.** Mitigated twice: the Club tab opens with the last three nights as
  its first section, so history is visible on arrival rather than behind a
  sub-tab; and the Closed-phase receipt ends with `11 nights before this →`,
  which is a doorway at the exact moment someone wants one.
- **Approvals.** The badge moves to `Club`. Better: a pending join request also
  appears as a card in Tonight's needs-you band during the **Dark** phase, when
  that band is otherwise empty. A card in the place you already look beats a
  badge on a tab you don't.

### Where I could still be wrong

**Ranks.** I have no usage data — nobody does; there's no analytics. I promoted
it on the argument in §2: the season table is the only place the app can
honestly answer "am I winning," which makes it the player's second home rather
than a curiosity. If that argument is wrong, Ranks belongs inside Club and the
answer is 3. **This is the one nav decision I'd want a week of real usage
behind**, and it is also the cheapest to reverse — promoting or demoting one tab
is not the same class of change as restructuring the other three.

---

## 5. The five nights

Tap counts assume the revised design. A tap is one deliberate touch; opening a
sheet counts the tap that opened it. **Estimated from tap-counts and reading
load, not measured on a device.**

### Night 1 · Four friends, casual

**The scenario that produced the biggest win in this whole review**, and it was
in neither the brief nor my first document.

Today, seating four friends costs, before a single card is dealt:

```
3 players × (open app, request sit-in)          ~9 taps, 3 phones
host × 3 approvals                               3 taps
3 players × (open buy-in modal, type, submit)   ~15 taps, keyboard × 3
host × 3 approvals                               3 taps
                                                 ─────────────────────
                                                 ~30 taps across 4 phones
```

Ten minutes of everyone looking at their phones instead of at each other.

But `requestBuyIn` takes an **optional `userId` in the body**
([offlineSessions.controller.ts:90](apps/api/src/modules/offlineSessions/offlineSessions.controller.ts:90)),
and approving a buy-in **seats the player**
([offlineSessions.service.ts:557](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:557)):

```
const activePlayerUids = Array.from(new Set([...(state.activePlayerUids || []), req.userId]));
```

So sit-in is **optional**, and the host can bank someone who is not holding their
phone. The Opening phase becomes host-driven:

```
1  Start tonight                                  1 tap
2  Arjun    → 2,000                               2 taps
3  Priya    → 2,000                               2 taps
4  Sam      → 2,000                               2 taps
5  yourself → 2,000                               2 taps
                                                  ───────
                                                  9 taps, one phone, ~40s
```

**~30 taps across four phones becomes 9 on one.** The host walks round the table
the way they already walk round the table handing out chips.

**Confusion moment.** Arjun's phone buzzes: *"Your buy-in was approved"* — for a
request he never made
([notifications.service.ts](apps/api/src/modules/notifications/notifications.service.ts)).
The copy must read **"Rahul set you up with ₹2,000."** That string lives in
`messageTemplates.ts`, which is API-side — **one string, outside the UX-only
constraint, and it needs your call.**

**Confusion moment.** The host banking *themselves* hits the self-approval rule
([offlineSessions.service.ts:544](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:544)):
blocked if they are an admin, not the owner, and another admin exists. In a
four-friend club the host is usually the owner, so it passes — but see Night 5.

### Night 2 · Nine players, many rebuys

~20 rebuys over four hours. Steady state is fine: player 2 taps, host 1 tap.
Bursts of three after a big hand collapse to a count plus a stack — 4 host taps.

**Weakness found: the presets rot.** `getBuyInCeiling` under `MATCH_HIGHEST`
returns the largest **cumulative** bank at the table
([offlineSessions.service.ts:368](offlineSessions.service.ts:368)). By hour four
someone is in for 25,000, so the ceiling is 25,000 — and my proposed
`1,000 · 2,000 · 5,000 · Match` preset row is now offering a new arrival a
25,000 buy-in as a one-tap default. The ceiling is working as designed; the
preset built on it is not.

> **Revision 1 — presets are personal, not table-global.**
> `Same as last time (3,000) · 2× (6,000) · Minimum (1,000) · Other`.
> The ceiling is stated as a **limit** — "table max 25,000" — never offered as a
> button. A preset should reflect what *this player* usually does.

**Confusion moment.** The header says "6 at the table" while nine people have
played, because a confirmed cash-out removes you from `activePlayerUids`. Two
different counts, both correct, one word. Vocabulary must separate **at the
table** from **played tonight**, and the settlement screen counts the second.

### Night 3 · Frequent buy-ins and sit-outs

**This night broke a premise in the brief.**

There is no sit-out. `OfflineEngineState` holds `activePlayerUids`,
`pendingSitInUids` and `cashOuts` — and nothing else
([offlineSessions.service.ts:13](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:13)).
`isSatOut` exists only on `LazyPlayerSeat`, which is the virtual-table engine,
not this one. Standing up calls `requestCashOut`
([ClubDetailView.tsx:1385](apps/web/src/components/ClubDetailView.tsx:1385)).

So the brief's seat-state list — *playing, waiting for buy-in, waiting for
cash-out, **sitting out**, dealer* — asks for a state the model does not have.
It also doesn't need it: a ledger app doesn't deal hands, so "deal me out for a
few" is a no-op it should never have tracked.

> **Revision 2 — drop "sitting out". Replace it with a state that is real and is
> currently mislabelled: *seated, no chips*.**
> That is the player who has been waved in but hasn't bought in yet — the one
> the current UI calls "0 Chips". Five real, derivable states:
> **waiting to be seated · seated, no chips · in play · counting out · cashed out.**

**And the serious one.** Priya cashes out for 8,200 at 11pm; the host confirms.
At 11:30 she comes back and buys in for 3,000. Approving that buy-in re-seats
her, which **silently voids her 8,200 cash-out** (`clearCashOutFor`). The
behaviour is correct — she carried those chips back to the table, they were
never hers to keep. But nothing tells anyone it happened. At settlement her row
shows buy-ins of 8,000 and a blank cash-out, and a host who remembers the 8,200
may type it in, double-counting chips that went back into play.

> **Revision 3 — a voided cash-out is an event, not a silent mutation.**
> `11:32 · Priya came back · her 8,200 count no longer applies`, in the night's
> activity, and her settlement row reads **"rejoined — needs a fresh count."**

Note what caught this: **the activity stream.** Under Concept D, the interface at
11:30 would have been in cash-out mode and the rejoin would have had nowhere to
appear. This is the clearest evidence in the document for A's spine.

### Night 4 · Rake and winner's cut

Seven players, flat session rake ₹500, winner's cut 5%, `PROFIT_POSITIVE`
winners, `roundingRule: NONE`.

**Your stress test: does the ledger become a spreadsheet?**

As written in the first document — **yes, and I concede it.** I said "the account
becomes the receipt," which merges fifteen buy-in *events* into a screen that
needs seven player *totals*. That is a spreadsheet, on a phone, at 1am.

The error was treating the event stream and the settlement table as the same
artifact. They are not: **the stream is the audit surface, the table is the
settlement surface.** Under "demote, never delete," the stream drops behind a
tap at Reconciling.

> **Revision 4 — settlement has two levels.** Result per person by default;
> arithmetic on tap.

Default — seven rows, no arithmetic visible:

```
┌──────────────────────────────────────┐
│      Everything is accounted for     │
│   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ₹56,000      │
├──────────────────────────────────────┤
│   Priya      +4,109              ›   │
│   Arjun      +2,318              ›   │
│   Sam        −1,071              ›   │
│   Meera      −2,071              ›   │
│   …                                  │
├──────────────────────────────────────┤
│   Table fee ₹500 · club's share 5% ▾ │  collapsed
│   Tonight's activity            15 › │  the stream, demoted
├──────────────────────────────────────┤
│        [ Close the night ]           │
└──────────────────────────────────────┘
```

Tap Priya — the arithmetic, for one person, on one screen:

```
   counted out           12,400
   bought in            − 8,000
   ──────────────────────────────
   won                    4,400
   club's share  5%       − 220
   table fee              − 71.43
   ──────────────────────────────
   Priya takes           4,108.57
```

Fifteen buy-in events never appear. They are two taps away, per player, where
they belong.

**Confusion moment.** `sessionRakeAmount` is split across **everyone, winners and
losers alike** ([settlementEngine.ts:328](apps/web/src/lib/settlementEngine.ts:328))
— which is right, it's a table fee, not a tax on profit — but a player who lost
3,000 *and* paid ₹71.43 will ask why. It must appear as a **named line**, never
folded into a net.

**Confusion moment: the paise.** ₹500 ÷ 7 = ₹71.43, so every net carries decimals.
Between friends, splitting to the paise is faintly ridiculous. The club already
has `roundingRule` with `NEAREST_1 / 5 / 10` — it is simply never surfaced.

> **Revision 5 — ask the rounding question during club setup**, in plain words:
> *"Round settlements to the nearest ₹5?"* Not a calculation change; an existing
> setting exposed at a calm moment instead of discovered at 1am.

### Night 5 · Chaos

11pm. Nine played, three have cashed out, six are still in. Two pending buy-ins,
one pending cash-out. One of the buy-ins is the host's own rebuy — and the club
has two admins, of whom the host is not the owner. ₹350 will be unaccounted at
the end.

```
1  Open app. Needs-you band: 3 items, sorted by time remaining.
2  Approve Arjun's rebuy                                        1 tap
3  Confirm Meera's cash-out                                     1 tap
4  Own rebuy: blocked. "Another Club Admin must approve
   your own buy-in request."                                    0 taps
5  … the night continues; two more rebuys arrive                2 taps
6  All counted. Reconciling.
7  Check the books                                              1 tap
8  Read the ₹350 explanation                                    0 taps
9  Close the night → confirm                                    2 taps
                                                                ──────
                                                                ~10 taps
```

**Confusion moment — the self-approval deadlock, and it is partly structural.**
The rule at
[offlineSessions.service.ts:544](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:544)
is correct: an admin shouldn't bank themselves unwatched. But the other admin
may be one of the three who already went home. `ActionQueue` already carries a
`blockedReason` — it just needs to be honest and actionable:

> **Revision 6 — a block must name someone who is actually here.**
> `Priya can approve this` when Priya is at the table.
> `No other admin is still here — ask Sam (owner) to approve from their phone`
> when they are not. A block that names an absent person is worse than no block,
> because the host taps three times learning that.

**Confusion moment — the ₹350, and this is the one that matters.** The host never
decides where it goes. The club's configured `PROPORTIONAL_WINNERS` strategy
silently takes it from the two winners. If the screen shows only a corrected
total, two people quietly earn less than they counted, and nobody is told.

The engine **already generates the exact sentence.** `applyExcessToWinners` builds
a `whoPaid` string and pushes it into `SettlementResult.steps`
([settlementEngine.ts:294](apps/web/src/lib/settlementEngine.ts:294)):

```
Cash-outs exceed buy-ins by 350 — deducted from winners in proportion
to profit: Priya -210 (60% of winning profit), Arjun -140 (40%...)
```

Nothing surfaces it. Translated per §1.5 of the first document, it becomes the
screen:

```
┌──────────────────────────────────────┐
│                                      │
│      ₹350 more was counted           │
│      than was bought in              │
│                                      │
│      Your club splits this between   │
│      the winners, in proportion      │
│      to their winnings:              │
│                                      │
│          Priya      − ₹210           │
│          Arjun      − ₹140           │
│                                      │
│      [ That's right ]   [ Recount ]  │
└──────────────────────────────────────┘
```

Free to build, and it converts the most disputable moment of the night from a
silent adjustment into a stated one.

---

## 6. What the five nights changed

| # | Revision | From |
|---|---|---|
| 1 | Buy-in presets are personal, not table-global | Night 2 |
| 2 | Drop "sitting out"; use *seated, no chips* | Night 3 |
| 3 | A voided cash-out is a visible event | Night 3 |
| 4 | Settlement is two levels — result, then derivation | Night 4 |
| 5 | Ask the rounding question at club setup | Night 4 |
| 6 | A block must name an admin who is present | Night 5 |

Plus the two structural changes from §1 and §2: **demote, never delete**, and
**the app never displays a P&L it cannot know**.

The two that would have hurt most in production are **Night 3's silent voided
cash-out** — which corrupts a settlement figure with no trace — and **Night 4's
spreadsheet**, which was my error and which you called before the scenario did.

---

## 7. Recommendation

**Concept A's spine, governed by Concept D's law of subtraction, with
player-first defaults and four nav destinations.**

A survived because Night 3 proved the thing that only a continuous spine can do:
catch a mutation that no phase-based interface would have had a place to show.
It did **not** survive as written — Night 4 broke its settlement, and the
player-first analysis broke its home screen.

D lost as a spine for a reason that is checkable rather than aesthetic: it needs
hard phase boundaries and poker has two. It won as the rule that governs every
phase transition, which is the more durable half of it.

### Still not ready for code — but the remaining list is short

Not because the design is unresolved. Because three questions have answers that
exist in the world rather than in this repository:

1. **Do hosts actually act within five minutes?** If not, the countdown surfaces
   a problem it cannot fix, and the real answer is a longer TTL — a backend
   change. Worth one night of observation before building anything around it.
2. **The `messageTemplates.ts` string** for host-initiated buy-ins. One string,
   API-side, needed for Night 1's flow. Your call on the constraint.
3. **Ranks at top level** — §4's one genuinely uncertain nav decision.

Everything else on the "needs a device" list from
[`MOBILE-AUDIT.md`](MOBILE-AUDIT.md) §6 still stands, and the router prerequisite
from [`NAVIGATION-AUDIT.md`](NAVIGATION-AUDIT.md) §1 still blocks a sheet-heavy
IA.

---

## 8. One thing found in passing, outside this scope

`requestBuyIn` and `requestCashOut` both accept an optional `userId` in the body
and guard with `assertMemberOfClub` only
([offlineSessions.controller.ts:70](apps/api/src/modules/offlineSessions/offlineSessions.controller.ts:70)
and [:90](apps/api/src/modules/offlineSessions/offlineSessions.controller.ts:90)).
So **any club member can create a buy-in or cash-out request in another member's
name**, not just an admin.

This is what makes Night 1's flow possible, and I want it — as an **admin**
capability. As a member capability it lets anyone spam the queue with requests
attributed to other people. It moves no money on its own, since an admin still
has to approve, so this is queue noise and social confusion rather than a
financial hole.

Out of scope here, and flagged rather than acted on.
