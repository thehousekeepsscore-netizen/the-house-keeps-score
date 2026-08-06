# The player sheet, and one motion language

**Date:** 2026-08-06 · **Branch:** `product-polish` · **Status:** design only, no JSX
**Consumes:** `lib/night-state.ts` — five seat states, one queue
**Companion to:** [`LIVE-SESSION-INTERACTION-MODEL.md`](LIVE-SESSION-INTERACTION-MODEL.md)

Two things settled here: the sheet that becomes most of the app, and the motion
language that makes the rest of it feel like one product.

---

## 0. The framing this is designed against

**Rituals, not components.** A ritual has three parts — a beginning, a beat of
commitment, and an acknowledgement. The current app has the first two and almost
never the third: `PRODUCT-POLISH-QUALITATIVE.md` §2 found rows teleporting, four
`active:` states in the entire application, and ninety transitions sharing one
default duration. **Speed without acknowledgement reads as instability, not
performance.**

Five rituals, and every one ends with something legible:

| Ritual | The beat | The acknowledgement |
|---|---|---|
| Starting a night | Tapping Start | An empty table appears and waits |
| Buying someone in | Tapping the amount | Their seat gains chips, once |
| Approving a request | Tapping Approve | The row collapses into their seat |
| Counting someone out | Confirming the figure | Their seat fades and settles |
| Settling | Closing the books | The screen empties, one figure remains |

---

# Part 1 — The player sheet

## 1. Why it is not a menu

Wallet does not show you eight things you could do with a card. It shows you the
card, then what that card is doing.

The rule that follows: **the sheet has one subject and at most one primary
action.** If it ever needs two primaries, the state model is wrong, not the sheet.

```
┌──────────────────────────────────────┐
│                                      │
│               ⓟ                     │  A · identity, large
│             PRIYA                    │
│      asked for ₹3,000 · 4:12         │  B · the situation, in words
│                                      │
│   ┌──────────────────────────────┐   │
│   │      Approve ₹3,000          │   │  C · one primary
│   └──────────────────────────────┘   │
│           Not now                    │  D · its counterweight, quieter
│  ──────────────────────────────────  │
│   Count out                       ›  │  E · other things, quiet rows
│   Tonight's buy-ins             2 ›  │
│  ──────────────────────────────────  │
│   Remove from the table              │  F · destructive, separated
└──────────────────────────────────────┘
```

**B is the whole design.** One sentence, in the vocabulary of the state — never a
figure standing in for a situation. `asked for ₹3,000`, not `₹0 chips`.

## 2. Precedence — what the sheet is about

A seat has one state, but a person can have a *question* open on them that
outranks it. The sheet's subject is decided in this order, and it mirrors the
seat-state precedence in `night-state.ts` exactly:

```
   1. pending buy-in        → "asked for ₹3,000 · 4:12"
   2. pending cash-out      → "counting out ₹8,200 · 4:12"
   3. waiting to sit        → "wants a seat · 4:12"
   4. otherwise, the state  → "in ₹5,000 · 2 buy-ins"
```

A player who is `inPlay` **and** has a pending rebuy is a sheet about the rebuy.
The bank is still shown — as context, one line down, not as the headline.

## 3. Every state, every viewer

Three viewers: **admin**, **self**, **another player**. Another player is
read-only in every state — and read-only means the action blocks are *absent*,
never present-and-greyed.

### Waiting to sit

| | Admin | Self |
|---|---|---|
| **B** | `wants a seat · 4:12` | `waiting for a seat · 4:12` |
| **C** | `Seat Priya` | — none — |
| **D** | `Not now` | — |
| **E** | — | — |
| **F** | — | — |

Self has no primary because there is nothing to do but wait. The countdown is
the content.

### Seated, no chips

| | Admin | Self |
|---|---|---|
| **B** | `at the table · no chips yet` | `you're at the table · no chips yet` |
| **C** | `Buy in ₹3,000` (club default) | `Buy chips` |
| **D** | `₹5,000 · ₹10,000 · Other…` | same |
| **E** | Count out · Tonight's buy-ins *(empty)* | Cash out |
| **F** | Remove from the table | — |

**The state the old screen called "0 Chips".** It is not a chip count of zero, it
is a person who has not bought in yet, and the sheet says so.

### In play

| | Admin | Self |
|---|---|---|
| **B** | `in ₹5,000 · 2 buy-ins` | `you're in ₹5,000 · 2 buy-ins` |
| **C** | `Buy in ₹3,000` | `Buy chips` |
| **D** | `₹5,000 · ₹10,000 · Other…` | same |
| **E** | Count out · Tonight's buy-ins `2 ›` | Cash out · Tonight's buy-ins `2 ›` |
| **F** | Remove from the table | — |

Rebuying is the frequent action all night, so it is the primary. Counting out
happens once per player and sits below.

### In play, with a pending buy-in

| | Admin | Self |
|---|---|---|
| **B** | `asked for ₹3,000 · 4:12` | `you asked for ₹3,000 · 4:12` |
| **C** | `Approve ₹3,000` | — none — |
| **D** | `Not now` | — |
| **E** | Count out · Tonight's buy-ins | Cash out · Tonight's buy-ins |

**There is no `Buy in` here.** She already asked. Offering a second path is what
creates the one-pending-per-player 409 — this removes the collision rather than
handling it.

### Counting out

| | Admin | Self |
|---|---|---|
| **B** | `counting out ₹8,200 · 4:12` | `counting out ₹8,200 · 4:12` |
| **C** | `Confirm ₹8,200` | — none — |
| **D** | `Recount` | — |
| **E** | Tonight's buy-ins `2 ›` | Tonight's buy-ins `2 ›` |

`Recount` rather than `Reject` — the figure is wrong, the person is not.

### Cashed out

| | Admin | Self / other |
|---|---|---|
| **B** | `counted out ₹8,200` | `counted out ₹8,200` |
| **C** | — none — | — none — |
| **D** | — | — |
| **E** | `in ₹5,000 · out ₹8,200` · Tonight's buy-ins `2 ›` | same |
| **F** | Bring back to the table | — |

**No net figure, in any viewer.** Rake and the winner's cut have not been
applied, so any number here would be superseded at settlement — stating it would
be stating something false about money.

`Bring back to the table` is destructive and labelled as such, because
re-seating **voids their confirmed count** (`clearCashOutFor`). Its confirmation
says so in words: *"Priya's ₹8,200 count no longer applies. She'll need a fresh
count when she leaves."*

## 4. Two rules that keep it from becoming a menu

**Never a disabled control.** The sheet shows the reason instead. An admin who
cannot approve their own buy-in does not get a greyed `Approve`:

```
   YOU · asked for ₹3,000 · 4:12
   ───────────────────────────────
   Another admin needs to approve this.
   Priya is at the table.
```

And when nobody else is there, it says that too, rather than naming a person who
went home. A block that names an absent admin is worse than no block, because
the host taps three times learning it.

**Empty states are sentences, not blanks.** `Tonight's buy-ins` on a player with
none is not a `0` — the row is absent. Inside the history view, `No buy-ins yet
tonight.`

---

# Part 2 — One motion language

## 5. The single rule

> **Things come from where they are, and go where they went. Nothing teleports,
> and nothing moves for decoration.**

If an animation cannot be described as *where did this come from*, it is
removed. That test alone deletes most of the ninety transitions currently in the
codebase, which share one default duration and describe nothing.

### 5.1 Motion is the implementation. Feedback is the requirement.

Every action that commits anything answers four questions, in order. The first
three are the ritual; the fourth is the one products skip.

| | Question | When | How |
|---|---|---|---|
| **1** | Did the app understand me? | **Immediately** — same frame as the touch | The control depresses. No network involved, ever |
| **2** | Is it happening? | **100–200ms** | The thing being acted on starts to change |
| **3** | Did it finish? | **~300ms** | The consequence lands somewhere visible, and everything rests |
| **4** | **Or did it not?** | when the server says so | The change **returns to where it was**, with the reason |

Stage 4 is not optional and is the one this app currently gets wrong. The
mutations here are optimistic — the row collapses before the server has
answered — so a rejection has to *reverse* something the user already watched
complete. An error toast over a UI still showing the wrong state is worse than
no feedback at all, because now two things disagree and one of them is lying.

**A reversal re-enters the way it left:** the row returns at 260ms decelerating,
carrying the reason in place of its buttons — *"That request expired before you
approved it."* Never a toast alone.

### 5.2 One visual story — no starting guns

> **No two elements may begin moving at the same instant, and at most one may be
> the focus of attention at any instant.**

If the badge, the queue, the table, the avatar and the total all move together,
the eye has nowhere to land and the whole thing reads as a flicker.

**This is not a ban on overlap.** A relay has a handoff: the outgoing runner is
still moving when the incoming one starts, and that is precisely what carries
attention from one to the other. What is banned is five things firing on one
gun. The distinction is *staggered starts, with attention transferring* versus
*simultaneous starts, with attention fragmenting*.

Peripheral things — a nav badge count — do not animate at all. They change
value. Anything outside the eye's focus that moves is competing for a focus it
should not want.

## 6. The scale — four durations, three curves

Four. The codebase currently has one, applied to everything, which is not a
motion language but a default nobody chose.

| Duration | Used for | Example |
|---|---|---|
| **120ms** | A property changing on something already present | Amount updates, ring changes state, press feedback |
| **200ms** | Something leaving | Queue row collapsing, seat fading out |
| **260ms** | Something arriving with weight | Sheet rising, table rising into freed space |
| **400ms** | Ceremony — used exactly once | Settlement committing |

| Curve | Where |
|---|---|
| `decelerate` — fast then settling | Everything entering. It arrives and comes to rest |
| `accelerate` — slow then away | Everything leaving. It commits to going |
| `spring, low bounce` | The sheet only. It is the one surface the thumb summons |

**400ms exists once.** The moment ceremony is used twice it stops meaning
ceremony.

## 7. What never moves

- **Money figures never count up, roll, or tick.** A number in motion is a number
  you cannot read, and in a money app it is a number you cannot trust. Amounts
  cross-fade at 120ms or change instantly. This is not negotiable.
- **Nothing loops forever** except §9's single exception.
- **Nothing moves that a thumb might be descending on** — `PRODUCT-BRIEF` §2.5.
- **Phase changes never slide.** Two of the boundaries run backwards; direction
  would imply error.

## 8. Reduced motion

`prefers-reduced-motion: reduce` collapses the whole language to opacity and
instant position. The sheet appears rather than rises; rows disappear rather
than collapse. **No information is carried by motion alone** — every state that
animates also has a static representation, which is the same rule as never
relying on colour alone.

## 9. The table is alive — and it is not perpetual motion

You asked for the table to feel energetic, then quieten. I want to build that,
and **not** with ambient animation. A seat that breathes for four hours is
decoration by the test in §5, it drains a battery in a dim room, and — the real
argument — **motion is only meaningful when it is scarce.** If six seats are
always moving, the one seat that needs attention cannot get it by moving.

So the emotional progression is carried by **state, not by loops**:

| Night | Table |
|---|---|
| **Playing** | Full contrast. Crisp figures. Every seat at strength |
| **Someone waiting** | **The one exception:** that seat's ring pulses on a slow 2s cycle. The only repeating motion in the app, so it cannot be missed and cannot be confused with anything else |
| **Cashing out** | That seat fades over 200ms as it settles into past tense |
| **Winding down** | The table desaturates progressively — each counted-out player quietens their own seat, and the whole felt loses energy as a consequence rather than as an effect |
| **Everyone gone** | The quietest the table ever looks. Then it is replaced by one sentence |

The table does not *perform* quietness. It **is** quieter, because fewer seats
are live. The progression is a consequence of the state, which is why it will
never look staged.

## 10. Motion per ritual

### Approving a request — 5 to 15 times a night, so it matters most

One story, one focus at a time, staggered starts:

```
             │ FOCUS                    │ answers
   ──────────┼──────────────────────────┼──────────
     0ms     │ the button depresses     │ ① understood
    60ms     │ the row begins to leave  │ ② happening
   180ms     │ the seat takes over —    │
             │   amount cross-fades,    │
             │   ring pulses once       │ ③ finished
   320ms     │ content rises, rests     │
   ──────────┴──────────────────────────┴──────────
     the nav badge just changes value. It never animates.
```

**The handoff is the point.** The row is still leaving when the seat begins
responding — that overlap is what carries the eye from the request to the
person, so the money is *seen going somewhere*. Today the row vanishes and
nothing else changes, which reads as *something disappeared* rather than
*something completed*.

Note what is **not** here: the badge does not animate, the table does not move
until everything else has rested, and nothing starts at the same moment as
anything else. Five things change; one story.

**If the server rejects it** — an expired request, a 409 — the row returns at
260ms with the reason where its buttons were, and the seat's amount reverts at
120ms. The reversal is the same story played backwards, which is the only way a
user can trust what they watched.

If it was the last row, the section unmounts and the table rises — the only
moment the table travels upward.

### Buying someone in, admin path

Sheet dismisses down at 200ms, and the seat's pulse fires **as the sheet
clears** rather than behind it. The acknowledgement must be visible, or the
ritual has no third part.

### Counting someone out

Confirm → the sheet dismisses → the seat fades to past tense over 200ms and the
progress bar advances at 120ms. Nothing is removed from the ring: **cashed-out
seats hold their position**, so nobody else's seat moves.

### Starting a night

The empty table draws in once at 260ms, then waits. Seats appear as people are
banked — each arriving with a single 260ms entrance, so the table visibly fills.

### Settling — the one ceremony

```
   the screen empties           400ms
   one figure remains, large
   a beat of stillness          ~600ms with no motion at all
   the receipt settles in       400ms
```

Stillness is the device. Everywhere else this app is fast; here it deliberately
is not, because this is the moment where money between friends becomes final.

### Sheet open and dismiss

Rises from the bottom edge at 260ms on the low-bounce spring, because that is
where the thumb summoned it. Dismisses at 200ms accelerating, downward — it
returns to where it came from. Backdrop fades 120ms.

**Never a fade-in-place.** A sheet that materialises has no origin, and origin is
the entire language.

---

## 11. What this rules out

- Loading spinners on anything under 400ms — a spinner that flashes is noise.
- Success toasts for actions whose result is visible. The seat changing **is**
  the acknowledgement; a toast on top of it is the app talking about itself.
- Confetti, bounce-on-arrival, staggered list cascades, parallax.
- Any animation whose removal changes nothing about what the user knows.

## 12. Open

Haptics — a light impact on approve and confirm, a heavier one on settle — need
a real device to judge, and iOS Safari's support is inconsistent. Specified as
intent, verified at Milestone 4.
