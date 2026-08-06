# Live session — interaction model

**Date:** 2026-08-06 · **Branch:** `product-polish` · **Status:** design only, no JSX
**Consumes:** `lib/night-state.ts` (`d8fbf7f`) — six phases, five seat states, one queue
**Governs:** every commit in PR #3 Part 1

Interaction and information architecture only. No colour, type, or spacing
scale — those come after the order is agreed, because arranging the screen
around the code is how the current screen came to be arranged the way it is.

---

## 0. The measurement that decides three of these questions

Designed against **375 × 667** — iPhone SE 2/3, the shortest phone in real use.
Not 812: if it works at 667 it works everywhere, and the reverse is how screens
end up with their last row under the nav.

```
   status bar / safe top          20
   header (club · session)        56
   vitals row                     44
   ─────────────────────────────────
   CONTENT                       427
   ─────────────────────────────────
   contextual action bar          64
   bottom nav                     56
   safe bottom (SE = 0)            0
                                 ───
                                 667
```

**427px is the first viewport.** Every "what fits" answer below is arithmetic
against that number, not taste. On a notched 812 phone the same layout yields
511px — more table, same order.

---

## 0.5 What deserves to exist — every element ranked

*Designed from nothing. Every candidate defended or cut against 427px. Ties lose.*

The test each element has to pass: **does someone act on this, or ask it under
time pressure?** Atmosphere is allowed, but only where it costs no vertical space.

| # | Element | Cost | Verdict |
|---|---|---|---|
| 1 | **Anything waiting on me** | 0–320px | **Keep.** The defining journey. When present it outranks everything, including the table |
| 2 | **The people at the table** | ~320px | **Keep.** "Who is playing" is the second question and the only one asked constantly. This *is* the app |
| 3 | **My own bank** | 32px | **Keep.** Everyone is a player first, the host included. One line: `You're in for ₹5,000` |
| 4 | **Money on the felt** | **0px** | **Keep — free.** Lives in the hole in the middle of the table, which is otherwise empty. Earns its place by costing nothing |
| 5 | **Club + session identity** | 44px | **Keep, one line.** `Friday Night · Fri 8 Aug`. Was two lines; the second was never load-bearing |
| 6 | **Navigation** | 56px | **Keep, auto-hiding.** Hides on scroll down, returns on scroll up. 13% of the viewport permanently, for something used once or twice a night, is not defensible — but neither is trapping people |
| 7 | **Next action** | 0 or 64px | **Keep, conditional.** Absent whenever there is no next action |
| 8 | Elapsed time | ~0px | **Keep, demoted.** Rides on the header line at secondary weight. Nobody acts on it, but a night has a length and it costs nothing to say so |
| 9 | Connection status | 0px normally | **Keep, only when broken.** A dropped socket leaves the table looking perfectly normal while it silently stops changing. Silence is the failure mode, so the indicator only exists during failure |
| 10 | Player count | — | **CUT.** The table is right there. Counting the faces is faster than reading a number about them |
| 11 | Total buy-ins figure | — | **CUT.** Reference for settlement, not for a glance. It is in the review screen where it is acted on |
| 12 | Buy-in ceiling | — | **CUT from the screen.** Belongs in the buy-in sheet, at the moment it constrains a choice |
| 13 | Session type / blinds / dealer | — | **CUT.** They exist physically on the table |
| 14 | "0 pending" empty state | — | **CUT.** An empty queue must be absent, not reported. A permanent header would train the eye to skip the one region that must never be skipped |
| 15 | Buy-in history list | — | **CUT.** Audit surface. Behind a person, where a dispute starts |

### The resulting first viewport, calm case

```
   safe top                      20
   header · one line             44
   ─────────────────────────────────
   the table (money on the felt) 320
   your bank                     32
   ─────────────────────────────────
   nav (auto-hides)              56
                                ────
                                 472   of 667
```

**195px of deliberate emptiness.** That is not waste — it is what stops the
screen reading as *presented with data*, which is what the dashboard was
diagnosed with. A screen with nothing waiting should visibly look different
from one that has work on it.

### The busy case, same order

```
   header 44 · queue 320 · table 320 · bank 32 · nav 56  =  772
```

Over budget by 105px, and correctly so: **the table falls below the fold when
someone is waiting.** That is the whole priority order expressing itself in
pixels rather than in prose.

---

## 1. Fixed anatomy — three zones, never reordered

```
┌──────────────────────────────────────┐
│  Friday Night ▾              4h 10m  │  A · identity + vitals
│  ● 6 at the table · ₹48,000 in play  │     scrolls away
├──────────────────────────────────────┤
│                                      │
│  B · THE STAGE                       │  changes completely by phase
│      queue, or table, or review      │
│                                      │
├──────────────────────────────────────┤
│      [ one contextual action ]       │  C · pinned, thumb zone
│  Tonight   Ranks   Club   You        │
└──────────────────────────────────────┘
```

**Zone A scrolls. Zone C is pinned — when it exists at all.** *Read from the
top, act from the bottom* — information goes where the eye lands, controls stay
where the thumb rests. A pinned summary would eat 44px of the 427 permanently
to answer a question nobody asks twice.

### Zone C is the next action, and often there isn't one

*(Corrected on review. My first version pinned `Buy chips` permanently, which is
the always-visible Cash Out button wearing a different label — see §7 #10.)*

The bar answers exactly one question: **what is the next thing I should do?**
When the honest answer is "nothing, you're playing poker", the bar is **absent**
and the table gets those 64 pixels back.

| Situation | Bar |
|---|---|
| No session · admin | `Start tonight` |
| Opening · admin not yet banked | `Bank yourself ₹3,000` |
| Queue scrolled out of view | `3 waiting ↑` — jumps, does not approve |
| Everyone counted out · admin | `Review & settle` |
| **Playing, nothing pending** | **nothing** |
| Player, mid-game | **nothing** |

**Two rules keep it from becoming a toolbar:**

1. **It never duplicates a control already on screen.** If the queue is visible
   with its own Approve buttons, the bar does not offer approval.
2. **It is never a menu.** One control, or none.

So how does a player buy chips with no button? **They tap themselves.** Buying
chips happens two or three times a night against roughly fifteen glances — it is
not frequent enough to earn permanent residency, and the person is where the
action lives (§5). The bar is a shortcut for the *unmissable* next step, not a
home for actions.

That is the difference between this and the button we deleted: the old CASHOUT
bar was permanent and intermittently relevant. This one is intermittent and
always relevant.

**Zone B is the only thing that changes.** All six phases render into it. There
is no page transition between phases, ever — see §4.

---

## 2. The six phases

### Dark · no session

```
┌──────────────────────────────────────┐
│  Friday Night                        │
├──────────────────────────────────────┤
│                                      │
│      Last night · Fri 1 Aug          │
│      8 players · you won ₹2,400      │
│                                      │
│      11 nights before that      →    │
│                                      │
├──────────────────────────────────────┤
│      [   Start tonight   ]           │
└──────────────────────────────────────┘
```

| | |
|---|---|
| First viewport | Last night's result |
| Primary action | **Start tonight** (admin) · nothing (player) |
| Hidden | Table, queue, everything about a session that isn't running |
| Revealed on demand | History, behind the `11 nights` row |

A player sees the same screen without the button. **That is deliberate** — the
club is not "closed" to them, it just isn't playing.

### Opening · running, nobody banked

The phase the old screen had no concept of. Everyone is arriving; a scoreboard
of zeros is the wrong answer to a room filling up.

```
┌──────────────────────────────────────┐
│  Friday Night · Fri 8 Aug     0h 04m │
│  ● nobody banked yet                 │
├──────────────────────────────────────┤
│  Who's playing?                      │
│                                      │
│  ⓟ Priya                    ₹3,000 ›│  ← club members, tap to bank
│  ⓐ Arjun                    ₹3,000 ›│     amount = club default
│  ⓢ Sam                      ₹3,000 ›│
│  ⓜ Meera                    ₹3,000 ›│
│  ─────────────────────────────────   │
│  ⓘ Ishaan               not tonight  │  ← dimmed, still tappable
├──────────────────────────────────────┤
│      [   Bank yourself ₹3,000   ]    │
└──────────────────────────────────────┘
```

| | |
|---|---|
| First viewport | The guest list — every club member, tappable |
| Primary action | Bank yourself |
| Hidden | **The table.** There is nothing on it |
| Revealed | A member becomes a seat the moment they're banked |

**One tap per player**, because banking is the only thing you'd do to a name in
this phase — the amount is on the row, so the row *is* the confirmation.

### Running · the long middle

Two faces, decided by whether anything is pending.

**Nothing waiting — ~95% of the night.** Five to fifteen approvals across four
hours means the queue is empty almost always, which is why the table can be the
default view and still not be the information centrepiece.

```
┌──────────────────────────────────────┐
│  Friday Night · Fri 8 Aug     4h 10m │
│  ● 6 at the table · ₹48,000 in play  │
├──────────────────────────────────────┤
│                                      │
│         ⓐ         ⓟ                 │
│      Arjun      Priya                │
│      8,000      5,000                │
│                                      │
│   ⓢ                        ⓜ        │
│  Sam                      Meera      │
│  5,000                    12,000     │
│                                      │
│         ⓘ         ✦YOU               │
│      Ishaan       5,000              │
│      3,000                           │
│                                      │
├──────────────────────────────────────┤
│  You're in for ₹5,000                │
├──────────────────────────────────────┤
│      [   Buy chips   ]               │
└──────────────────────────────────────┘
```

**Something waiting.** The queue takes the top of zone B and pushes the table
down. It does not replace it.

```
┌──────────────────────────────────────┐
│  Friday Night · Fri 8 Aug     4h 10m │
│  ● 6 at the table · ₹48,000 in play  │
├──────────────────────────────────────┤
│  ⏳ Arjun wants ₹3,000        4:12   │
│     [   Approve   ]      [ Not now ] │
├──────────────────────────────────────┤
│         ⓐ         ⓟ                 │  table, pushed down
│      Arjun      Priya                │
│      ⏳          5,000                │
│                                      │
```

| | |
|---|---|
| First viewport | Anything waiting, else the table |
| Primary action | Buy chips (player) · Buy chips (admin — they play too) |
| Hidden | Settlement, history, anything with no bearing on the next thirty seconds |
| Revealed | Everything about a person, behind their seat |

### Winding down · first confirmed cash-out, others still in

**The table stays. It quietens.** *(Reversed on review — my first version removed
it. See §7 #4 for why that was wrong.)*

```
┌──────────────────────────────────────┐
│  Friday Night · Fri 8 Aug     6h 02m │
│  ▓▓▓▓▓▓▓▓▓░░░░░  5 of 8 counted out  │
├──────────────────────────────────────┤
│                                      │
│         ⓐ         ⓟ̶                 │  Priya faded — counted out
│      Arjun      Priya                │
│      8,000      out 8,200            │
│                                      │
│   ⓢ̶                       ⓜ         │
│  Sam                      Meera      │
│  out 4,100                12,000     │
│                                      │
│         ⌛         ✦YOU              │  ⌛ pending cash-out, glowing
│      Ishaan       5,000              │
│      counting out                    │
│                                      │
└──────────────────────────────────────┘
```

The table tells the story instead of a list summarising it:

| Seat | Treatment |
|---|---|
| Still playing | Full strength |
| Counting out | **Glows** — a question is open on them |
| Counted out | Faded, past-tense label, still present |
| Never occupied | Absent — an empty chair is not information |

**Cashed-out seats stay where they are.** They do not vanish and the ring does
not reflow, which means **no seat ever moves under a thumb mid-night** — the
same rule that governs the queue (§3), arriving independently at the same
answer. A reflowing ring would relocate every remaining player each time
someone left, during the busiest ten minutes of the night.

**The bar is progress, not money.** `5 of 8 counted out`. It must never show a
difference before everyone is out — most of the money is chips the app knows
nothing about, so ₹42,000 in against ₹8,200 out is a night in progress, not a
₹33,800 discrepancy. Showing it as one would manufacture alarm every night.

| | |
|---|---|
| First viewport | The same table, quieter |
| Primary action | None pinned — count someone out by tapping them |
| Hidden | The difference · anything resembling settlement |
| Revealed | Each person's figures, behind their seat |

### Ready · table empty

```
┌──────────────────────────────────────┐
│  Friday Night · Fri 8 Aug     6h 40m │
├──────────────────────────────────────┤
│                                      │
│         Everyone has left.           │
│                                      │
│         8 players · 6h 40m           │
│                                      │
├──────────────────────────────────────┤
│      [   Review & settle   ]         │
└──────────────────────────────────────┘
```

One decision, one control, nothing else on screen. When
`settleBlockedReason` is set the button is replaced, not disabled:

```
│   A night needs at least two players │
│   to settle. This one had one.       │
```

### Closed · settled

The receipt. Same shape as the live document, frozen — which is what makes it
legible without learning a second layout.

---

## 3. The action queue — four states

Card height is **96px**: one line of sentence, one of countdown, one row of
buttons. Against 427px of content:

| Waiting | Queue height | Left for the table | Behaviour |
|---|---|---|---|
| 0 | 0 | 427 | **Section does not render.** Not "0 pending" — absent |
| 1 | 96 | 331 | Inline |
| 2 | 192 | 235 | Inline |
| 3 | 288 | 139 | Inline — a peek of felt, enough to say it's there |
| 4+ | 320 | 107 | Three inline, fourth **peeks at 32px** |

The fourth card is the real card, cropped — not a `+3 more waiting` text row.
A partial card is the content itself saying there is more, which is a stronger
and quieter signal than a label counting it. Tapping anywhere in the crop
expands the list in place.

**I am departing from the brief here.** `PRODUCT-BRIEF` §6 and `LIVE-SESSION-IA`
§4 both say collapse at 3+. The arithmetic says 3 still leaves 139px — enough
for the table to remain visible and invite a scroll. At 4 there is nothing left.
So the threshold is **4**, derived from the budget rather than chosen.

Expanding `+3 more waiting` grows the list **in place**. It does not open a
stack screen or a separate queue view: one mental model, and the table stays
where it was.

### New arrivals append to the bottom

Oldest-first ordering means a request arriving mid-session goes to the **end**
of the list. Nothing already on screen moves. The container grows downward and
pushes the table down — never the card the thumb was aiming at.

This is the sort order and the mis-tap guard agreeing, which is worth naming
because the tempting alternative (newest first, "look what just came in") would
shift a live Approve button under a moving finger during a money action.

### Approve and reject are not symmetrical

- **Approve** — one tap, no confirmation. The amount is on the button, it is the
  affirmative answer, and it is what the player asked for.
- **Not now** — one tap, but visually secondary and **never the same size**.
  A mis-tap here is socially expensive at a real table ("you said no?"), and the
  fix is target hierarchy, not an extra step. Adding a confirm would tax the
  frequent path to protect the rare one.

### Expiry, and the corpse

```
   waiting        ⏳ Arjun wants ₹3,000              4:12
   under 1:00     ⏳ Arjun wants ₹3,000              0:47   ← tone shifts
   expired        ✕  Arjun's ₹3,000 expired before you saw it
                     (no buttons · clears itself after 60s)
```

The corpse occupies a queue slot and counts toward the collapse threshold. It
exists so a host picking up their phone at the wrong moment sees evidence
rather than an empty queue. The client says **"expiring"** at 0:00 and only
**"expired"** when the server's `expired: true` event arrives — never on its own
authority, or it would show a rejection the server has not made.

---

## 4. Transitions

**No phase transition is a page transition.** Zone B cross-fades its contents;
A and C never move. Three reasons, and the third is the one that matters:

1. The phases are not a wizard. There is no "next".
2. **Two of the boundaries run backwards.** A player who rejoins takes the night
   from winding-down to running; seating them voids their cash-out. A directional
   animation would make a normal event look like an error.
3. A phase can change while the user's thumb is descending.

| From → To | Trigger | What moves |
|---|---|---|
| dark → opening | session created | Zone B cross-fades to the guest list |
| opening → running | first buy-in approved | Guest list cross-fades to the table |
| running ⇄ winding down | first/last confirmed cash-out | Table ⇄ list. **Reversible** |
| winding down → ready | last player counted out | List cross-fades to one sentence |
| ready → running | someone re-seated | **Reversible.** No warning, no fanfare |
| ready → closed | settled | The only transition with ceremony |

**The queue's own transitions are the ones users will notice**, because they
happen 5–15 times a night:

- **Item resolves:** the row collapses its height to zero over ~200ms and the
  content below rises. Not a teleport — the qualitative audit found rows
  vanishing instantly reads as *something disappeared*, not *something
  completed*.
- **Last item resolves:** the section unmounts and the table rises into the
  space, ~260ms. This is the only moment the table animates upward.
- **First item arrives into an empty queue:** section mounts, table slides down.
  **Guarded**: if a tap landed within 300ms, it is attributed to the pre-shift
  layout. A request arriving as the admin reaches for a seat must not approve
  something instead.

---

## 5. The player sheet

**Bottom, never a side sheet.** Three reasons, and the third is new:

1. Actions land where the thumb already is.
2. `Sheet` already exists, with focus trap, Escape, scroll lock and safe-area
   padding — 18 tests.
3. **A left-edge side sheet would fight the iOS back gesture**, which Stage 0
   just wired to close sheets. Two things owning the left edge is a bug we would
   be choosing.

The sheet has three blocks. The top one is the whole idea:

```
┌──────────────────────────────────────┐
│               ⓟ                     │
│             PRIYA                    │
│      in ₹5,000 · 2 buy-ins           │
├──────────────────────────────────────┤
│   ①  whatever is pending, if any     │
├──────────────────────────────────────┤
│   ②  what this viewer may do         │
├──────────────────────────────────────┤
│   ③  destructive, separated          │
└──────────────────────────────────────┘
```

**Block ① is why the sheet is the interaction model.** If Priya has an open
request, the top action *is* that request — which makes the one-pending-per-
player 409 unreachable rather than handled after the fact.

### Four variants

**Admin → player in play**

```
   PRIYA · in ₹5,000 · 2 buy-ins
   ───────────────────────────────
   [ Buy in ₹3,000 ]              ← club default, commits on tap
     ₹5,000    ₹10,000    Other…
   ───────────────────────────────
   Count out
   Tonight's buy-ins           2 ›
   ───────────────────────────────
   Remove from table
```

**Admin → player with a pending buy-in**

```
   PRIYA · asked for ₹3,000 · 4:12 left
   ───────────────────────────────
   [ Approve ₹3,000 ]
   [ Not now ]
   ───────────────────────────────
   Count out
   Tonight's buy-ins           2 ›
```

Note there is **no `Buy in` here**. She already asked; offering a second path
would create the collision the block exists to prevent.

**Player → themselves**

```
   YOU · in ₹5,000 · 2 buy-ins
   ───────────────────────────────
   [ Buy chips ]
   ───────────────────────────────
   Cash out
   Tonight's buy-ins           2 ›
```

**Player → someone else** — read-only. Name, bank, buy-in count. No actions.
Not an empty action list: the blocks simply aren't there.

**Anyone → cashed-out player**

```
   PRIYA · counted out ₹8,200
   ───────────────────────────────
   in ₹5,000  ·  out ₹8,200
   ───────────────────────────────
   Tonight's buy-ins           2 ›
```

Past tense throughout. **No net figure** — the club's rake and winner's cut have
not been applied, so any number shown here would be superseded at settlement.
Showing it would be stating something false about money.

### The sheet reacts to its own subject

If the request expires while the sheet is open, block ① swaps in place:

```
   PRIYA · that request expired
   ───────────────────────────────
   Rahul didn't get to it in time.
   [ Buy in ₹3,000 ]              ← the admin path, now available again
```

Never a failed tap on a dead request.

---

## 6. The table, 2 → 9

**The viewer is always seated bottom-centre**, others clockwise from their left.
This is a frame of reference, not a claim about the room — the felt carries no
seat numbers and never says "seat 3", so there is nothing to mis-read as
physical position.

Felt occupies **340 × 200** inside the 427px viewport, leaving room for the
my-state line beneath it.

```
   2 players            3                    4
   ┌──────────┐        ┌──────────┐        ┌──────────┐
   │    ⓐ     │        │  ⓐ    ⓟ  │        │    ⓐ     │
   │          │        │          │        │  ⓢ    ⓟ  │
   │    ✦     │        │    ✦     │        │    ✦     │
   └──────────┘        └──────────┘        └──────────┘
   facing pair          triangle            diamond

   6                    9
   ┌──────────┐        ┌──────────────┐
   │  ⓐ    ⓟ  │        │  ⓐ  ⓟ  ⓢ    │
   │ ⓘ      ⓜ │        │ ⓘ          ⓜ │
   │    ✦     │        │  ⓝ  ✦  ⓡ    │
   └──────────┘        └──────────────┘
   hexagon              oval, tighter
```

Seats sit on an ellipse, evenly spaced from bottom-centre. **Two players is not
an oval with seven gaps** — it is a facing pair, because an empty oval reads as
absence rather than intimacy.

| Players | Avatar | Label | Amount |
|---|---|---|---|
| 2–4 | 56px | full name | under the name |
| 5–6 | 48px | full name | under the name |
| 7–9 | 40px | **first name** | badge on the avatar |

40px is below the 44px touch minimum — so **the tap target is 44px regardless**,
extending past the avatar. The circle shrinks; the target does not.

### What a seat says

Per your scope: avatar · name · total buy-in · pending buy-in · pending
cash-out · standing/seated. Every one derives from `Seat` in `night-state.ts`.

```
   inPlay          ⓟ Priya · 5,000        solid ring
   seatedNoChips   ⓟ Priya · no chips yet dashed ring
   waitingToSit    ⓟ Priya · wants a seat dashed ring + pulse
   countingOut     ⓟ Priya · counting out  ring opens at the bottom
   cashedOut       ⓟ Priya · out 8,200     dimmed, flat
```

**Never colour alone.** Each state carries a ring treatment *and* a text label —
required for colour-blind users, and for the dim rooms `PRODUCT-PRINCIPLES`
was written for.

---

## 7. Nine decisions this document makes that the brief does not

| # | Decision | Because |
|---|---|---|
| 1 | Queue collapses at **4**, not 3 | 3 leaves 139px of visible felt; 4 leaves none |
| 2 | New requests **append**, never prepend | Nothing moves under a thumb mid-approval |
| 3 | Approve one tap · reject secondary and smaller | Mis-taps fixed by hierarchy, not by taxing the frequent path |
| 4 | ~~The table disappears while winding down~~ → **the table quietens** | **Reversed on review.** People don't switch from "playing poker" to spreadsheet mode; until the last person leaves, everyone still thinks of themselves as around the table. Letting seats fade tells the story better than removing the story. It also keeps the ring from reflowing, so no seat moves under a thumb |
| 5 | Viewer always at **bottom-centre** | A frame of reference costs nothing and orients instantly |
| 6 | Cashed-out sheet shows **no net figure** | Rake and winner's cut are unapplied — any number would be false |
| 7 | Phase changes **cross-fade**, never slide | Two boundaries run backwards; direction would imply error |
| 8 | Tap within **300ms of a layout shift** binds to the old layout | A request arriving must not approve something |
| 9 | Vitals **scroll**, action bar **pins** | Read top, act bottom — 44px is too much to spend permanently |
| 10 | The action bar is **often absent** | **Corrected on review.** A permanent `Buy chips` is the CASHOUT bar we deleted, relabelled. Buying chips happens 2–3 times against ~15 glances; it belongs on the person, not pinned |
| 11 | Nav **auto-hides on scroll** | 56px is 13% of the viewport, held permanently for something used twice a night |
| 12 | Money on the felt, not in the header | It is the one figure that can be free — the middle of a table is empty by construction |

---

## 8. Answers to the five you raised

| Question | Answer |
|---|---|
| Sheet from bottom or side? | **Bottom.** A left side sheet would fight the back gesture Stage 0 just wired up |
| Does the queue collapse after approval? | The row collapses to zero height over 200ms; the section unmounts when the last one goes |
| Does the table animate upward? | Only when the queue empties, ~260ms. Never on a phase change |
| Does the session summary pin? | **No.** Vitals scroll. The action bar pins |
| Where does "Buy chips" live at 9 players? | The pinned bar. Player count is irrelevant — that is the point of pinning it |

---

## 9. What implementation becomes

With this approved, each commit has one job and no open questions:

| Commit | Reads | Renders |
|---|---|---|
| Scaffold + zones | `phase` | A, B, C shells |
| Queue | `queue[]` | §3, four states |
| Table | `seats[]` | §6, five states, 2–9 |
| Sheet | `seats[]` + viewer role | §5, four variants |
| Buy-in | `Seat.pendingBuyIn` | §5 blocks ① / ② |
| Cash-out | `Seat.pendingCashOut` | §5 |
| Phases | `phase` | §2, cross-fade only |

Nothing above needs a decision that isn't written down here.

---

## 10. What this does not cover

Colour, type, spacing, and the generated avatar artwork — deliberately, and in
that order after this is agreed. Settlement's review screen is Part 2 and has
its own open question already logged: what happens when someone leaves without
cashing out through the app, leaving a blank the host must type.
