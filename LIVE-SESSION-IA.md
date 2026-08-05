# Live session — information architecture

**Date:** 2026-08-06 · Design only. No code, no colour, no typography.
**Method:** designed from the user journey, not from the component tree.
**Goal:** the fewest possible seconds between noticing something and acting on it.

---

## 1. The journeys, timed

Not screens. Sequences. Each one measured against the app as it is today,
observed running at 390×844 with three players and one pending buy-in.

### J1 · Admin approves a buy-in — *the defining journey*

Happens 5–15 times a night, mid-conversation, while someone waits.

```
today                                          target
─────────────────────────────────────────      ──────────────────────
Arjun says "I need 3k"                         Arjun says "I need 3k"
  ↓                                              ↓
Open app                        ~1.5s          Open app            ~1.5s
  ↓                                              ↓
Land on Session tab                            Request is the first
  ↓                                              thing on screen
See a badge, not the request                     ↓
  ↓                                            Thumb is already there
Scroll past the table oval      ~2s            Tap Approve         ~0.5s
  ↓                                              ↓
Scan two sections to find it    ~2s            Done                ~2s total
  ↓
Reach mid-card to tap Approve   ~1s
  ↓
Done                            ~7s total
```

**7 seconds and a scroll, versus 2 seconds and a tap.** The gap is not
performance — the app is fast. It is that the screen makes you *look for* the
thing it already knows is urgent.

### J2 · Player requests chips

```
Wants chips → find the + → modal opens → keyboard covers the field
→ type amount → submit → wait → confirmation
```

The keyboard is the problem. A numeric amount is four taps on a keypad; the
current path spends more time managing the keyboard than entering the number.

### J3 · Admin settles the night

The most consequential journey and the rarest. Deserves *more* ceremony, not
less — the opposite of J1. This is the one place where slowing the user down is
correct.

### J4 · Anyone glances at the table

The most frequent journey of all, and the only one with no action at the end.
Someone looks for two seconds to answer one question: *am I up or down, and
who's still in?*

---

## 2. Two principles that fall out of the journeys

**Read top, act bottom.** The eye enters a screen at the top; the thumb reaches
the bottom. Information belongs where the eye lands, decisions belong where the
thumb rests. Today the app has actions scattered through the middle of a
scrolling list, which forces the hand to follow the eye.

**Lead with what needs a decision.** State that requires nothing from the user
is reference material. It is not the point of the screen; it is context for the
point of the screen.

---

## 3. Priority order, with reasons

Ranked by *seconds-to-act*, not by how interesting the data is.

| # | Section | Why here |
|---|---|---|
| 1 | **Things needing a decision** | Someone is physically waiting. Every second is social friction at a real table. |
| 2 | **My own state** | "Am I up or down" is the second question everyone has, and it is asked constantly. |
| 3 | **Game vitals** — players, pot, elapsed | Answers three of the six three-second questions in one row. Reference, not action. |
| 4 | **Player list** | Scanned when settling or when curious. Rarely urgent. |
| 5 | **Buy-in history** | Audit trail. Consulted when something is disputed, which is rare. |
| 6 | **Table view** | Characterful, not informational. Belongs behind a tap. |

**Why the table drops from 1st to 6th:** seat position carries no meaning in a
companion app — the app does not know where anyone is sitting, and players do not
consult a phone to find out. It occupies ~40% of the first viewport to convey
three names and three numbers, which a list conveys in three lines and which
survives nine players where the oval does not.

**Why "my own state" beats "game vitals":** everyone at the table is a player
first and an administrator second, including the host.

---

## 4. The screen changes with the state

This is what makes it feel alive rather than arranged.

| State | The screen leads with | Rationale |
|---|---|---|
| **Nothing pending** | My state + player list | Nothing needs deciding, so the screen is a scoreboard. |
| **1–2 pending** | The requests, inline, full-width | Actionable immediately, no summarising needed. |
| **3+ pending** | A count, then a queue | Ordered oldest-first, because the longest wait is the biggest social cost. |
| **Everyone cashed out** | Settle, as the only action | The night has one remaining decision; the screen should say so. |
| **No session running** | Start session | One decision, one control. |

Same screen, five faces. The alternative — one fixed arrangement — means four of
those five states show something irrelevant at the top.

---

## 5. Fixing "Arjun · 0 Chips"

The clearest information-architecture bug on the current screen. A player with a
pending 3,000 request appears at the table as **"Arjun · 0 Chips"** — which is
*true* and *useless*, because it is settled-state vocabulary describing an
unsettled situation.

A pending request is not a chip count. It is a **question directed at the
admin**, and it should be phrased that way:

```
   Arjun          waiting · 3,000        [Approve] [Reject]
```

The rule: **pending state never masquerades as settled state.** Three vocabularies,
kept apart — *waiting* (a question), *in play* (a fact), *cashed out* (a result).

---

## 6. One primary action

Today there are three competing bottom controls: a floating action button, a
full-width CASHOUT bar, and a six-item nav — and the FAB physically overlaps the
bar. Three things claiming primacy means none has it.

**Resolution: the nav persists, one contextual action sits above it, the FAB goes.**

The action changes by role and state, because the "next thing" genuinely differs:

| Situation | The one action |
|---|---|
| Admin, requests pending | **Approve** (or Review, when 3+) |
| Player, seated | **Request chips** |
| Player, wants out | **Cash out** |
| Everyone cashed out, admin | **Settle** |
| No session, admin | **Start session** |

A control that is always present but always relevant beats three controls that
are permanently present and intermittently relevant.

---

## 7. Three layouts

The same information, ordered for three different people. These are genuine
alternatives, not variations — pick one, or make it a club setting.

### 7.1 Admin-first — *the host running the night*

```
┌──────────────────────────────────────┐
│  Friday Night · 3h20m · 12 players   │  vitals, one line
├──────────────────────────────────────┤
│  ⚠ 2 NEED YOU                        │  ← the screen, when non-empty
│  Arjun     waiting · 3,000           │
│            [ Approve ]  [ Reject ]   │
│  Priya     cashing out · 8,200       │
│            [ Confirm ]  [ Reject ]   │
├──────────────────────────────────────┤
│  You · 5,000 in · even               │  my state
├──────────────────────────────────────┤
│  Players                        12 ▾ │  collapsed list
├──────────────────────────────────────┤
│         [ contextual action ]        │  sticky, thumb zone
│  Session  History  Ranks  Table  You │  nav (5)
└──────────────────────────────────────┘
```

**Optimises J1 to a single tap with no scroll.** Vitals sit above the decisions
because they are one line and answer three questions for free; anything taller
would push the decisions down and defeat the purpose.

### 7.2 Dealer-first — *someone actively dealing*

For a table where one person deals and administers simultaneously. Interaction
budget is near zero; they are handling cards.

```
┌──────────────────────────────────────┐
│           POT  ₹42,000               │  huge, readable at arm's length
│        12 in  ·  3h20m               │
├──────────────────────────────────────┤
│  ⚠ 2 waiting            [ Review ]   │  one line, one tap
├──────────────────────────────────────┤
│  Arjun      5,000   ● in             │  dense list, no controls
│  Priya      8,200   ● cashing out    │
│  Sam        5,000   ● in             │
│  …                                   │
├──────────────────────────────────────┤
│  Session  History  Ranks  Table  You │
└──────────────────────────────────────┘
```

Deliberately **glance-optimised over action-optimised**: approvals collapse to a
count and open a sheet, because a dealer would rather act on two requests at
once than be interrupted twice.

### 7.3 Casual home game — *five friends, no ceremony*

The honest observation: among friends, approval is a formality. Nobody is
defrauding anyone over 3,000 chips, and every approval tap is friction inserted
into a social evening.

```
┌──────────────────────────────────────┐
│  Friday Night              3h20m     │
├──────────────────────────────────────┤
│  You · 5,000 in · +1,200             │  my state first
├──────────────────────────────────────┤
│  Arjun   +3,000 ↑ just now  [Undo]   │  auto-approved, reversible
│  Priya   8,200  cashed out           │
│  Sam     5,000  in                   │
├──────────────────────────────────────┤
│         [ Request chips ]            │
│  Session  History  Ranks  Table  You │
└──────────────────────────────────────┘
```

**Auto-approve under a club-set threshold, with Undo.** This is the biggest
possible reduction in seconds-to-act: from *tap to approve* to *nothing to do*.
Undo replaces confirmation, which is the right trade whenever the action is
cheap to reverse and the relationship is high-trust.

It is also the most product-opinionated of the three, and the one I would put in
front of real users before building.

---

## 8. Recommendation

**Ship Admin-first as the default.** It fixes the defining journey, it needs no
new product decisions, and the host is the person whose experience determines
whether the app gets used at all.

**Keep Dealer-first in reserve** as a display mode, not a preference — the same
data, one tap away.

**Treat Casual as a hypothesis.** The trust-threshold idea is the largest
available improvement to seconds-to-act, and also the one most likely to be
wrong. It deserves a conversation with a real poker group before a line of code.

---

## 9. What this is not

This is information architecture. It says nothing about colour, type, spacing or
motion, and it deliberately does not mention components or files. Those are the
next decision, made *after* the order is agreed — because arranging the screen
around the code is how it ended up arranged the way it is.
