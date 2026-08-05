# Product polish audit

**Date:** 2026-08-05 · **Branch:** `product-polish` · **Baseline:** `v1.0-engineering-baseline`
**Scope:** execution quality only. No architecture, no backend, no security, no missing features.
**Status:** read-only. Nothing implemented.

---

## 0. How to read this

Every finding is marked:

- **[measured]** — derived from the code, counted, reproducible. You can verify it.
- **[needs eyes]** — inferred from markup. I cannot see the rendered app; confirm on a screenshot before acting.

I have been strict about this. Roughly two-thirds of what follows is measured,
and those are the findings I'd act on first — not because they matter more, but
because they are certain.

---

## 1. The headline answer

> **"What makes this obviously look like an indie app rather than commercial SaaS?"**

Six things. All measured. In order of how loudly they announce it:

### 1.1 Forty native browser dialogs **[measured]** · Critical

```
ClubDetailView       27 alert()  1 confirm()
ClubDashboardView     9 alert()  2 confirm()
AccountSettingsModal  1 alert()
                     ─────────────────────
                     40 native dialogs
```

Nothing else on this list comes close. A native `alert()` renders the
**browser's own OS dialog, with your domain name in it**. It cannot be styled,
branded, animated or dismissed by clicking away. It freezes the page. On iOS it
looks like a Safari security warning.

Stripe, Linear, Notion and every Apple app have **zero**. It is the single
clearest line between "someone's project" and "a product".

Worse, the app already has a toast system — **49 `pushToast` calls** — so there
are two parallel feedback languages. The same class of event tells you in a
polished in-app toast on one screen and an OS dialog on another.

`confirm()` is the more serious half: it guards **destructive actions** ("remove
user X from club"). The moment a user most needs to feel the product is careful
and considered is the moment it hands them a grey browser box.

### 1.2 Ninety-four percent of text is bold **[measured]** · Critical

```
font-bold        248
font-black        82
font-extrabold     5      = 335 heavy
                          ─────────────
font-medium       14
font-normal        3      =  22 normal
font-semibold      2
```

This is the deepest problem in the audit and the least obvious.

**When everything is bold, nothing is emphasised.** Visual hierarchy is
communicated by *contrast* — and contrast requires something to contrast
against. With 94% heavy weight there is no baseline, so the eye has no path
through the screen and every element competes equally for attention.

Compare: Linear and Stripe set body text at 400, labels at 500, and reserve 600
for genuine emphasis. Bold is rare, which is exactly what makes it work.

Combined with **196 `uppercase`** and **105 letter-spacing utilities**, the
result reads as a scoreboard rather than a financial record. There is a real
aesthetic idea in there — poker, casino, chips — but at this density it stops
being a theme and becomes noise.

### 1.3 Forty-six different primary buttons **[measured]** · Critical

**46 distinct class strings** containing `bg-accent`. Forty-six hand-written
versions of one button. Vertical padding alone spans eight values:

```
py-0.5  py-1  py-1.5  py-2  py-2.5  py-3  py-3.5  py-4
```

No two screens agree on how tall a button is. This is what people mean when they
say an app feels "off" without being able to name why — the eye notices the
inconsistency long before the mind does.

### 1.4 Nineteen buttons whose hover state does nothing **[measured]** · High

```
bg-accent hover:bg-accent    ×19
```

The hover class sets the colour it already is. Nineteen primary buttons give
**zero feedback on hover**.

And only **4 `active:` states** across the entire app — so pressing a button
almost never acknowledges the press. On touch, where there is no hover at all,
that means the primary interaction in the app feels dead until the result
arrives.

This is the "perceived performance" problem in its purest form: the app got
genuinely faster this month (optimistic updates, `−22.5%` bundle), but a button
that doesn't respond to touch feels slow no matter how fast the network is.

### 1.5 A type scale with 36% of its sizes off-scale **[measured]** · High

```
text-xs      210        text-[10px]   95
text-sm       57        text-[11px]   50
text-lg       17        text-[9px]    17
text-base     16        text-[8px]    10
                        ───────────────
                        172 arbitrary  (36% of all sizes)
```

Two problems. First, arbitrary values mean there is no ramp — sizes were chosen
per-component to make something fit rather than drawn from a system.

Second, and more seriously: **`text-[8px]` and `text-[9px]`, used 27 times.**
Eight-pixel text is below any reasonable legibility floor, and this app displays
**money**. Nothing financial should ever be at 8px.

### 1.6 Eleven hand-rolled modals and eight z-index values **[measured]** · High

Every dialog is a bespoke `fixed inset-0` block. There is no shared `Modal`
component, which guarantees drift — and the drift is measurable:

```
backdrop-blur-sm  ×12      z-0  z-10  z-20  z-40
backdrop-blur-md  ×3       z-50  z-[60]  z-[100]  z-[999]
backdrop-blur-xl  ×2
```

`z-[999]` is a layering system that has been patched rather than designed. And
because each modal is hand-written, none share entry animation, padding, header
treatment or close-button placement.

---

## 2. Screens

### 2.1 Login · **6.5/10**

| Area | Score |
|---|---|
| Visual design | 7/10 |
| UX | 7/10 |
| Speed | 9/10 |
| Professional feel | 6/10 |
| Mobile | 8/10 |
| Accessibility | 6/10 |
| Delight | 5/10 |

The first screen every user sees, and it now loads faster than anything else in
the app — it is the one screen that benefits fully from the bundle split.

**Working:** a considered gradient treatment on the primary button (the only
place in the app with real surface craft), `h-14` touch target, `active:scale`
press feedback — one of only four places that has it.

**Unfinished:**
- **High [needs eyes]** — no visible error state styling distinct from the form; a failed sign-in likely reads as a layout shift.
- **Medium [measured]** — the button's `active:scale-[0.99]` is nearly imperceptible; Apple uses ~0.96.
- **Medium [needs eyes]** — nothing communicates loading beyond `disabled:opacity-50`. Compare Stripe, where the button label itself becomes a spinner in place.

**Against the bar:** Stripe's sign-in is one column, generous whitespace, one
weight of type, one accent. This screen is close, and is the strongest in the
app. Raising it to 8+ is mostly restraint, not addition.

### 2.2 Dashboard (`ClubDashboardView`) · **5.5/10**

| Area | Score |
|---|---|
| Visual design | 6/10 |
| UX | 6/10 |
| Speed | 8/10 |
| Professional feel | 5/10 |
| Mobile | 7/10 |
| Accessibility | 5/10 |
| Delight | 4/10 |

The most-visited screen and the one carrying the most polish debt.

**Unfinished:**
- **Critical [measured]** — 9 `alert()` and 2 `confirm()`. Join a club, get an OS dialog. This is the first impression of the product's craft.
- **High [measured]** — card grid is `grid-cols-1 md:grid-cols-2 lg:grid-cols-3` with **zero `xl:` breakpoints anywhere in the app**. On a 27" monitor this is three stretched columns in a `max-w-7xl` container with dead space either side.
- **High [needs eyes]** — "My Clubs" and "Browse" cards are near-identical in weight, so the screen does not tell you where you are. Linear solves this with density: your things are dense and quiet, discovery is spacious.
- **Medium [measured]** — empty states are a single line of text ("No pending join requests"). No icon, no explanation, no action. Notion's empty states teach; these announce.
- **Medium [needs eyes]** — 15s poll with no visual settling; numbers may change under the cursor with no transition.

### 2.3 Club detail (`ClubDetailView`) · **5/10**

| Area | Score |
|---|---|
| Visual design | 5/10 |
| UX | 6/10 |
| Speed | 8/10 |
| Professional feel | 4/10 |
| Mobile | 6/10 |
| Accessibility | 4/10 |
| Delight | 4/10 |

4,403 lines and five tabs. Functionally the heart of the product; visually the
least resolved, and the inconsistency measured in §1 concentrates here.

**Unfinished:**
- **Critical [measured]** — 27 `alert()` calls, more than the rest of the app combined.
- **Critical [measured]** — ~11 hand-rolled modals, no two structurally identical.
- **High [measured]** — 8px/9px type appears here, on financial figures.
- **High [needs eyes]** — five tabs of differing density share one container; likely no consistent page rhythm between them.
- **Medium [measured]** — 86 `tabular-nums`/`font-mono` usages is genuinely good practice for money columns and should be extended everywhere figures appear.
- **Medium [needs eyes]** — the settle flow is the app's most consequential moment and gets no ceremony: no confirmation summary styling, no success animation proportional to the event.

**Against the bar:** the Stripe Dashboard handles far denser financial data
calmly, through one type ramp, one table style, and generous row height. This
screen has the data model right and the presentation under-designed.

### 2.4 Live session (within club detail) · **6/10**

| Area | Score |
|---|---|
| Visual design | 6/10 |
| UX | 7/10 |
| Speed | 9/10 |
| Professional feel | 5/10 |
| Mobile | 7/10 |
| Accessibility | 4/10 |
| Delight | 5/10 |

Speed scores highest in the app — optimistic approve/reject genuinely feels
instant now, and that work paid off.

**Unfinished:**
- **High [measured]** — rows appear and vanish with no enter/exit animation. `motion/react` is a dependency and used in only 4 files. A buy-in request appearing should animate in; a decided one should animate out. Right now state changes *teleport*, which undercuts the speed that was just bought.
- **High [measured]** — only 1 `duration-*` utility in the entire app against 90 `transition-*`. Every transition uses Tailwind's default 150ms linear. There is no motion language.
- **Medium [needs eyes]** — the live/disconnected indicator is present but likely low-prominence for how much it matters.

### 2.5 Profile setup · **6/10**

| Area | Score |
|---|---|
| Visual design | 6/10 · **UX** 6/10 · **Speed** 9/10 · **Professional feel** 6/10 · **Mobile** 7/10 · **A11y** 6/10 · **Delight** 4/10 |

A one-time gate that shapes the first impression of the product's care.

- **Medium [measured]** — camera capture is a genuinely nice touch, undersold by plain presentation.
- **Medium [needs eyes]** — no progress indication; the user cannot see how much is left.

### 2.6 Account settings modal · **5.5/10**

| Area | Score |
|---|---|
| Visual design | 6/10 · **UX** 5/10 · **Speed** 9/10 · **Professional feel** 5/10 · **Mobile** 6/10 · **A11y** 4/10 · **Delight** 3/10 |

- **High [measured]** — contains an `alert()`.
- **High [measured]** — no focus trap, no `role="dialog"`, no Escape-to-close (carried from the engineering audit; it is a UX defect as much as an accessibility one).

### 2.7 Splash screen · **7/10**

The most confident visual moment in the app. **[needs eyes]** — worth checking
it does not add perceived latency now that the entry bundle is 22.5% smaller; a
splash that outlasts the load makes a fast app feel slow.

### 2.8 Performance debug · **not scored**

Internal instrumentation, deliberately unlinked. Correctly excluded.

---

## 3. Scorecard

| Screen | Visual | UX | Speed | Pro feel | Mobile | A11y | Delight | **Overall** |
|---|---|---|---|---|---|---|---|---|
| Login | 7 | 7 | 9 | 6 | 8 | 6 | 5 | **6.5** |
| Dashboard | 6 | 6 | 8 | 5 | 7 | 5 | 4 | **5.5** |
| Club detail | 5 | 6 | 8 | 4 | 6 | 4 | 4 | **5.0** |
| Live session | 6 | 7 | 9 | 5 | 7 | 4 | 5 | **6.0** |
| Profile setup | 6 | 6 | 9 | 6 | 7 | 6 | 4 | **6.0** |
| Account settings | 6 | 5 | 9 | 5 | 6 | 4 | 3 | **5.5** |
| Splash | 8 | 7 | 8 | 7 | 8 | 6 | 7 | **7.0** |
| **Product** | **6.0** | **6.3** | **8.6** | **5.4** | **7.0** | **5.0** | **4.6** | **5.9** |

**Speed 8.6** is the engineering work showing. **Professional feel 5.4** and
**Delight 4.6** are the gap between "works well" and "feels premium" — and both
are execution problems, not feature problems.

---

## 4. Roadmap

Sequenced so each sprint makes the next cheaper. **Sprint 1 is the highest-ROI
work in this document**: it is mostly deletion and consolidation, it touches
every screen at once, and nothing after it should be built on the current
foundations.

### Sprint 1 · Foundations (Critical)
*Everything here is measured. No visual judgement required.*

1. **Replace all 40 native dialogs.** `alert()` → existing toasts. `confirm()` → a real confirmation dialog component. Single loudest win.
2. **Build one `Modal` component.** Backdrop, blur, radius, padding, header, close, entry animation, focus trap, Escape. Migrate all 11.
3. **Build one `Button` component.** 3 variants × 3 sizes replaces 46 strings. Real hover, real `active:` press, real focus ring.
4. **Fix the 19 no-op hovers** — falls out of (3).
5. **Define a z-index scale.** Kill `z-[999]`, `z-[100]`, `z-[60]`.

### Sprint 2 · Typography and rhythm (Critical/High)

6. **Rebalance weight.** Body to `font-normal`/`medium`; reserve bold for genuine emphasis. Biggest single change to perceived quality.
7. **Reduce uppercase and tracking** to section headers only.
8. **Define a type ramp**; eliminate all 172 arbitrary sizes. **No financial figure below 12px.**
9. **Define a spacing scale**; collapse 8 button paddings to 3.

### Sprint 3 · Dashboard

10. `xl:`/`2xl:` breakpoints; use the width.
11. Differentiate My Clubs vs Browse by density.
12. Empty states with icon, explanation, action.

### Sprint 4 · Club detail and live session

13. Consistent page rhythm across the five tabs.
14. `tabular-nums` on every figure.
15. Give settlement the ceremony it deserves.

### Sprint 5 · Motion

16. **Define a motion language** — 2–3 durations, one easing curve. Currently 90 transitions share one default.
17. Enter/exit animation on live rows via `motion/react`.
18. Press feedback everywhere.

### Sprint 6 · Accessibility

19. Focus traps, Escape, focus restoration, `role="dialog"` — largely free after Sprint 1(2).
20. Keyboard navigation, focus-visible rings, screen-reader labels.

---

## 5. What I could not assess

Honest limits. Everything below needs your eyes or a device:

- **Actual rendered spacing, alignment, optical balance.** I can count utilities; I cannot see whether a card looks right.
- **Colour in practice** — contrast ratios, whether gold-on-dark-green is elegant or muddy at real sizes.
- **Animation feel** — whether existing transitions are pleasant or cheap.
- **Real mobile ergonomics** — thumb reach, safe areas, keyboard-overlap on forms.
- **Perceived performance in the hand** — the thing that matters most, and the thing I can least judge.

Screenshots of the dashboard and the club screen's five tabs would convert most
of the **[needs eyes]** items into measured ones.
