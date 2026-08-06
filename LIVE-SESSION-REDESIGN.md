# Live session redesign brief

**Date:** 2026-08-06 · **Branch:** `product-polish`
**Basis:** the screen observed running at 390×844, signed in, with a seeded three-player session and one pending buy-in. Not inferred from markup.

---

## 0. First, corrections to my own audit

Seeing the screen changed three things I had asserted.

**The screen is more designed than my metrics implied.** There is a poker-table
visualisation with players positioned around it, a six-item bottom nav with live
badge counts, a floating action button, a "SESSION ACTIVE" status pill, and
consistent gold-on-dark branding. My audit aggregated utility-class counts across
all files and spread the blame evenly; that was wrong.

**The bottom nav is better than I credited.** It has badges showing pending
counts — genuinely good, and the hardest part of a mobile information
architecture already exists.

**The real problem is not inconsistency.** It is *what the screen chooses to show
first*. That is a different and more interesting problem than the one my
quantitative audit described.

---

## 1. The finding that matters

**The most time-critical thing on the screen is below the fold.**

Arjun is waiting for 3,000 chips. During a live game that is the one thing the
admin needs to act on, and it is invisible until you scroll past a large
decorative oval. What occupies the first viewport instead:

| Element | Approx. share of first screen | Information conveyed |
|---|---|---|
| Header (wraps to two lines) | 8% | Club name, code, role |
| Session name + STAND UP | 15% | The session is running |
| Max buy-in banner | 7% | A rule, not a state |
| **Poker table oval** | **~40%** | Three names and their totals |
| *Pending approval* | **0% — below the fold** | **The action required** |

The screen is organised around **what the app knows** — session, table, approvals,
history — rather than **what the user has to do next**. Against the three-second
test in `PRODUCT-PRINCIPLES.md`, it answers "is there an active session?" very
well and "is anyone waiting on me?" only via a small badge.

---

## 2. Specific defects, all observed

| # | Defect | Severity |
|---|---|---|
| 1 | Pending approvals below the fold, behind ~40% of decoration | **Critical** |
| 2 | Header wraps: "FRIDAY / NIGHT" on two lines, costing vertical space on every screen | High |
| 3 | Poker-table oval is the largest element and conveys three names — seat position is not meaningful in a companion app | High |
| 4 | Six bottom-nav destinations with ~8–9px labels, below legibility | High |
| 5 | Two competing primary actions at the bottom: a full-width gold CASHOUT bar **and** a gold FAB overlapping its right edge | High |
| 6 | "Requested at: 00:51:37" — a raw clock time where "2 min ago" is what a glance needs | Medium |
| 7 | Every section header shouts: APPROVALS, PENDING APPROVALS, PROCESSED BUY-INS HISTORY, STAND UP, CASHOUT | Medium |
| 8 | STAND UP — a rare action — sits in prime real estate near the top | Medium |
| 9 | Approve/Reject sit mid-card, so acting requires a reach rather than a thumb press | Medium |
| 10 | "Arjun 0 Chips" at the table while his 3,000 request is pending — the table shows settled state without indicating a pending one | Medium |

---

## 3. The redesign thesis

> **Invert the screen. Lead with what needs a decision; demote what is merely
> true.**

Concretely, top to bottom:

1. **Pending approvals first**, full-width, one card per request, with Approve
   and Reject as thumb-height buttons. If nothing is pending, this collapses to
   a single quiet line and the table moves up.
2. **A compact session strip** — name, elapsed time, player count, pot — as one
   dense row rather than a stacked block. Answers three of the six
   three-second questions in one glance.
3. **The player list as a list**, not a table diagram. Name, buy-in, status.
   Sortable by who owes what. It survives 3 players and 9 players equally, which
   the oval does not.
4. **One primary action**, in a sticky bar above the nav, changing by role and
   state: *Approve* when something is pending, *Cash out* when the user is
   seated, *Settle* when everyone has cashed out. Remove the FAB — two competing
   gold controls in the same corner is the clearest visual defect on the screen.
5. **Five nav items, not six.** Merge CASHOUT into the primary action bar, where
   it is contextual rather than permanent.

The poker-table visualisation is worth keeping *somewhere* — it is the most
characterful thing in the product — but as an optional view, not the default
occupant of the most valuable 40% of the screen.

---

## 4. Why this is not implemented yet

I stopped deliberately. This is a structural rewrite of the largest section of a
4,403-line component, and doing it properly means moving markup, not restyling
it. Starting that with little room left to verify would produce exactly the
"mechanically consistent" result you asked me to avoid.

What exists to continue from:

- `Sheet`, `Button`, `ConfirmDialog` — built and tested (18 tests).
- A seeded local environment that makes the screen reachable and verifiable:
  account `polish-audit@test.local` / `PolishAudit123!`, club `Friday Night`,
  an active session with three players and one pending buy-in. **This test data
  is mine and can be deleted freely** — nothing else depends on it.

## 5. Proposed order for the implementation session

1. Session strip + header fix (defects 2, 7, 8) — small, self-contained, visible.
2. Approvals to the top (defect 1) — the single highest-value change.
3. Player list replaces the oval (defects 3, 10).
4. Sticky primary action bar; remove the FAB (defect 5).
5. Nav reduced to five (defect 4).
6. Relative timestamps, sentence case (defects 6, 7).

Each is independently shippable and independently revertible.

## 6. Still not verified

- How this looks on a **real device** rather than a 390×844 browser viewport —
  in particular whether the bottom nav clears the home indicator now that
  `viewport-fit=cover` is set.
- Keyboard overlap on the buy-in field.
- The screen with 8–9 players, where the oval's failure will be most obvious and
  where I only tested three.
