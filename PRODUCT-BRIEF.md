# Master product redesign brief — mobile first

# `PRODUCT-BRIEF v1.2` — frozen 2026-08-06

**Branch:** `product-polish` · **Status:** canonical, frozen
**v1.2** — §2.5 *live controls never move under a thumb*, promoted from an
implementation detail found while mapping the live session's interaction model.
Nothing revised; one principle added.
**v1.1** — the five open decisions resolved (§18), plus §2.4 *prefer reducing
taps*, a per-club default buy-in (§9.3), and the audit model widened to four
fields (§13). No principle was revised; v1.0's were extended.
**Supersedes:** [`NEXT-SESSION-BRIEF.md`](NEXT-SESSION-BRIEF.md) — which contains two
claims since disproved and should not be followed.

This is the brief. Where it states a design decision, that decision is made.
Where it states a finding, the evidence is cited and does not need re-deriving.

**Phases 1–3 of the deliverables below are complete.** A session picking this up
starts at Phase 4 and does not redo the concept work — see §18.

## Change control

Every feature, screen and redesign answers one question before it is built:

> **Which section of `PRODUCT-BRIEF` does this improve?**

If it cannot answer that, it probably does not belong.

This document is **frozen at v1.0**. It is not revised for a better idea, a new
preference, or a design that finds a principle inconvenient — only when real use
shows a principle does not hold. A revision bumps the version and records what
changed and what disproved it.

**Frozen: this file.** The three supporting documents are *evidence*, not canon,
and stay as they are — [`MOBILE-IA-CONCEPTS.md`](MOBILE-IA-CONCEPTS.md) (the four
concepts), [`IA-PRESSURE-TEST.md`](IA-PRESSURE-TEST.md) (five nights, six
revisions), [`BUY-IN-FLOWS.md`](BUY-IN-FLOWS.md) (dual-initiator design). They
explain *why* this brief says what it says. Where they and this file disagree,
**this file wins.**

---

## 1. Objective

Forget the current UI. Do not iterate on the existing layout. Redesign the
complete mobile experience around the natural lifecycle of a real poker night.

The bar is Apple Wallet, Linear, Revolut and Superhuman — while remaining
unmistakably a poker app. Primarily a phone, eventually a PWA. Every decision
prioritises **one-handed operation · thumb reach · glanceability · perceived
speed · confidence around money · reduced cognitive load**.

## 2. Design philosophy

The interface should never try to show everything. It should always answer:

> **What do I need to do next?**

Progressively reveal rather than overwhelm. **The software should think. The
users should not.**

### 2.1 Emotional goal

*What the UI should do is §5 onward. This is how people should feel, and it is
the tiebreaker when two designs are both defensible.*

> The app should make the **host** feel **calm, confident and in control**.
>
> The app should make **players** feel **included, informed and part of the
> game**.
>
> **No interaction should make someone wonder whether money has been lost,
> forgotten or calculated incorrectly.**
>
> Every screen should reduce anxiety rather than increase it.

The third line is the one with teeth. It is why an expiring request must show its
countdown (§6.1), why a voided cash-out must be announced (§10.1), why the
settlement screen must name who paid an unaccounted amount (§12.2), and why the
app must never display a profit it cannot know (§4.2). Each of those is a place
where the software currently knows something the user doesn't, and silence about
money reads as loss.

### 2.2 One screen. One job.

> Every screen has **one primary purpose**. Every screen has **one dominant
> action**. If two primary actions compete for attention, the design is probably
> wrong. Everything else supports that one action.

This is the principle that removed the permanent Cash Out button, and it is worth
stating that explicitly: there were three controls claiming primacy at the bottom
of the live session — a floating action button, a full-width CASHOUT bar and a
six-item nav, with the FAB physically overlapping the bar. Three things claiming
primacy means none has it.

**One job is not one piece of information.** A screen may inform freely — the
live session answers three questions in three seconds (§5) and that is correct.
It may only *ask* for one thing. The constraint is on what the screen wants from
you, not on what it tells you.

### 2.3 Progressive disclosure

> Never expose complexity before it becomes useful. **The interface begins with
> answers.** Details appear only when the user asks.

```
Settlement summary  →  Adjustments  →  Per-player breakdown  →  Raw audit log
```

This is the principle behind most of §12: settlement summarises **people, not
transactions**; rake and winner's cut are collapsed; fifteen buy-in events never
appear on a screen that needs seven player totals.

**The exception, and it is absolute:** anything *waiting on the user* is not
complexity and is never disclosed progressively. A pending request, an expiring
countdown, an unaccounted amount and a voided cash-out are the screen — they are
never collapsed, never behind a tap, never summarised into a badge. Progressive
disclosure hides **detail**, never **a decision**.

Without that exception the principle could be used to argue for tidying away the
exact things §2.1 exists to surface.

### 2.4 Prefer reducing taps over adding features

> If two workflows achieve the same result, the one requiring **fewer decisions
> and fewer taps** is usually the better product.

This is the principle the rest of the document converged on without naming:
contextual cash-out, removing permanent buttons, admin-initiated buy-in, the
action queue, progressive disclosure, bottom sheets, and summary-first
settlement are all the same move.

It outranks feature parity. A capability that costs four taps and is used twice a
night is worth less than removing one tap from something used fifteen times, and
when the two conflict, the tap wins.

**Its limit is §2.1.** Taps that buy *confidence about money* are not friction:
the settlement `Check the books → Close the night` gate (§12.4), the typed and
confirmed cash-out amount (§10), and the explicit commit on a keyed-in buy-in
(§9.2) all cost a tap deliberately and must not be optimised away. Reduce taps
that cost time; keep taps that buy certainty.

### 2.5 Live controls never move under a thumb

> **A control that commits money must never change position because something
> arrived while the user was reaching for it.**

New items append; they never push existing ones. Lists that update live grow
away from the thumb, not toward it. A layout shift disarms taps for a moment
rather than letting them land on whatever moved into place.

This looks like a rendering detail and is not. The app updates over a socket
while an admin is mid-reach, and the controls it updates around are `Approve`
and `Not now` on real money. Every other principle here is about what the user
sees; this one is about what happens between deciding and touching.

It is also the rule that settles arguments the others cannot. "Newest first"
would be better by §2.1 — you would see the new request instantly — and is
forbidden by this, because it relocates a live Approve button under a
descending finger. Where the two conflict, this wins.

## 3. The complete journey

```
Club Dashboard → Start Session → Live Session → Player Actions
    → End Game → Settlement → History
```

One continuous experience. Do not optimise individual screens — optimise the
experience of hosting an entire poker night.

## 4. Core product principle

> **Internally this product behaves like accounting software. Externally it
> should feel like hosting a poker night.** Never expose accounting complexity
> unless the user asks for it.

*Hosting, not a table — because nobody interacts with a poker table. They
interact with people, and hosting is the emotional experience. This also keeps
the principle consistent with §8 (the player, not a button, is the interaction
point) and with §19.*

### 4.1 Addition — who this is actually for

*Not in the source brief. Added because every question in §5 is a host's
question, and hosts are the minority of users.*

One night, one host, six players:

| | Opens per night | × people | Total |
|---|---|---|---|
| Host | ~26 | 1 | 26 |
| Player | ~18 | 6 | **108** |

**~81% of app opens are by someone not running the night**, and the most common
single act in the product is a glance with no action attached. So:

> **For most opens, by most users, the correct screen has nothing to tap.**

The host's experience decides whether the app gets adopted. The player's decides
whether it gets used. Both are first-class; neither is a reordering of the other.

### 4.2 The app does not know anyone's chip stack

The most important constraint in the product, and it is easy to design past.

The system knows what a player **bought in for** — the sum of approved
`BuyInRequest`s. It does not know what is in front of them. A chip count enters
the system exactly once, when it is declared at cash-out.

Therefore:

- **Never display a live profit or loss for tonight.** It cannot be known, and a
  displayed number that is quietly wrong is the worst thing this app could do
  with money between friends.
- The true statement about tonight is **"you're in for ₹8,000."**
- The up-or-down question is answered honestly by the **season** — leaderboard
  data is settled, audited and real.

This is why the current screen's `Arjun · 0 Chips` is wrong: it is a buy-in total
wearing the word "chips". `LIVE-SESSION-IA.md` §7.1's `You · 5,000 in · even` is
wrong for the same reason.

---

## 5. Live session

The heart of the application. It must answer, within three seconds:

1. Is anybody waiting for me?
2. What is happening at the table?
3. What should I do next?

**For a player, the questions are different** (§4.1) — *what am I in for, is
anything of mine pending, and am I up over the season.* The live session answers
both sets; it does not answer the host's and reorder for the player.

Actions before decoration. The table must not consume the most valuable area of
the screen when somebody is waiting.

## 6. Action queue

Pending actions always appear first — buy-in, sit-in, cash-out and join
approvals. **The admin should never scroll to discover work waiting for them.**

When there are no pending actions this section disappears entirely and the table
becomes the visual focus.

### 6.1 Every pending item shows time remaining

*Not in the source brief. This is load-bearing and would otherwise be lost.*

Buy-ins, sit-ins and cash-outs **auto-reject after five minutes**
([offlineSessions.service.ts:102](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:102)).
Nothing in the UI says so today. The failure this causes is severe and silent: a
host who glances seven minutes late sees an empty queue with no evidence
anything happened, and the player sees a rejection they did not earn.

Required behaviour:

- Every pending item shows **time remaining**, not time waited.
- Under 1:00 it changes tone and rises to the top.
- **An expired item leaves a corpse for ~60s** — *"Arjun's ₹3,000 expired before
  you saw it"* — never a silent deletion.
- The player's own pending request carries the same countdown, and on expiry
  offers **`Ask again`** as one tap. This is legal: the old request is
  `rejected`, so the one-pending-per-player rule is satisfied.
- Wording blames the clock, not a person: *"Rahul didn't get to it in time."*

The backend already emits an authoritative `expired: true` socket event for all
three types, from both the sweep and the decision path
([offlineSessions.service.ts:121](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:121)).
**No backend work is required.** The client must never say "expired" on its own
authority — it says "expiring" at 0:00 and switches when the event arrives.

### 6.2 The queue debounces insertion by ~400ms

A request that resolves inside that window never renders as pending — it appears
directly as a completed event. This is required by the admin-initiated buy-in
flow (§9.2) and improves the ordinary case.

### 6.3 A blocked action must name someone who is present

`decideBuyInRequest` refuses self-approval when the requester is a non-owner
admin and another admin exists
([offlineSessions.service.ts:544](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:544)).
The message must name an admin **still at the table** — `Priya can approve this`
— and when none is, say so and give the real escape. A block naming someone who
went home is worse than no block.

## 7. Poker table

The table is the **emotional centrepiece** of the product — not because it
occupies the most space, but because it feels alive.

Each seat communicates state instantly, without reading:

| State | Derived from |
|---|---|
| Playing | in `activePlayerUids`, has an approved buy-in |
| Waiting for buy-in | pending `BuyInRequest` |
| Waiting for cash-out | pending entry in `cashOuts` |
| **Seated, no chips yet** | in `activePlayerUids`, no approved buy-in |
| Dealer | `assignedDealerUid` |

Visual language over text: coloured rings, chip indicators, subtle badges,
dealer button, dimmed seats. **Never rely on colour alone** — every state needs a
second channel (shape, position, or text) for colour-blind users and for a dim
room at an angle.

> **"Sitting out" is deliberately absent.** It does not exist in the offline
> session model — `OfflineEngineState` holds only `activePlayerUids`,
> `pendingSitInUids` and `cashOuts`
> ([offlineSessions.service.ts:13](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:13)).
> `isSatOut` belongs to the virtual-table engine, not this one. A ledger app
> doesn't deal hands, so "deal me out for a few" is a no-op it should never
> track. **"Seated, no chips yet" replaces it** — a real state that exists today
> and that the current UI mislabels as "0 Chips".

### Avatars

Always show profile photos. Where absent, generate **premium poker-themed
placeholders** — no emojis. Each generated avatar is part of the product's
branding and is **stable for that player**, reused identically in the queue,
roster, table, settlement and history. The point is not the artwork: it is that
a person is recognisable at a glance on all five surfaces without reading a
name. That is what makes a nine-player night scannable.

### Adaptive table

Seating adapts automatically. Two players must not look like an empty
nine-player table; three must not leave huge gaps. As players increase, seats
reposition, avatars resize slightly, spacing adjusts. The table should always
feel intentional.

## 8. Player interaction

**The player is the interaction point.** Do not build the UI around buttons.
Tapping a player opens a contextual bottom sheet: Buy In · Cash Out · View
History · Notes · admin actions.

### 8.1 The sheet's top action is whatever that player has pending

If Priya has an open request, the sheet leads with `Approve ₹3,000`, not
`Buy in`. This is not a nicety — it makes the one-pending-per-player 409
unreachable rather than handled after the fact.

### 8.2 "Edit Chips" — flagged, needs your decision

The source brief lists this. **It has no meaning in the current model** (§4.2):
there are no chips to edit, and there is no un-approve —
`decideBuyInRequest` goes `pending → approved | rejected` and stops.

Two honest readings:

- **Correcting a buy-in amount entered in error.** Real and needed, especially
  with admin-initiated buy-ins. Not possible in-session today; correctable only
  at settlement, where buy-in figures are editable and the server treats
  submitted figures as authoritative.
- **Editing a live stack.** Not possible, and should never be faked.

Recommendation: **drop it from the sheet** and name the real path — *"Amounts can
be corrected when you close the night."* Reinstating it properly is a backend
change and is not part of this redesign.

## 9. Buy in

Primary action during active play. **Two workflows, chosen by who initiates —
never by a setting.**

### 9.1 Player initiated — unchanged

Player requests, admin approves. Two taps for the player, one for the admin.

### 9.2 Admin initiated — new

Admin taps the player, selects an amount, done. The app performs the normal
request → approval flow internally.

**Do not duplicate business logic.** Compose the two existing calls rather than
adding an endpoint: composition inherits the ceiling check, the
one-pending-per-player rule, the self-approval rule, seating, socket events and
the notification, and cannot drift from them.

- **3 taps mid-game** (tap player → Buy in → amount); **2 taps in the Opening
  phase**, where buying someone in is the only thing you'd do to a name so it
  needs no menu step.
- **No separate Approve tap.** The preset button displays the exact amount, so
  tapping `₹3,000` *is* the commitment. Typed amounts get an explicit labelled
  commit — `Buy Priya in for ₹4,500` — because those are built rather than
  chosen.
- **If the second call fails**, the result degrades into flow 9.1 and says so:
  *"Couldn't complete that — Priya's ₹3,000 is waiting in your queue instead."*
- Approving a buy-in **seats the player**, so admin-initiated buy-in is also the
  seating mechanism. Sit-in survives only for a player who wants a seat before
  buying chips.

This is the largest measured win in the redesign: seating four friends drops
from ~30 taps across four phones to **9 on one**.

### 9.3 A club default buy-in, then personal presets

Every club sets a **default buy-in** (`Friday Night · default ₹3,000`). It makes
the admin-initiated flow one tap on the amount step, and it is the only preset
that works for a player with no history at this club.

**The action label carries the amount** — `Buy in ₹3,000`, never `Buy in`. This
is what keeps §9.2's confirmation model intact: you are still tapping a control
that displays the exact figure, so no separate confirm step is needed. A bare
`Buy in` that silently commits a remembered number would break that, and would
break §2.4's limit.

Below the default, presets are **personal**: `Same as last time · 2× · Minimum ·
Other`. Not table-global — under `MATCH_HIGHEST`, `getBuyInCeiling` returns the
largest *cumulative* bank at the table, so by hour four it can be ₹25,000, and a
preset built on it would offer a new arrival a ₹25,000 one-tap buy-in.

The ceiling is stated as a limit — *"table max ₹25,000"* — never offered as a
button. **The default is clamped to the live ceiling**: where the club default
exceeds it, the button shows the ceiling and says why, rather than offering an
amount the server will reject.

## 10. Cash out

**Remove the permanent Cash Out button.** It is an end-of-session action, reached
only through a player.

**Never use presets.** A buy-in amount is *chosen* from round numbers; a cash-out
amount is *counted* from physical chips, and it locks the settlement figure. Always
manually entered, always explicitly confirmed:

```
   MEERA — counting out
        ₹  8,200
   [   Count Meera out for ₹8,200   ]
```

The same initiator rule as §9 applies: admin-initiated cash-out composes the same
two calls. It is where the saving matters most — the host is already walking the
table counting chips while six people put their coats on.

### 10.1 A player rejoining voids their cash-out, and this must be visible

Seating someone who had already cashed out **deletes that cash-out**
([offlineSessions.service.ts:78](offlineSessions.service.ts:78), `clearCashOutFor`).
The behaviour is correct — they carried those chips back to the table. But it
happens silently today, and at settlement their row shows a blank cash-out. A host
who remembers the earlier figure may type it in, double-counting chips that went
back into play.

**The timeline example in the source brief contains exactly this bug.** Corrected:

```
   10:44 PM   Priya cashed out              ₹8,200
   11:18 PM   Priya bought back in          ₹3,000
              her ₹8,200 count no longer applies
```

Her settlement row must read **"rejoined — needs a fresh count."**

## 11. Activity timeline

A chronological stream — the story of the evening. **This stream is for
understanding the night. Settlement is not.** At settlement it demotes behind a
tap; it is never deleted.

## 12. Settlement

An accounting reconciliation, not a calculation form. The user should never
mentally combine buy-ins, cash-outs, winner's cut, rake and the difference.
One question:

> **Has every rupee been accounted for?**

```
Money collected → Money returned → Adjustments → Remaining
```

- Remaining zero → **"Everything has been accounted for."**
- Remaining non-zero → **"₹500 still needs to be accounted for."**

Never the word *mismatch*. The whole engine vocabulary needs translating, not
just that word — *excess, shortfall, deduction, pot adjustment* are all
accounting terms that have leaked into the interface.

**Rake and winner's cut are adjustments, not warnings.** Collapsed by default.
An unaccounted amount is **not** an adjustment — it is a question directed at the
admin right now, and is never collapsed. Two of three collapse; the third is the
screen.

### 12.1 Settlement summarises people, and has exactly two levels

Default view is people, not transactions:

```
   Priya      +₹5,400        ›
   Rahul      −₹2,300        ›
   John       −₹3,100        ›
```

Tapping one person shows that person's arithmetic — and only that person's:

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

Fifteen buy-in *events* never appear on a settlement screen that needs seven
player *totals*. That is the difference between a reconciliation and a
spreadsheet.

The flat session rake is charged to **everyone, winners and losers alike**
([settlementEngine.ts:328](apps/web/src/lib/settlementEngine.ts:328)) — correct,
it is a table fee, not a tax on profit — so it must appear as a **named line**,
never folded into a net.

### 12.2 Say who paid for an unaccounted amount

The club's configured strategy resolves it silently. If the screen shows only a
corrected total, two people quietly earn less than they counted and nobody is
told. The engine **already generates the sentence** and puts it in
`SettlementResult.steps`
([settlementEngine.ts:294](apps/web/src/lib/settlementEngine.ts:294)); it is simply
never surfaced. Translated:

```
   ₹350 more was counted than was bought in.
   Your club splits this between the winners,
   in proportion to their winnings:

        Priya     − ₹210
        Arjun     − ₹140

   [ That's right ]        [ Recount ]
```

### 12.3 Ask the rounding question at club setup

`roundingRule` (`NEAREST_1 / 5 / 10`) exists and is never surfaced, so a ₹500
table fee split seven ways gives every player a net ending in paise. Ask once, in
plain words — *"Round settlements to the nearest ₹5?"* — during setup, rather
than discovering it at 1am. Exposing an existing setting, not changing a
calculation.

### 12.4 Keep the Calculate → Confirm gate, and dramatise it

Editing any figure invalidates the calculation
([ClubDetailView.tsx:1701](apps/web/src/components/ClubDetailView.tsx:1701)). That is
correct and should be *felt*: the balance bar greys and the button returns to
`Check the books`. Settlement is the one place in the product where slowing the
user down is right.

### 12.5 The balance bar appears from the first cash-out, not at settlement

The single highest-leverage idea in the redesign. The host watches it fill all
night, so settlement becomes a **confirmation rather than a discovery**. This is
what "settlement stops being a cliff" means concretely.

## 13. Audit trail

Every money event must permanently record **who initiated it · who it was for ·
who approved it · when it happened**. Never overwrite identities. The ledger must
answer *who did what* months later.

**This requires the schema change the constraints section permits.** Scoped
precisely — here is the current state:

| Event | For whom | Initiator | Approver | Requested at | Approved at |
|---|:---:|:---:|:---:|:---:|:---:|
| Buy-in (`BuyInRequest` table) | ✅ `userId` | ❌ | ✅ `approvedBy` | ✅ `createdAt` | ❌ |
| Cash-out (`engineState` JSON) | ✅ `userId` | ❌ | ✅ `confirmedBy` | ✅ `requestedAt` | ❌ |
| Sit-in (`engineState` JSON) | ✅ uid | ❌ | ❌ | ✅ `sitInRequestedAt` | ❌ |

**No initiator is recorded anywhere.** `requestBuyIn` sets `requestedBy` to the
*target* player, not the caller, so a host-initiated buy-in and a player-initiated
one the host approved produce **byte-identical records**. In a dispute — *"I never
asked for that ₹5,000"* — the record says the player asked for it, and no UI
change can fix that because there is nowhere to write it.

### 13.1 The four questions the ledger answers forever — **decided, v1.1**

Every money event records all four, always:

```
   Requested For · Requested By · Approved By · Approved At
```

```
   player-initiated            admin-initiated
   ────────────────────        ────────────────────
   For      Priya              For      Priya
   By       Priya              By       Aniket
   Approved Aniket             Approved Aniket
   At       11:42 PM           At       11:42 PM
```

**Money history must never rely on inference.**

**Money events are buy-ins and cash-outs.** Sit-in is a *seating* event, moves no
money, and is deliberately excluded — its record is deleted on approval today,
and promoting it would widen this change for no ledger benefit.

### 13.2 Fixing `requestedBy` moves a permission check — read before implementing

`requestedBy` is currently *mis-set*, and the self-approval guard depends on the
mistake. Correcting the field alone would break §9.2.

```
offlineSessions.service.ts:544
   if (req.requestedBy === requesterId && !isOwner && hasOtherAdmins(...)) → 403
```

Once `requestedBy` names the true caller, an admin banking **Priya** sets
`requestedBy = admin`, and this guard fires — blocking the admin-initiated flow
for everyone, not just for self-buy-ins.

The guard's *intent* is "an admin must not approve a buy-in that credits
themselves." That intent keys on **who the money is for**, not who typed it:

```
   if (req.userId === requesterId && ...)     ← the correct predicate
```

This is not a permissions change; it is the same rule expressed against the field
that actually means it, and it is *more* correct than the original — which
happened to work only because `requestedBy` was wrong. Three call sites move
together, and none may be changed alone:

- `offlineSessions.service.ts:502` — the write
- `offlineSessions.service.ts:544` — the guard
- `ClubDetailView.tsx:1804` — the client mirror that renders `blockedReason`

**`sessions.service.ts:395` carries the same `requestedBy: userId` line** for
virtual-table sessions. It changes in lockstep or the two copies drift.

### 13.3 A voided cash-out must stop being deleted

§10.1 requires the rejoin to be visible and §13 forbids overwriting identities —
but `clearCashOutFor` **deletes** the row
([offlineSessions.service.ts:80](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:80)),
so today the event leaves no trace at all.

Change it to mark `status: 'voided'` rather than filter. One call site must gain
a status check or a returning player can never cash out again:

```
offlineSessions.service.ts:414
   const existing = (state.cashOuts || []).find((c) => c.userId === userId);
   → must ignore 'voided'
```

`settleSession:612` already filters on `status === 'confirmed'` and is safe.

### 13.4 Not part of this change

Cash-outs live in `engineState` JSON rather than a table. They survive settlement
— which only sets `status` and `endedAt` — but are **not queryable** the way
buy-ins are. If "the ledger answers months later" is to be literally true they
eventually need real rows. Deferred, and recorded here so it is not rediscovered.

## 14. Session naming

Club name appears **once**. Avoid fake concepts such as "Day 1 / Session 1"
unless they genuinely exist in the model — **they do not**. `dayNumber` is
assigned as `idx + 1` over the club's whole record list
([clubRecords.service.ts:353](apps/api/src/modules/clubRecords/clubRecords.service.ts:353)):
it is a count of nights mislabelled as a day, and nothing models a day containing
sessions, so "Session 1" would be a constant forever.

Adopted convention:

```
   Fri 8 Aug                        ← the name
   Night 12 · 6 players · 4h 10m    ← metadata, secondary weight
```

Progression is a property of the history list, not of the title.

> Note: the source brief's claim that the club name is duplicated by
> `handleStartSession` is **out of date** — that code already builds the label
> from the date ([ClubDetailView.tsx:1007](apps/web/src/components/ClubDetailView.tsx:1007)),
> and the club name renders once at :1958.

## 15. Navigation

*Not in the source brief; carried in because it is decided and evidenced.*

Six club destinations become **four**, two of which are currently unreachable
from the nav at all:

```
   Tonight          Ranks          Club          You
   the live night   season table   history·pot   account,
   (all phases)                    members·      clubs,
                                   approvals·    profile
                                   audit·settings
```

Regressions (+1 tap on History and Approvals) land on ~0.7 uses/night; ~28
uses/night are unchanged at 0–1 taps. Cells go 65px → 97.5px and labels 8–9px →
11–12px, clearing the 12px floor. `pot` and `auditTrail` stop being orphans
([`NAVIGATION-AUDIT.md`](NAVIGATION-AUDIT.md) §2).

**Ranks at top level is the one nav call I am least certain of** — it is promoted
on the §4.2 argument that the season is the only up-or-down question the app can
answer honestly. It is also the cheapest to reverse.

## 16. Mobile first

Phones first; desktop adapts. Thumb reach · safe areas · bottom sheets ·
contextual actions · PWA installation · glanceability · subtle animation ·
smooth transitions.

Governing rule for every phase transition:

> **Demote, never delete.** At each phase one action is promoted to primary;
> everything else drops one level — primary → secondary → behind a tap — and
> nothing is ever removed, because **poker phases overlap**. People rebuy while
> others are cashing out, and a rejoin can reverse a cash-out.

## 17. Constraints

Do not change: settlement logic · rake logic · winner's cut logic · permissions ·
business rules · backend calculations.

UX and information architecture only, **except** three changes explicitly
approved in v1.1:

1. **The audit model** — §13.1–13.3. Includes the predicate move, which preserves
   an existing permission rather than changing one.
2. **`defaultBuyIn` on Club** — §9.3. One nullable column.
3. **The buy-in notification copy** in `messageTemplates.ts` — *"Aniket bought you
   in for ₹3,000"*, because the player requested nothing.

Every one of these touches money or approvals, so all three run through
[`MONEY-CHANGE-CHECKLIST.md`](MONEY-CHANGE-CHECKLIST.md) — correctness,
traceability, recoverability, observability — including the mutation step that
proves a new test can actually fail.

---

## 18. Deliverables — status

**Phases 1–3 are complete.** Do not redo them.

| Phase | Status | Where |
|---|---|---|
| **1** · Three+ concepts, different IAs | ✅ Four concepts | [`MOBILE-IA-CONCEPTS.md`](MOBILE-IA-CONCEPTS.md) §3–5, [`IA-PRESSURE-TEST.md`](IA-PRESSURE-TEST.md) §1 |
| **2** · Pressure-test against real nights | ✅ Five nights, six revisions | [`IA-PRESSURE-TEST.md`](IA-PRESSURE-TEST.md) §5–6 |
| **3** · Recommend one, defend it | ✅ | [`IA-PRESSURE-TEST.md`](IA-PRESSURE-TEST.md) §7 |
| **4** · Phased implementation plan | ✅ Eight stages | [`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md) |

### The recommendation, in one paragraph

**Concept A's spine — the night as one continuous document, time as the
organising principle — governed by Concept D's law of subtraction, with
player-first defaults and four nav destinations.** Concept D (game state) lost as
a spine for a checkable reason: it needs hard phase boundaries and poker has two,
which are exactly the two the schema already models. It won as the rule
governing every transition (§16). Concept B (inbox) is faster and was rejected
because running a poker night should not feel like clearing email and it needs a
second architecture for players. Concept C (the felt as home) contributed the
best settlement interaction in the product — walking the table seat by seat — and
was rejected as a home screen because it fails the three-second test on "is
anyone waiting on me?" and makes invented seat geometry load-bearing.

### Decisions — all resolved, v1.1

| # | Decision | Outcome |
|---|---|---|
| 1 | Audit fields | ✅ **All four**, forever — Requested For · Requested By · Approved By · Approved At (§13.1). Carries the predicate move in §13.2 and the void fix in §13.3. |
| 2 | Buy-in notification | ✅ **Reworded.** *"Aniket bought you in for ₹3,000"* — the player requested nothing. |
| 3 | "Edit Chips" | ✅ **Removed.** Replaced with nothing; no placeholder. The app tracks money, not stacks — it returns only if live stack tracking ever does. |
| 4 | Ranks | ✅ **Top level.** Players open the app far more than hosts, and lifetime standings are the only truthful long-term metric they have. |
| 5 | Five-minute expiry | ✅ **Ship the countdown, leave the TTL.** Observe and measure before deciding five minutes is right. |
| 6 | Default buy-in | ✅ **Per-club default** (§9.3), with personal presets beneath it. |

**Nothing blocks Phase 4.** Remaining questions are implementation detail, not
product direction.

### Prerequisites that are not UX

- **No router, no history entries** ([`NAVIGATION-AUDIT.md`](NAVIGATION-AUDIT.md) §1).
  Every sheet in this design is unusable if the back gesture exits the app. This
  is the one engineering prerequisite I would not start without.
- **37 `alert()` calls**, several in the settlement path.
- **No PWA manifest, service worker or icons** — the app cannot be installed, and
  safe-area and standalone behaviour only manifest once it can be.

---

## 19. One final design principle

> Don't design a collection of screens. Design the feeling of hosting a poker
> night. Every interaction should reduce friction, increase confidence, and make
> the host feel in control while making players feel like they're sitting around
> a real poker table — not operating accounting software.
