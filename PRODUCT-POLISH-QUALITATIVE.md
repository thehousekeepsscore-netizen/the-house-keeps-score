# Qualitative audit — first impressions and the Apple review

**Date:** 2026-08-05 · **Branch:** `product-polish` · Read-only, nothing implemented
**Companion to:** [PRODUCT-POLISH-AUDIT.md](PRODUCT-POLISH-AUDIT.md)

The first audit measured. This one judges. Where a judgement is grounded in
something countable I have said so, because "feels busy" is only useful if you
can point at what is causing it.

---

## 1. Density, measured

The number that explains most of the qualitative findings below:

| Screen | Interactive | Text nodes | Nesting depth | **Borders** |
|---|---|---|---|---|
| Splash | 0 | 2 | 3 | **2** |
| Login | 8 | 10 | 5 | **13** |
| Profile setup | 11 | 8 | 4 | **26** |
| Account settings | 11 | 14 | 8 | **41** |
| Dashboard | 33 | 65 | 15 | **150** |
| Club detail | 103 | 181 | 15 | **414** |

*Caveat: club detail spans five tabs and eleven modals, so not all 103 controls
are on screen at once. The border count is still the highest in the app by 2.8×.*

**414 borders.** Every border is a line the eye must resolve. This app separates
content by drawing boxes; Stripe and Linear separate content with **whitespace
and subtle background shifts**, reserving lines for genuine dividers. Boxes
inside boxes inside boxes — nesting depth 15 on both large screens — is the
structural cause of "busy", and it is more responsible for the feeling than any
font size.

This is the finding I'd act on ahead of the type scale.

---

## 2. First three seconds

What each screen *feels* like before the user has read a word.

| Screen | Impression | Should be |
|---|---|---|
| **Splash** | Confident | Confident ✅ |
| **Login** | Trustworthy | Trustworthy ✅ |
| **Profile setup** | Tolerable | Welcoming |
| **Dashboard** | **Busy** | Calm, oriented |
| **Club detail** | **Overwhelming** | Focused |
| **Live session** | Anxious | In control |
| **Settlement** | **Stressful** | Careful, deliberate |
| **History** | Dense | Scannable |
| **Account settings** | Utilitarian | Quiet |

### The three that matter

**Dashboard — "Busy."** 150 borders and 65 text nodes across 33 controls. The
screen presents everything at equal weight, so the eye has nowhere to land
first. A user arriving here should feel *oriented* — "here are my clubs, here's
what needs me". Instead they feel *presented with data*.

**Club detail — "Overwhelming."** The app's centre of gravity and its least
resolved screen. Five tabs of differing density in one container, 414 borders,
depth 15. There is no answer to "what is this screen for?" because it is for
nine things equally.

**Settlement — "Stressful."** This is the one I'd fix first on feel alone. It is
the most consequential action in the product: real money, between friends, and
irreversible. The interface gives it **no ceremony** — the same dense boxes, the
same shouting type, an OS `alert()` on failure. A user should feel the app is
being careful *with them*. Instead the moment of highest stakes looks identical
to the moment of lowest.

Compare Apple Wallet confirming a payment: the screen empties, one figure
dominates, motion slows down. The interface communicates *gravity*. Nothing in
this settle flow does that, and it is arguably the single highest-leverage
emotional fix in the product.

**Live session — "Anxious"** for a specific, fixable reason: rows teleport.
Approve a buy-in and the row vanishes instantly with no exit. Technically that
is the optimistic update working perfectly. Emotionally it reads as *something
disappeared* rather than *something completed*. Speed without acknowledgement
feels like instability, not performance.

---

## 3. If Apple were reviewing this internally

Not because Apple is always right — because the framing forces restraint over
addition. In rough order of how early it would come up:

### 3.1 "Why is the app shouting at me?"

The first note, and the hardest to hear. **335 bold-or-heavier weights against
22 normal. 196 uppercase. 105 letter-spacing utilities.**

Apple's typographic position is that emphasis is a *budget*. Spend it on one
thing per screen and it works; spend it everywhere and you have spent nothing.
The reviewer would ask what this screen wants me to look at first, and the honest
answer is that the app does not have a view.

### 3.2 "The system is interrupting the user on the product's behalf"

**40 native dialogs.** Apple has a specific objection here beyond aesthetics: an
OS-level alert is the *system* speaking, and using it for application logic
misrepresents who is talking. It also blocks the main thread, cannot be
dismissed by tapping away, and on iOS is visually indistinguishable from a
Safari security prompt.

The `confirm()` calls are the sharper note — the product's most careful moments
delegated to the least careful surface available.

### 3.3 "The interface is made of boxes, not of content"

**414 borders on one screen, nesting depth 15.** Apple's instinct is
content-first: chrome recedes, the user's data is the interface. Here the
containers are as visually loud as what they contain. The reviewer would ask
what happens if you delete every border and use spacing instead — and on most of
these screens the answer is "it gets better".

### 3.4 "Nothing acknowledges the user"

**4 `active:` states in the entire application.** Apple treats touch feedback as
non-negotiable, because on a touch device the press *is* the whole conversation.
An interface that does not respond to being touched feels broken regardless of
how quickly it responds afterwards.

Paired with §2's teleporting rows, the through-line is: **this app is fast but
does not feel fast**, because it never acknowledges anything.

### 3.5 "Where does motion come from?"

**90 transitions, 1 duration utility.** Everything moves at Tailwind's default
150ms linear. Apple would say motion should describe *where things come from and
where they go*. Here it is a uniform fade applied to unrelated things — which is
not a motion language, it is a default nobody chose.

### 3.6 "What is the primary action?"

**46 primary-button variants.** If every button is styled as primary, none is.
The reviewer would ask, of each screen, which single action it exists to
support — and the interface would not be able to answer.

---

## 4. The one-sentence version

> The engineering is now stronger than the design system — and the design
> problem is not ugliness, it is **the absence of restraint**.

Almost every finding here is something to *remove*: weights, uppercase,
borders, button variants, native dialogs, arbitrary sizes. Very little is
something to add. That is a good position, because subtraction is cheap and
reversible in a way that redesign is not.

---

## 5. Adjusted roadmap

Adopting your sequencing, with the two reprioritisations agreed:

### Sprint 1 · Design system
One `Button`, `Card`, `Modal`, `Dialog`, `Badge`, `Toast`, `Input`, `Select`,
`Tabs`. One scale each for type, spacing (`4 8 12 16 20 24 32 48`), radius,
shadow, motion, z-index. Kill all 40 native dialogs.

**Carried up from the quantitative audit:** no financial figure below 12px. That
is legibility, not scale purity, and it should not wait.

**Added on the evidence in §1:** a **border budget**. Replace box-in-box
separation with spacing. This is the largest single contributor to "busy" and it
is mostly deletion.

### Sprint 2 · Interaction polish
Press feedback everywhere. Enter/exit motion on live rows. Loading, success and
failure states with real timing. Give **settlement** its ceremony — this is the
emotional centre of the product and currently its most stressful screen.

### Sprint 3 · Dashboard — "Busy" → "Calm, oriented"
### Sprint 4 · Club detail — "Overwhelming" → "Focused"
### Sprint 5 · Live session — "Anxious" → "In control"
### Sprint 6 · Accessibility
Largely free once the shared `Modal` and `Button` exist.

**Deferred from Sprint 1** (your call, and correct): the remaining 145 arbitrary
font sizes. Users feel density and hierarchy; they do not perceive pixel values.

---

## 6. Still needs your eyes

This document is more inference than the last one, and the density table is the
only part of it that is hard evidence.

Screenshots of the **dashboard** and the **club screen's five tabs** would let me
replace impression with observation — particularly for colour in practice,
optical balance, and whether the settle flow reads as stressful in the way the
structure suggests.
