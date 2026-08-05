# Product principles

**Adopted:** 2026-08-05 · Supersedes any implicit desktop-first assumption.

---

## The primary principle

> **The House Keeps Score is a phone-first companion app for live poker games.**
> Every interaction must be fast, one-handed and glanceable. Desktop is for
> convenience; the primary experience is at the poker table.

"Mobile-first" was too weak. It describes a viewport. This describes a *situation*
— standing around a table, one hand on the phone, mid-conversation, glancing for
two to five seconds at a time — and a situation gives far better guidance than a
breakpoint does.

## The North Star

> **Can someone run an entire poker night with one thumb, while talking to
> friends?**

Every design decision is answerable against that question.

## The rules

Referred to before any UI change. If a change violates one of these, it needs an
argument, not a preference.

1. **Phone first.** Desktop is an adaptation, never the source design.
2. **One-thumb operation.** Every common action reachable and completable in the
   thumb arc, in portrait, without changing grip.
3. **Glanceable in under three seconds.** A user should know the state of the
   night without reading.
4. **Never hide critical information behind the keyboard.**
5. **No browser-native dialogs.** `alert`, `confirm` and `prompt` are the least
   native-feeling surface on a phone.
6. **Immediate feedback for every action**, before any network work begins.
7. **Components come from the design system.** No one-off buttons, no one-off
   dialogs.
8. **Nothing important below 12px, nothing in an input below 16px.**

## The three-second test

Under time pressure, a user must be able to answer these at a glance:

- Is there an active session?
- Is anyone waiting on me?
- Does something need my approval?
- Who owes money?
- What is the pot?
- What is my next action?

If any of those takes scanning, the screen is doing too much work.

---

## Why this is the right call for *this* product

The principle is not fashion. It follows from where the app is actually used.

People open this app **at the table**, mid-game. That context is specific and
unforgiving:

- **One hand.** The other is holding cards, chips, or a drink.
- **Poor lighting.** Dim rooms, angled screens.
- **Split attention.** Glances between hands, not sessions of focused use.
- **Social pressure.** Nobody wants to be the person holding up the game because
  the app took four taps to approve a buy-in.

That context implies the design, without much argument:

| Because | The UI must |
|---|---|
| One hand | Put every common action in the thumb arc |
| Glances, not sessions | Show large numbers, high contrast, minimal text |
| Split attention | Make the current state obvious without reading |
| Social pressure | Complete common actions in one tap, with instant feedback |
| Dim rooms | Favour contrast over subtlety |

## The one-thumb rule

> **Every common action must be reachable and completable with one thumb, in
> portrait, without changing grip.**

Applies to: approve buy-in · reject buy-in · request buy-in · sit in · cash out ·
start session · end session · settle.

If an action during a live game requires reaching the top corner, it is wrong —
however good it looks.

## What this rules out

- **Desktop admin dashboards squeezed onto a phone.** Dense tables, tiny type,
  actions in the top-right, hover-dependent affordances.
- **Native browser dialogs.** `alert()` and `confirm()` are the least
  native-feeling surface available on a phone.
- **Anything that depends on hover.** There is no hover on a phone.
- **Type below 12px**, and never below 16px in an input — iOS zooms the whole
  page when focusing a sub-16px field.

## What it commits us to

- Touch targets **≥44px**, ideally 48.
- **Safe areas** respected — notch, home indicator, rounded corners.
- **Bottom-anchored primary actions**, not top-anchored.
- **Bottom sheets**, not centre-screen dialogs.
- **Installable**: manifest, icons, splash, offline shell.
- **Instant feedback** on every touch, before any network work begins.

## How to apply it in a trade-off

When mobile and desktop want different things, mobile wins — and desktop gets a
deliberate, simpler adaptation rather than the mobile layout stretched.

The honest version: this app currently has the reverse problem. Desktop is not
over-served; **both are under-served**, and mobile is under-served in ways that
are measurable (see [`MOBILE-AUDIT.md`](MOBILE-AUDIT.md)).

## What has not changed

The engineering principles from `v1.0-engineering-baseline` still hold. In
particular: **measure, don't assert.** A claim about how something feels on a
phone should be verified on a phone, and where that has not been possible, this
project says so rather than implying otherwise.
