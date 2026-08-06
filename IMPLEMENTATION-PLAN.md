# Phase 4 — implementation plan

**Date:** 2026-08-06 · **Branch:** `product-polish` · **Implements:** [`PRODUCT-BRIEF.md`](PRODUCT-BRIEF.md) v1.1
**Constraint:** the application stays fully functional at every commit.

Eight stages. Each is independently shippable, independently revertable, and
leaves the app working. Sizes are **relative**, not calendar estimates.

---

## The two rules this plan is built on

**1. Never edit `ClubDetailView.tsx` into the new design.** It is 4,600 lines and
holds five tabs, nine modals and every live-session behaviour. Editing it toward
the target is the one approach guaranteed to produce a long window where nothing
works. The new session screen is **built alongside it** and cut over once, at
Stage 6.

**2. Money changes ship alone, first, and touch no UI.** All three approved
backend changes land before any redesign work, in their own commits, so that if a
settlement figure ever looks wrong the suspect list is four small diffs rather
than a redesign.

---

## Stage 0 · Prerequisites — invisible to users · **S**

Nothing here changes a pixel. All of it blocks something later.

| Item | Why it must be first |
|---|---|
| **History via `pushState`/`popstate`** | Every sheet in the target design is unusable if the back gesture exits the app. [`NAVIGATION-AUDIT.md`](NAVIGATION-AUDIT.md) §6 rec. 3 — no router dependency needed. **The one prerequisite I would not start without.** |
| **Minimal PWA shell** — manifest, icons, `viewport-fit=cover`, `env(safe-area-inset-*)` | Safe-area, standalone chrome and status-bar behaviour **only manifest once installed**. Without this, Stages 2–6 are built and judged in a browser tab and every difference surfaces at the end. |
| **`inputMode="decimal"`** on the 14 numeric fields | One attribute, removes the QWERTY keyboard from the app's most repeated action. Independent of everything. |
| **Five-night seed fixtures** | Stages 2–6 are verified against Nights 1–5 ([`IA-PRESSURE-TEST.md`](IA-PRESSURE-TEST.md) §5), not a single happy path. Requests expire in 5 minutes, so the seeder must be re-runnable on demand. |

**Verification:** back gesture moves one level up from every screen and survives a
refresh; app installs to the home screen; bottom nav clears the home indicator on
a real device.

---

## Stage 1 · Ledger truth — backend only, no UI change · **M**

The three changes approved in v1.1. **Four separate commits**, each through
[`MONEY-CHANGE-CHECKLIST.md`](MONEY-CHANGE-CHECKLIST.md) including the mutation
step — break the implementation, watch the new test go red, restore it.

### 1a · Buy-in provenance — **the highest-risk item in this plan**

Brief §13.1–13.2. Three call sites move **together, in one commit**:

```
offlineSessions.service.ts:502   requestedBy: userId  →  the true caller
offlineSessions.service.ts:544   req.requestedBy === requesterId  →  req.userId === requesterId
ClubDetailView.tsx:1804          the client mirror, same predicate
```

Plus `approvedAt` on `BuyInRequest`, and **`sessions.service.ts:395` in lockstep**
— it carries the identical `requestedBy: userId` line for virtual-table sessions.

Splitting these is the failure mode. Fixing the field without moving the
predicate silently blocks every admin-initiated buy-in; moving the predicate
without fixing the field is a no-op that looks done.

**Required test matrix** — this is a permission-adjacent change and deserves
exhaustive coverage:

| Approver | Buy-in is for | Other admins exist | Expected |
|---|---|---|---|
| Owner | themselves | yes | allow |
| Non-owner admin | themselves | yes | **403** |
| Non-owner admin | themselves | no | allow |
| Non-owner admin | another player | yes | **allow** ← the case that breaks if split |
| Admin | another player, player-initiated | yes | allow |

### 1b · Cash-out provenance and the void fix

Brief §13.1, §13.3. Add `requestedBy` and `confirmedAt` to the `cashOuts` entry
shape. Change `clearCashOutFor` to mark `status: 'voided'` instead of deleting.

One call site must gain a status filter or **a returning player can never cash
out again**:

```
offlineSessions.service.ts:414   find((c) => c.userId === userId)  →  must ignore 'voided'
```

`settleSession:612` already filters `status === 'confirmed'` and is safe. Verify
it stays safe — a voided entry reaching settlement would corrupt a figure.

### 1c · `defaultBuyIn` on Club · 1d · Notification copy

Brief §9.3 and §17. Both small and independent. `defaultBuyIn` is nullable and
unread until Stage 4.

**Verification:** every existing test green; new provenance tests fail when
reverted; Night 3 (rejoin) replayed end to end and the voided cash-out is
present in the record rather than absent.

---

## Stage 2 · Design system and extraction — visible polish, old IA · **L**

Independently valuable: if the redesign stopped here the app would still be
meaningfully better.

- **Kill the 37 `alert()` calls** → `Sheet` / `Toast` / `ConfirmDialog`. Several
  sit in the settlement path — the product's most careful moment on its least
  careful surface.
- **Press feedback everywhere** (4 `active:` states exist today) and a real
  motion language (90 transitions currently share one default duration).
- **Avatar identity system** — stable colour + chip motif per player id, photos
  when present. Built now because Stages 3–5 all consume it, and consistency
  across surfaces is what makes a nine-player night scannable (brief §7).
- **Extract session pieces out of `ClubDetailView`** into `components/session/`,
  continuing the existing `ActionQueue` / `GameVitals` pattern. Pure extraction,
  no behaviour change — this is the strangler scaffolding Stage 3 builds on.

**Verification:** no native dialogs remain; every interactive element
acknowledges touch; extraction proven by unchanged behaviour, not by review.

---

## Stage 3 · Tonight — the spine, behind a flag · **XL**

The largest stage. A **new component tree**, rendered in place of the
`activeSession` tab content when a flag is on. The old tab remains the default
and stays fully working.

- The **six phases** (brief §2 state machine), all derived from
  `activePlayerUids`, `cashOuts` and `status` — no schema change.
- **Three bands**: needs-you · my state · the account. Band 1 renders nothing
  when empty (brief §6).
- **Action queue**: time-remaining countdown, ~400ms insert debounce, 60-second
  corpse on expiry, `Ask again` for the player (brief §6.1–6.2).
- **My state, honest**: "you're in for ₹8,000" and the season figure. **No
  tonight P&L** — the app cannot know it (brief §4.2).
- **Activity stream**, including the voided-cash-out event Stage 1b made
  recordable.

**Flag strategy:** per-user opt-in, defaulting off. Both paths are exercised in
CI. The flag is deleted at Stage 6, not left to rot.

**Verification:** Nights 1–5 replayed against the new screen with the old screen
still passing. Night 5 (chaos) is the acceptance test — three pending items, a
blocked self-approval naming a present admin, and a phase that does not lock out
a rebuy.

---

## Stage 4 · Player interaction and the flows · **L**

- **Person sheet** — the interaction point. Its top action **is** whatever that
  player has pending, which makes the one-pending-per-player 409 unreachable
  (brief §8.1). No "Edit Chips" (§8.2, decided).
- **Dual-initiator buy-in** (§9): player path unchanged; admin path composes the
  two existing calls, degrades to the player path on failure, and labels the
  control with the amount — `Buy in ₹3,000`.
- **Club default + personal presets**, default clamped to the live ceiling (§9.3).
- **Cash-out**: typed amount, explicit labelled commit, never presets (§10).
- **Opening-phase guest list** — the 9-taps-on-one-phone flow.
- **Table as a view mode**: five seat states, adaptive geometry, avatars, second
  channel for every colour signal.

**Verification:** Night 1 measured end to end — target is 9 taps on one phone
against today's ~30 across four. Night 2 confirms presets stay sane at hour four.

---

## Stage 5 · Settlement · **L**

Highest emotional stakes; depends on Stage 1's data and Stage 3's spine.

- **Balance bar from the first cash-out**, not at the end (brief §12.5) — the
  change that makes settlement a confirmation rather than a discovery.
- **Two levels**: people by default, one person's arithmetic on tap (§12.1).
- **Vocabulary translation** — no "mismatch", no engine terms (§12).
- **Who paid the unaccounted amount**, surfaced from `SettlementResult.steps`,
  which already contains the sentence (§12.2).
- **Rounding question at club setup** (§12.3).
- **`Check the books → Close the night` kept and dramatised** (§12.4).

**The settlement engine is not touched.** Both copies stay in lockstep; the
existing engine tests must pass unmodified. If a test needs changing, the change
is wrong.

**Verification:** Night 4 (rake + winner's cut + paise) and Night 5 (₹350
unaccounted) produce identical numbers to today, byte for byte, with only the
presentation different.

---

## Stage 6 · Navigation and cutover · **M**

Last among IA changes, deliberately — hardest to reverse, and its destinations
must exist before they can be collapsed into.

- The **four-tab shell**: Tonight · Ranks · Club · You (brief §15).
- `Club` absorbs history, pot, members, approvals, audit — `pot` and `auditTrail`
  stop being orphans.
- **Flip the flag on**, delete the old `activeSession` tab, delete the flag.

**Verification:** every destination reachable, correct nav item selected on every
screen including the former orphans, back gesture consistent throughout.

---

## Stage 7 · PWA, desktop, accessibility · **M**

Offline shell, install prompt, update notification. Desktop as a deliberate
adaptation, not a second design. Accessibility, largely free once `Sheet` and
`Button` carry the app.

---

## Sequencing rationale

| Decision | Reason |
|---|---|
| PWA shell in Stage 0, PWA completion in Stage 7 | Safe-area and standalone behaviour must be observable while building, not discovered at the end |
| Money changes before any UI | Isolates the only irreversible surface into four reviewable diffs |
| Avatars in Stage 2 | Consumed by Stages 3, 4, 5 and history |
| Tonight before flows | The flows need a spine to live in |
| Settlement after Tonight | The balance bar only works if the night has a continuous screen to live on |
| **Navigation last** | Hardest to reverse; needs its destinations built first; done once rather than twice |

## What not to do

- Do not edit `ClubDetailView.tsx` toward the target design.
- Do not ship Tonight and the navigation change together — two large IA changes
  in one release makes a regression impossible to attribute.
- Do not touch `computeSettlement` or either engine copy.
- Do not split Stage 1a across commits.

## Verification that is still owed a real device

Carried forward from [`MOBILE-AUDIT.md`](MOBILE-AUDIT.md) §6 and unchanged: real
thumb reach, which inputs trigger iOS zoom, keyboard overlap on the buy-in field,
the dark palette in a dim room at an angle, scroll performance on a long history,
and whether nine seats are legible and tappable at 390px.

Add one: **whether hosts actually act within five minutes** (brief §18, decision
5). Observe, do not change the TTL.

---

## The first pull request

Stage 0's history handling, alone. It is small, it is invisible, it unblocks
every sheet in the design, and it converts the browser back gesture from
destructive to useful on its own merits — so it is worth shipping whatever
happens to the rest of this plan.
