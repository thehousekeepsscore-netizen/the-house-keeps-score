# Mobile IA — three concepts for the whole poker night

**Date:** 2026-08-06 · **Branch:** `product-polish` · **Status:** design only, no code
**Responds to:** [`NEXT-SESSION-BRIEF.md`](NEXT-SESSION-BRIEF.md)
**Partly superseded by:** [`IA-PRESSURE-TEST.md`](IA-PRESSURE-TEST.md) — adds a
fourth concept (Game State), corrects a host bias in the recommendation, and
revises §3 and §7 after stress-testing against five real nights. Read that
second.
**Method:** designed from the lifecycle of a night and from the data model the
app actually has — not from the current component tree.

Nothing in the current UI is treated as worth keeping unless it earns its place
here on its own.

---

## 0. What I treated as fixed

The brief's constraints, unchanged: no backend, no permission, no calculation,
no rake, no winner's-cut, no settlement-rule changes. Every idea below is
achievable against today's API.

Where a claim comes from the code, it is cited. Where it is a judgement, it says
so.

---

## 1. Six things in the brief I would change, with reasons

The brief asked to be challenged. These are the places where I think it is
either out of date, internally inconsistent, or asking for something the data
model cannot express.

### 1.1 The "club name appears twice" bug is already fixed — and the stated cause is stale

The brief says the duplication comes from `handleStartSession` composing
`` `${label} · Day ${n}` `` where `label` is the club name.

That is no longer what the code does. [ClubDetailView.tsx:1007](apps/web/src/components/ClubDetailView.tsx:1007)
builds `label` from **the date**, not the club name:

```
const label = new Date().toLocaleDateString(undefined, {
  weekday: 'short', day: 'numeric', month: 'short',
});
const sessionName = `${label} · Day ${sessionNum}`;
```

The club name renders exactly once, in the header at
[ClubDetailView.tsx:1958](apps/web/src/components/ClubDetailView.tsx:1958).
A session started today is called `Wed, 6 Aug · Day 12`.

So this item can come off the list. But it exposes a different naming bug, below.

### 1.2 "Day 1 · Session 1" is worse than what exists, and the model can't support it

Two problems.

**The word "Day" is already a lie.** `dayNumber` is assigned server-side as
`idx + 1` over the club's entire record list —
[clubRecords.service.ts:353](apps/api/src/modules/clubRecords/clubRecords.service.ts:353):

```
const withDay = rawList.map((item, idx) => ({ ...item, dayNumber: idx + 1, dayTitle: `Day ${idx + 1}` }));
```

That is a **count of nights**, labelled as a day number. The client repeats the
mistake with `normalizedSessions.length + 1`. Nothing anywhere models a day that
contains sessions.

**So "Session 1" would be a constant.** There is no second session within a day
to number. The label would read `Day 12 · Session 1` on every night forever —
two tokens, one of which never varies, on a 390px header. Making it real needs a
`day` entity, which the brief forbids.

**Counter-proposal.** Name a night the way people recall it, and let progression
live where progression is actually read — the history list:

```
   Fri 8 Aug                        ← the name. That's it.
   Night 12 · 6 players · 4h10m     ← metadata line, secondary weight
```

`Night 12` communicates progression more honestly than `Day 12` and costs
nothing. On the rare night with two sittings, disambiguate on the axis people
actually use — `Fri 8 Aug · late` — rather than pre-paying for it every night of
the year. Progression is a property of the *list*, not of the *title*.

### 1.3 "The table stays the visual centrepiece" contradicts this project's own IA doc

[`LIVE-SESSION-IA.md`](LIVE-SESSION-IA.md) ranks the table **6th of 6** and
argues the case well: seat position is fictional (the app never learns where
anyone sits), the oval spends ~40% of the first viewport on three names and
three numbers, and it does not survive nine players.

Both documents are right about different things, and the conflict dissolves once
you separate them:

> The table is the centrepiece of the app's **identity**. It is not the
> centrepiece of the app's **first viewport**.

Resolution used in all three concepts: the felt is real, beautiful, and
load-bearing — as a **view mode** and as **the settlement surface**, where
walking seat-to-seat is genuinely the best interaction in the product. It is not
the thing between the host and a waiting player.

### 1.4 Removing the permanent Cash Out button is right, but end-of-night breaks the sheet model

Agreed on the diagnosis, and I would go further: the whole generic-button model
should go, not just Cash Out.

But the frequency argument has a hole. Cash Out is used **once per player** —
and at the end of the night, that means *every player within about ten minutes*,
at the exact moment people have their coats on. A pure tap-player → sheet →
Cash Out flow costs three taps × N players, precisely when patience is lowest.

Resolution: player-as-interaction-point **during play**, plus an explicit
**wind-down phase** that walks the table and counts everyone. Not a permanent
button — a phase, which appears when the night enters it and disappears after.

### 1.5 Never say "mismatch" — and the vocabulary problem is bigger than one word

Agreed, and it generalises. The settlement engine's vocabulary — *mismatch*,
*excess*, *shortfall*, *rake*, *winner's cut*, *pot adjustment*, *deduction* —
is **accounting vocabulary that has leaked into the interface**. All of it needs
translation, not just the one word:

| Engine says | Screen says |
|---|---|
| `mismatchAmount > 0` (excess) | ₹500 more was counted than was bought in |
| `mismatchAmount < 0` (shortfall) | ₹500 still needs to be accounted for |
| `rakeDeduction` (flat) | Table fee · ₹200 split 5 ways |
| `winnersCutDeduction` | Club's share of winnings · 5% |
| `potContribution` | Added to the club pot |
| `requiresManualResolution` | You need to decide where this goes |

One asymmetry the brief flattens: it says rake and winner's cut are
"adjustments, not warnings, collapsed by default." Correct — but that must not
extend to an unaccounted amount. Rake and the cut are **decisions the club
already made** and can be collapsed. An unaccounted amount is **a question
directed at the admin right now** and must never be. Two of three collapse; the
third is the screen.

### 1.6 The five-minute expiry is invisible, and that is the most damaging thing in the product

[offlineSessions.service.ts:102](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:102)
auto-rejects any pending buy-in, sit-in or cash-out after five minutes. The
brief mentions this only as a testing note ("re-seed pending buy-ins or the
queue will look empty").

Consider what it does to a real night. Arjun asks for 3,000. The host is dealing
and glances at their phone seven minutes later. The queue is **empty**. No
record, no notice, nothing to say a request ever existed. Arjun's phone says
rejected. Neither of them knows why, and the natural reading is that the host
said no.

Every concept below renders **time remaining on every pending item**, and treats
expiry as an event with a corpse — `Arjun's request expired · Ask again?` —
rather than a silent deletion. This is pure UX, needs no backend change, and I
would rank it above anything the brief lists.

### 1.7 Two gaps in the journey diagram

`Dashboard → Start → Live → Actions → End → Settlement → History` omits three
real phases the product already implements:

- **Getting in** — browse, request to join, wait for admin approval
  (`ClubJoinRequest`). A player's first ever experience of the app is entirely
  in this phase, and it appears nowhere in the brief.
- **Deciding the night is over.** There is no moment in the current app where
  someone declares the night done. It is implied by everyone having cashed out.
  That transition is a real, unmodelled step.
- **Disputes.** `PendingChangeRequest` + `AuditLog` — editing or deleting a
  settled night requires a second admin's approval. This is a whole workflow
  living in two orphaned tabs ([`NAVIGATION-AUDIT.md`](NAVIGATION-AUDIT.md) §2)
  that no concept would include if the diagram were followed literally.

The brief is also written almost entirely from the host's seat. Most people
using this app are **not** the host. Each concept states what the same
architecture looks like to a player.

---

## 2. Shared foundation — the night as a state machine

All three concepts share this, because it comes from the data, not from a
layout. Today's app has two states (`active` / `settled`). The night actually
has six, and every one of them has a different answer to *what do I need to do
next?*

| # | Phase | Detected from | The one job | Screen leads with |
|---|---|---|---|---|
| 0 | **Dark** | no active session | start, or look back | Last night's result + Start |
| 1 | **Opening** | active, nobody banked | get people seated and banked | Who's here, who needs chips |
| 2 | **Running** | ≥1 banked, no cash-outs | approve, glance | Anything waiting · else the scoreboard |
| 3 | **Winding down** | ≥1 confirmed cash-out | count everyone out | Who is still uncounted |
| 4 | **Reconciling** | all counted | does it balance? | The unaccounted amount |
| 5 | **Closed** | `status: 'settled'` | share, dispute, archive | The receipt |

All six are derivable today from `activePlayerUids`, `cashOuts` and `status` —
no schema change.

Phase 1 is the one the current app misses entirely. "Opening" and "Running" look
identical today, which is why the first fifteen minutes of a night are the
clumsiest part of the product: everyone is arriving, nobody has chips, and the
screen shows a scoreboard of zeros.

### Two mechanics shared by all three concepts

**Amounts without a keyboard.** `getBuyInCeiling`
([offlineSessions.service.ts:368](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:368))
already knows the exact ceiling, and the club knows `minBuyIn`/`maxBuyIn`. So a
buy-in is four presets and a keypad, not a text field:

```
   ┌────────┬────────┬────────┬────────┐
   │  1,000 │  2,000 │  5,000 │  Match │   ← Match = current ceiling
   └────────┴────────┴────────┴────────┘
              [ custom · keypad ]
```

This removes the keyboard from the app's single most repeated action, which
[`MOBILE-AUDIT.md`](MOBILE-AUDIT.md) §1.4 identifies as the highest-frequency
friction in the product. It is also strictly better than fixing `inputMode`,
because the best keyboard is no keyboard.

**One identity per person, everywhere.** A player gets a stable colour + chip
motif derived from their id, used identically in the queue, the roster, the
felt, settlement and history. Photos override it when present. The point is not
the artwork — it is that a person is recognisable at a glance on all five
surfaces without reading their name. That is what makes a nine-player night
scannable.

---

## 3. Concept A — **The Ledger**

> **Organising principle: time.** The app has one object — *tonight* — and it is
> a single living document that starts as an invitation, becomes a running
> account, and ends as a receipt. You never leave it; it changes underneath you.

### Navigation

**Three destinations, not six.**

```
   Tonight          Club            You
```

`Tonight` is home and is the entire journey. `Club` is everything durable —
history, ranks, pot, members, settings, disputes. `You` is profile, clubs and
account. Multi-club users switch with a chip in the header, the way Slack
switches workspaces — clubs are a *context*, not a destination.

### The document

One vertical spine, three bands, in fixed order. The bands do not move; their
*contents* change with the phase.

```
┌──────────────────────────────────────┐
│  Friday Night ▾            Fri 8 Aug │  context + identity
│  ●  4h 10m · 6 playing · ₹48,000     │  vitals, one line
├──────────────────────────────────────┤
│                                      │
│   ⏳ NEEDS YOU                       │  ← band 1: decisions
│   Arjun wants 3,000      4:12 left   │
│   [ Approve ]        [ Not now ]     │
│                                      │
├──────────────────────────────────────┤
│   You · 5,000 in · even              │  ← band 2: my state
├──────────────────────────────────────┤
│   9:42  Arjun bought 3,000           │  ← band 3: the account
│   9:31  Priya sat in                 │
│   9:14  Sam bought 5,000             │
│   9:02  Night started · 4 players    │
├──────────────────────────────────────┤
│        [ contextual action ]         │
│   Tonight      Club            You   │
└──────────────────────────────────────┘
```

Band 1 **renders nothing at all** when nothing is pending — the screen visibly
relaxes, which is itself information (`PRODUCT-PRINCIPLES.md` rule 9).

Band 3 is the innovation: **the night is an event stream, not a state dump.**
Today the app shows you the current state and throws away how it got there. A
running account is more useful during the night ("wait, did Sam already rebuy?"
is answered by scrolling, not by asking) and it *becomes* the receipt at the
end, with no transformation.

### The six phases

| Phase | What the document looks like |
|---|---|
| **Dark** | Last night's receipt, folded. One control: `Start tonight`. |
| **Opening** | Band 3 is a **guest list**, not an account — everyone in the club, tap to seat, tap to bank. The job is arrival, so the screen is about arrival. |
| **Running** | As drawn above. |
| **Winding down** | Band 2 becomes a **counting strip**: `4 of 6 counted`. Band 3 shows uncounted players first. Action: `Count next player`. |
| **Reconciling** | Bands 1–2 collapse into one sentence: the balance. Band 3 becomes the ledger with every figure editable in place. |
| **Closed** | The whole document freezes into a receipt. Shareable, disputable, and identical in shape to the live document — which is what makes it legible. |

### Settlement is not a modal — it is the end of the document

The most consequential moment in the product currently happens in a dense
centre-screen modal ([`PRODUCT-POLISH-QUALITATIVE.md`](PRODUCT-POLISH-QUALITATIVE.md)
§2 calls it "Stressful"). Here it is simply where the night's own page ends.

```
┌──────────────────────────────────────┐
│                                      │
│         ₹500 still needs             │  one sentence, huge,
│         to be accounted for          │  nothing else competing
│                                      │
│   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░  ₹47,500      │  the balance bar
│                       of ₹48,000     │
├──────────────────────────────────────┤
│   Arjun    8,000 in   12,400 out  ✎  │
│   Priya    5,000 in    3,100 out  ✎  │
│   Sam      5,000 in        —      ⚠  │  ← the ⚠ is the answer
│   …                                  │
├──────────────────────────────────────┤
│   Adjustments                     ▾  │  collapsed: table fee,
│                                      │  club's share
├──────────────────────────────────────┤
│         [ Close the night ]          │
└──────────────────────────────────────┘
```

The balance bar is the key device, and it is **visible from phase 3 onward**, not
just at the end. The admin watches it fill all night. By the time they reach
settlement they already know whether it balances — which converts settlement
from a discovery into a confirmation. That is the whole emotional difference.

The engine's `Calculate → Confirm` gate
([ClubDetailView.tsx:1701](apps/web/src/components/ClubDetailView.tsx:1701))
is **kept and dramatised**, not hidden. Editing any figure invalidates the
calculation, which is correct and should be felt: the bar goes grey and the
button reads `Check the books` again. Ceremony is the point here.

### To a player

Same document, two bands swap rank. Band 2 (my state) goes first — a player is a
player, not an auditor. Band 1 shows *their own* pending requests with the same
countdown. Their contextual action is `Buy chips`, all night, every night.

### Strongest / weakest

**Strongest:** it is the only concept that literally *is* the journey the brief
asks to optimise. There is no context switch between playing, deciding and
settling, because there is no second place to be.

**Weakest:** a five-hour night is a long document. Needs a jump affordance
(tap the vitals row to collapse the account). And a multi-club admin running two
tables has no single place to see both.

---

## 4. Concept B — **The Desk**

> **Organising principle: work.** The app is a queue of decisions. Everything
> that needs a human — join requests, sit-ins, buy-ins, cash-outs, expiring
> requests, edit disputes, settlement itself — is a card in one inbox, across
> all clubs. The goal state is empty.

### Navigation

```
   Inbox            Table           Club
```

Home is **not a place, it is your work**. Sessions and clubs are attributes of
cards, not destinations. `Table` is the current session as reference material.
`Club` is everything durable.

### The inbox

One decision at a time, full screen, in the thumb's path.

```
┌──────────────────────────────────────┐
│  3 waiting            Friday Night ▾ │
├──────────────────────────────────────┤
│                                      │
│         ⏱ 4:12                       │  the expiry, front and centre
│                                      │
│            ARJUN                     │
│         wants ₹3,000                 │
│                                      │
│      bank 5,000 → 8,000              │  consequence, stated
│      table ceiling 8,000             │
│                                      │
│                                      │
├──────────────────────────────────────┤
│  [    Approve    ]  [   Not now   ]  │
│         ○ ● ○  2 of 3                │
└──────────────────────────────────────┘
```

Approving advances to the next card. Three requests are three taps with no
reading between them, because the card is the same shape every time — the eye
lands on the amount and nowhere else.

**Zero state is the product's best screen:**

```
┌──────────────────────────────────────┐
│                                      │
│              ✓                       │
│         Nothing waiting              │
│                                      │
│    6 playing · ₹48,000 · 4h 10m      │
│    You're even                       │
│                                      │
│         [ See the table ]            │
└──────────────────────────────────────┘
```

### The six phases

The inbox absorbs all of them, because each phase is a different *kind* of card:

| Phase | The card |
|---|---|
| **Dark** | `Friday Night hasn't played since Tuesday` → `Start tonight` |
| **Opening** | Arrival cards — one per club member: `Is Priya playing?` |
| **Running** | Request cards, oldest first |
| **Winding down** | `Count Sam out` cards, one per uncounted player |
| **Reconciling** | One large card: `₹500 unaccounted` |
| **Closed** | The receipt, then the inbox is empty |

Settlement is the largest card, and the only one that scrolls.

### To a player

**This is the concept's real problem.** A player's inbox is empty ~100% of the
night. Home would be a blank screen for the majority of users, so the concept
needs a *second, different home* for non-admins — which means the app has two
architectures, and the person who is both host and player has to switch between
them mentally.

### Strongest / weakest

**Strongest:** unbeatable on seconds-to-act, and it is the only concept whose
performance is *flat* as things scale — six requests across two clubs with nine
players each is still one card at a time. It also makes the expiry timer
structurally unmissable, and it is the only one that gives disputes and join
requests a natural home rather than an orphaned tab.

**Weakest:** it is an *administrator's* mental model imposed on a social evening.
An inbox with a zero-state goal makes running a poker night feel like clearing
email. And it is the least poker-like thing in this document — you could
reskin it as an expense-approval app without changing a pixel of the structure.

---

## 5. Concept C — **The Room**

> **Organising principle: people.** The felt is home. There are no lists as a
> primary surface and no queue. Every action in the product is reached by
> touching a person. The table isn't a picture of the game — it *is* the
> interface.

### Navigation

```
   Table            Ledger          Club
```

### The felt

```
┌──────────────────────────────────────┐
│  Friday Night              4h 10m    │
│                                      │
│         ⓟ         ⓐ                 │
│      Priya      Arjun ⏳             │  ⏳ = wants chips, pulsing
│     8,200       5,000                │
│                                      │
│  ⓢ                          ⓜ       │
│ Sam        ₹48,000         Meera 🚪  │  🚪 = counting out
│ 5,000                       6,400    │
│                                      │
│         ⓘ         ⓿                 │
│       Ishaan    (empty)              │
│       12,000                         │
│                                      │
├──────────────────────────────────────┤
│  2 people need you        [ Next → ] │  ring-jumps to the next
│  Tonight    Ledger    Club           │  waiting seat
└──────────────────────────────────────┘
```

Requests appear **on the person who made them**. There is no separate list,
because the list would be a second representation of information the felt
already carries. `Next →` walks the ring seat to seat, so the queue exists as a
*path through the table* rather than as a stack of rows.

Tapping any seat opens the person sheet — the brief's central interaction, and
the thing this concept is built around:

```
┌──────────────────────────────────────┐
│              ⓐ                      │
│            ARJUN                     │
│      in 5,000 · wants 3,000          │
│                                      │
│      [ Approve 3,000 ]               │
│      [ Not now ]                     │
│  ──────────────────────────────────  │
│      Count out                       │
│      Adjust bank                     │
│      Tonight's activity        3 →   │
│      Note                            │
│  ──────────────────────────────────  │
│      Remove from table               │
└──────────────────────────────────────┘
```

One sheet, contents ordered by what that person needs right now. A seat with
nothing pending opens the same sheet without the top block.

### The six phases

| Phase | The room |
|---|---|
| **Dark** | Empty felt, chairs pushed in. `Start tonight` in the middle of the table. |
| **Opening** | Chairs are **empty and tappable**. Seating people *is* the setup flow — tap a chair, pick a person, set their bank. |
| **Running** | As drawn. |
| **Winding down** | Counted players' seats dim and lock. The room visibly empties as the night ends. |
| **Reconciling** | **The table is the settlement form.** Walk the ring; each seat turns from grey to green as it's counted; the pot in the middle counts down toward zero. |
| **Closed** | The final table, frozen, with results on each seat. A genuinely shareable image. |

Settlement-as-walking-the-table is the strongest single idea in any of the three
concepts. It maps exactly onto the physical act it represents — going round the
table counting people out — and it makes an unaccounted amount visible as *chips
still on the felt* rather than as a number that fails a test.

### To a player

Identical. This is the only concept where the host and the players see the same
screen, which matters socially — the phone can be passed around, and the app
never looks like an admin tool.

### Strongest / weakest

**Strongest:** unmistakably poker, uniquely so. It satisfies the brief's
player-as-interaction-point direction natively rather than as a bolt-on. And its
settlement is the best of the three.

**Weakest:** it fails the three-second test at the moment that matters most. "Is
anyone waiting on me?" requires *scanning a ring* rather than reading a line, and
the failure mode gets worse with every additional player — nine seats on a 390px
screen leaves each avatar and its badge in a space too small to be both legible
and tappable. It also makes fictional data load-bearing: the app does not know
where anyone actually sits, so the ring is invented geometry, and any meaning a
user attaches to position is wrong.

---

## 6. Evaluation

Scored 1–5 against the brief's six criteria. **Nobody sweeps**, which is how you
can tell the concepts are genuinely different.

| | **A · Ledger** | **B · Desk** | **C · Room** |
|---|:---:|:---:|:---:|
| **Speed** (seconds-to-act) | 4 | **5** | 2 |
| **Cognitive load** | 4 | **5** | 3 |
| **Learnability** | **5** | 3 | 4 |
| **Mobile ergonomics** | 4 | **5** | 2 |
| **Scalability** (9 players, 2 clubs) | 3 | **5** | 1 |
| **Poker realism** | 3 | 1 | **5** |
| **Whole-journey coherence** | **5** | 2 | 3 |
| **Serves players, not just hosts** | **5** | 1 | **5** |
| **Total** | **33** | 27 | 25 |

The last two rows are mine, not the brief's. I added them because the brief's
overriding instruction is about the journey rather than the screen, and because
most users of this app are not hosts — and neither of those is measured by the
six stated criteria.

### The journeys, timed

Estimates from tap-counts and reading load, in the manner of
[`LIVE-SESSION-IA.md`](LIVE-SESSION-IA.md) §1. **Not measured on a device.**

| Journey | Today | A | B | C |
|---|---|---|---|---|
| **J1** Approve a buy-in | ~7s | ~2s | **~1.5s** | ~4s |
| J1 with 6 pending, 9 players | ~20s+ | ~6s | **~5s** | ~15s |
| **J2** Player requests chips | ~12s | **~3s** | ~5s | ~4s |
| **J3** Settle | ~3min, anxious | ~90s, calm | ~90s | ~2min, **most accurate** |
| **J4** Glance: am I up, who's in? | ~4s | **~1s** | ~3s | ~2s |
| Count 6 players out at end | ~4min | ~90s | ~90s | **~75s** |

J2 improves in every concept for the same reason — presets replace the keyboard.
That fix is independent of which concept wins.

---

## 7. Recommendation

**Build Concept A, The Ledger.** The spine is time; the night is one document
from invitation to receipt.

No hedge, and here is what it costs.

### Why A

**It is the only one that answers the brief's actual instruction.** "Don't
optimise individual screens; optimise the feeling of running a poker night from
start to finish." B optimises the fastest *screen* in the product and leaves the
journey scattered across an inbox. C optimises the most beautiful *screen* and
makes the fastest journey slower. A is the only concept where the journey is the
architecture — literally one object with six faces.

**Settlement stops being a cliff.** This is the largest available win in the
product and A is the only concept that gets it structurally rather than
cosmetically. The balance bar is visible from the first cash-out onward, so
reconciliation becomes something the host has been watching for an hour instead
of something they discover at midnight with six people waiting to leave. B and C
both make settlement *nicer*; only A makes it *unsurprising*.

**Learnability 5, and that is not a soft criterion here.** The people using this
app learn it in a dim room, mid-conversation, once. One screen that changes is
learnable in a night. An inbox plus a table plus a club, with a different home
depending on your role, is not.

**It serves players and hosts with one architecture.** B needs two homes. That
is disqualifying for an app where the host is also a player and passes the phone
around.

**It survives the app's real constraints.** Three nav destinations instead of six
(the ~8–9px labels problem disappears by deletion). No fictional seat geometry.
Every phase transition derives from data that already exists.

### What A gives up — stated, not glossed

- **B's flat scaling.** Six pending requests in A is a taller band, not a
  constant-time card stack. Mitigated by the brief's own rule — 3+ collapses to a
  count and opens a stack — which is B's mechanic used inside A's spine. This is
  a deliberate borrowing, not a merge: A keeps the spine, B contributes one
  component.
- **Multi-club hosts.** Someone running two tables at once has no unified view.
  I think that user does not exist yet, and building for them now would cost the
  single-club host the thing that makes A good.
- **C's felt as home.** Real loss, in character and in charm. Recovered in two
  places where it earns its keep: the table as a **view mode** on the roster, and
  the table as **the settlement surface** — C's best idea, and I would take it
  wholesale.
- **A long document on a long night.** Needs a collapse affordance, and it is the
  thing most likely to need rework after the first real five-hour night.

### What I am explicitly rejecting

**B's inbox as home.** It is faster, and I am not choosing it. Running a poker
night should not feel like clearing email, and a zero-state goal is the wrong
emotional target for a social evening.

**C's felt as home.** It fails the three-second test on "is anyone waiting on
me?", and it makes invented geometry load-bearing.

---

## 8. What must be verified before any of this is built

Honest list. Most of it needs a device, which this project has not had.

- **The five-minute expiry against real behaviour.** If hosts routinely take
  longer than five minutes, the countdown will surface a problem rather than
  solve one — and the fix would be a backend change the brief forbids. **Verify
  first**; it could change the recommendation's phase 2.
- **Whether the balance bar reads as pressure or as reassurance.** The entire
  settlement argument rests on it feeling like the latter.
- **Nine players in the roster band**, on a real 390px screen.
- **The event stream over a five-hour night** — how long it actually gets, and
  whether anyone scrolls it.
- **Presets vs. the real distribution of buy-in amounts.** If most requests are
  odd numbers, the keypad is the primary path and the presets are decoration.
- **Whether players want the ledger at all**, or only their own line.
- Keyboard overlap, safe areas, and every open item in
  [`MOBILE-AUDIT.md`](MOBILE-AUDIT.md) §6.

## 9. Prerequisites that are not UX, but block it

- **No router, no history entries** ([`NAVIGATION-AUDIT.md`](NAVIGATION-AUDIT.md)
  §1). A phase-based, sheet-heavy IA depends completely on Back and edge-swipe
  behaving. Every sheet in every concept above is unusable if the back gesture
  exits the app. This is the one engineering prerequisite I would not start
  without.
- **37 `alert()` calls**, several of which sit in the settlement path — the
  product's most careful moment delegated to its least careful surface.

---

## 10. What this document is not

Information architecture and interaction design only. No colour, type, spacing,
motion, components or files — deliberately, because arranging the screen around
the code is how the current screens came to be arranged the way they are.

Next step is a decision on the recommendation, then a phased plan that keeps the
app working at every step. Not before.
