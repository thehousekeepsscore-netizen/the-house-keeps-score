# Next session — full mobile experience redesign

**Written:** 2026-08-06 · **Branch:** `product-polish` · **Status:** brief, not started

Read this first. It exists so a cold session starts from what we already know
rather than re-deriving it from the code.

---

## The brief

**Forget the current UI. Do not iterate on the existing layout.** Redesign the
complete mobile experience around the natural lifecycle of a real poker night.

The bar is Apple Wallet, Linear, Revolut and Superhuman — while remaining
unmistakably a poker app. Primarily a phone, eventually a PWA.

**The overriding instruction:**

> Don't optimize individual screens. Optimize the feeling of running a poker
> night from start to finish. If an interaction doesn't make the evening
> smoother for the host or the players, reconsider whether it belongs.

### The journey, treated as one thing

```
Club Dashboard → Start Session → Live Session → Player Actions
    → End Game → Settlement → History
```

Every screen flows into the next. No isolated redesigns.

### Specific direction

**Live session** — surface anything needing attention immediately; the admin
should never scroll to discover work waiting for them. The table stays the
visual centrepiece but must not hold the most valuable space when someone is
waiting.

**Player interaction** — remove the permanent Cash Out button. Cash Out is an
end-of-session action used once per player; Buy In is used all night. Tapping a
player opens a contextual bottom sheet: Cash Out, Edit Chips, View History,
Notes, admin actions. *The player becomes the interaction point rather than
generic buttons.*

**Poker table** — each seat communicates state visually: playing, waiting for
buy-in, waiting for cash-out, sitting out, dealer. Photos when available,
premium generated placeholders otherwise. Seating adapts to count.

**Settlement** — an accounting reconciliation, not a calculation form. The admin
answers one question: *has every rupee been accounted for?* Rake and winner's cut
are **adjustments, not warnings**, collapsed by default. Never use the word
"mismatch" — say *"₹500 still needs to be accounted for."*

**Session naming** — the club name appears once. Use "Day 1 · Session 1" or a
convention that communicates progression.

### Constraints

Do not change: backend APIs, permissions, calculations, rake logic, winner's cut
logic, settlement rules, business logic. **UX only.**

### Deliverables — do not write code first

1. **Three completely different concepts.** Different information architectures
   and user journeys, not colour variations.
2. **Evaluate each** on speed, cognitive load, learnability, mobile ergonomics,
   scalability, poker realism.
3. **Recommend one and defend it. Do not hedge.**
4. **Only after approval**, a phased implementation plan that keeps the app
   working throughout.

---

## State the next session inherits

### Already true — don't rediscover it

- **Design system exists**: `ui/Button`, `ui/Sheet`, `ui/ConfirmDialog`
  (18 tests). Sheet is bottom-anchored with focus trap, Escape, scroll lock and
  safe-area padding. The bottom-sheet pattern the brief asks for is already
  built.
- **Live session is partly redesigned**: action queue above the fold, vitals row,
  header no longer wraps, avatars with per-seat state, adaptive seat geometry,
  pot on the felt.
- **All three `confirm()` calls are gone.** 37 `alert()` calls remain.
- Engineering baseline is `v1.0-engineering-baseline` on `main`, CI green.

### Known to be wrong, with the real cause

- **Club name appears twice** — this is a *naming bug*, not a layout one.
  `handleStartSession` composes the session name as `` `${label} · Day ${n}` ``
  where `label` is the club name. Fix it there and the header owns the club name
  alone. Cheaper and more correct than changing the layout.
- **The Buy in / Cash out pair I built is wrong** and the brief supersedes it.
  It was the right answer to "two competing primaries" and the wrong answer to
  "what does a player actually do most". Expect to delete it.
- **Nav has six destinations at ~8–9px labels.** Untouched.
- **37 `alert()` calls.** Untouched.

### Verified vs not

Verified on screen at 390×844: header, vitals, action queue, approve flow,
avatars, pot, adaptive geometry at three players.

**Not verified:** the per-seat state badges (coin / door), nine players, any real
device, keyboard overlap.

### How to see the app

```
apps/api    tsx watch, port 4001
apps/web    npm run dev — note: hardcodes --port=3000, which overrides
            any assigned port. Worth removing that flag.
```

Local test data, created by me and safe to delete:

```
polish-audit@test.local / PolishAudit123!    (club owner, profile complete)
club "Friday Night"  code #60781             3 players, active session
```

Requests older than five minutes are auto-rejected by the expiry sweep, so
re-seed pending buy-ins before testing the queue or it will look empty.

### Documents that already answer parts of this

- `PRODUCT-PRINCIPLES.md` — 11 rules including *lead with what needs a decision*,
  *read top, act bottom*, *pending state never masquerades as settled state*
- `LIVE-SESSION-IA.md` — three layouts, journeys timed, why the table dropped
  from first to sixth
- `PRODUCT-POLISH-AUDIT.md` / `-QUALITATIVE.md` — the measured design debt
- `MOBILE-AUDIT.md` — PWA gaps, safe areas, `inputMode`, one-thumb rule
- `RISK-MATRIX.md` — living, 20 fixed / 9 open

### Still open, unrelated to this brief

- `JWT_ACCESS_SECRET` and the Supabase password are **not rotated**
- No ESLint config
- No PWA manifest, service worker or icons — the app cannot be installed
