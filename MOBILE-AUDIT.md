# Mobile audit — scored as an app, not a website

**Date:** 2026-08-05 · **Viewport:** 390×844 (iPhone 16) · Read-only, nothing implemented
**Principle:** [`PRODUCT-PRINCIPLES.md`](PRODUCT-PRINCIPLES.md) · **Companions:** [quantitative](PRODUCT-POLISH-AUDIT.md) · [qualitative](PRODUCT-POLISH-QUALITATIVE.md)

Findings are **[measured]** (counted in code, reproducible) or **[needs device]**
(requires a real phone — I have neither a device nor a rendered view).

---

## 0. First, a correction to my earlier audit

My desktop audit implied the app was not mobile-aware. **That was wrong.**

There is already a **bottom navigation bar** in both the dashboard
(`ClubDashboardView:1079`, `md:hidden` — mobile only) and the club screen
(`ClubDetailView:4305`, fixed at all sizes). The instinct is right and the
hardest structural decision is already made.

That correction sharpens the audit rather than softening it: the app has bottom
nav **and no safe-area handling**, which is a specific, visible defect rather
than a missing feature.

---

## 1. The five findings that matter

### 1.1 The app is not installable at all **[measured]** · Critical

```
public/manifest.json     ✗ absent
service worker           ✗ absent
app icons                ✗ absent
apple-touch-icon         ✗ absent
apple-mobile-web-app-*   ✗ absent
theme-color              ✓ present
```

If the goal is "an excellent PWA", the current score on that goal is **zero**.
There is no Add to Home Screen, no icon, no standalone window, no offline shell.
`theme-color` is set, which is a nice touch on a page that cannot be installed.

This is not a polish item. It is the entire stated objective, absent.

### 1.2 Bottom nav collides with the home indicator **[measured]** · Critical

```
env(safe-area-inset-*)   0 occurrences
viewport-fit=cover       absent from index.html
```

Both bottom navs are `fixed bottom-0` with `py-2`. On every iPhone since the X —
which is every iPhone your users have — the bottom ~34px is the home indicator.
Without `viewport-fit=cover` plus `env(safe-area-inset-bottom)` padding, the nav
sits **underneath it**.

The result is the most common tell of a web app pretending to be an app: nav
items partially obscured, and taps near the bottom edge stolen by the system
gesture. **[needs device]** to confirm severity, but the absence of both required
declarations is measured and certain.

### 1.3 Content is not cleared for the fixed nav **[measured]** · High

One `pb-28` exists across the entire codebase. Two screens have a fixed bottom
nav. So on at least one of them the **last row of content sits behind the nav** —
and the last row of a live session is where the newest buy-in request appears.

### 1.4 Money is typed on the wrong keyboard **[measured]** · High

```
inputMode=       0
type="number"   14
type="tel"       2
pattern=         0
```

Fourteen numeric fields, zero `inputMode`. On iOS, `type="number"` produces the
full QWERTY keyboard with a number row — not the large numeric keypad.
`inputMode="decimal"` produces the keypad.

For an app whose single most repeated action is typing a chip amount **one-handed
at a table**, this is the highest-frequency friction in the product. It is also a
one-attribute fix.

`type="number"` additionally brings spinner arrows and scroll-wheel value
changes, neither of which is wanted here.

### 1.5 Inputs likely zoom the page on focus **[needs device]** · High

No input declares its own font size; all 39 inherit. Sampled inputs sit in
`text-sm` (14px) and `text-lg` (18px) contexts.

**iOS Safari zooms the entire page when focusing an input below 16px** and does
not zoom back out. Every 14px field is a candidate. Combined with a fixed bottom
nav, a zoomed viewport puts the nav somewhere unpredictable.

Needs a device to confirm which fields trigger it, but the mechanism is certain
and the sampled sizes are measured.

---

## 2. Scored as a mobile application

Not as a responsive website. **Native feel** asks: would a user believe this was
installed from the App Store?

| Screen | Thumb reach | Touch targets | Native feel | Glanceability | Perf (felt) | **Overall** |
|---|---|---|---|---|---|---|
| Splash | — | — | 8 | — | 8 | **8.0** |
| Login | 8 | 8 | 6 | 7 | 9 | **7.5** |
| Profile setup | 6 | 7 | 5 | 6 | 8 | **6.3** |
| Dashboard | 6 | 6 | 4 | 5 | 8 | **5.7** |
| Club detail | 4 | 5 | 3 | 4 | 8 | **4.7** |
| **Live session** | **3** | 5 | 3 | **4** | 8 | **4.5** |
| Settlement | 3 | 5 | 3 | 4 | 7 | **4.3** |
| Account settings | 5 | 6 | 3 | 6 | 8 | **5.1** |
| **App** | **5.0** | **6.0** | **4.4** | **5.1** | **8.0** | **5.6** |

**Native feel 4.4** is the honest headline. **Perceived performance 8.0** is the
engineering work — the app is genuinely quick, and that is the hardest part to
buy later.

### The two lowest scores are the two that matter most

**Live session 4.5** and **Settlement 4.3** are the product's core value and its
worst mobile experiences. Both are used *at the table*, one-handed, under social
pressure — the exact context the principle is written for.

**Thumb reach 3/10** on both: the actions during a live game are inline with the
content they belong to, which means scrolling to reach them and stretching to the
upper screen. The one-thumb rule is currently failed by the app's most important
flows.

---

## 3. Against the one-thumb rule

| Action | One thumb, no grip change? |
|---|---|
| Approve buy-in | ❌ inline in a scrolling list |
| Reject buy-in | ❌ same |
| Request buy-in | ⚠️ opens a modal, then a keyboard |
| Sit in | ❌ inline |
| Cash out | ❌ inline, then modal |
| Start session | ❌ upper area |
| Settle | ❌ modal, multiple fields |
| Switch tab | ✅ bottom nav |

**One of eight passes** — and it is the one already served by the bottom nav that
exists. That is the clearest evidence that the pattern works and simply has not
been extended to actions.

---

## 4. What "native" would mean here

Concretely, not abstractly:

- **Bottom sheets, not centre modals.** Eleven hand-rolled centre-screen dialogs
  place their controls mid-screen and their close button top-right — the two
  worst positions for a thumb. A sheet rising from the bottom puts actions
  exactly where the thumb already is.
- **Sticky action bars.** During a live session, the primary action should live
  above the bottom nav, always reachable, never scrolled away.
- **Swipe to approve/reject.** The single highest-frequency action in the
  product, reduced to a gesture. **[needs device]** to judge whether it suits a
  money action, or whether the risk of an accidental swipe rules it out.
- **Motion that explains.** Sheets slide from where they came; approved rows
  animate out rather than teleport. Currently 90 transitions share one default
  duration.
- **Haptics** on approve, reject and settle, where supported.

---

## 5. Revised roadmap

Adopting your sequencing, with one change and one addition, both argued:

### Sprint 1 · Mobile design system
Touch targets ≥44px · safe-area support (`viewport-fit=cover` + `env()`) ·
`inputMode` on all 14 numeric fields · no input below 16px · one `Button`, one
`Sheet`, one `Dialog`, one `Card`, one `Input` — all sized for thumbs · the
`4 8 12 16 20 24 32 48` spacing scale · replace all 40 native dialogs with
bottom sheets.

> **Changed from your list:** safe areas and `inputMode` are pulled into Sprint 1
> rather than sitting in "Native Feel". Both are one-line fixes for defects that
> are visible on every iPhone on every screen, and it would be strange to ship a
> new design system on top of a nav that collides with the home indicator.

### Sprint 2 · Native feel
Bottom sheets everywhere · slide transitions · pull-to-refresh where it earns its
place · haptics · loading and success animation with real timing · press feedback
on everything.

### Sprint 3 · Live poker experience
The control centre. Sticky one-thumb action bar · larger figures · glanceable
status · fewer taps per action · less scrolling mid-game · enter/exit animation
on requests. **This is the product's core value and currently its second-worst
mobile screen.**

### Sprint 4 · PWA
Manifest · icons · splash · install prompt · offline shell · update notification
· caching strategy.

> **Argued against your ordering:** I would move a *minimal* manifest, icon set
> and `apple-mobile-web-app-capable` into Sprint 1, leaving the offline shell,
> install prompt and update flow in Sprint 4. The reason is testing, not
> completeness: safe-area behaviour, standalone-mode chrome and the status bar
> only manifest **when the app is actually installed**. Sprints 1–3 would
> otherwise be built and judged in a browser tab, and the differences would be
> discovered at the end.

### Sprint 5 · Desktop adaptation
Deliberately last, and deliberately *adaptation* rather than a second design.

### Sprint 6 · Accessibility
Largely free once `Sheet` and `Button` exist.

---

## 6. What needs a device

Everything below is inference. This is the largest such list in any audit so far,
and mobile is the hardest thing to judge without hardware:

- Whether the bottom nav is genuinely obscured, and by how much.
- Which of the 39 inputs actually trigger iOS zoom.
- Keyboard overlap — whether the buy-in field is hidden by the keyboard when it
  opens.
- Real thumb reach on a 6.1" screen.
- Whether the dark palette holds up in a dim room at an angle.
- Scroll performance with a long history list.
- Whether swipe-to-approve feels right or reckless for a money action.

**The single most useful thing you could send me:** screenshots from a real
iPhone of the live session screen and the settle modal, with the keyboard open
in one of them. That would convert most of this list into measured findings.
