# Two buy-in flows, chosen by who initiates

**Date:** 2026-08-06 · **Branch:** `product-polish` · **Status:** design only, no code
**Extends:** [`IA-PRESSURE-TEST.md`](IA-PRESSURE-TEST.md) §5, Night 1
**Decision:** the flow follows the initiator. Never a setting, never a club option.

---

## 1. The rule

> **A player initiating a buy-in creates a request. An admin initiating a buy-in
> creates a completed buy-in.**
>
> Same validations, same authority, same record. The only thing that changes is
> how many people have to touch their phone.

The approval isn't removed in the admin path — it is **implicit in the
initiation**, because the person creating it is the person entitled to approve
it. Asking them to confirm their own action is asking the same human the same
question twice.

Nothing about this is configurable. A club setting would mean the host has to
remember which mode they're in, and the whole value is that they don't have to
think about it.

---

## 2. What "without creating a pending request" costs — read this before agreeing

There is no endpoint that creates an already-approved buy-in. Today there are
exactly two:

```
POST  …/buy-ins              → creates BuyInRequest, status 'pending'
POST  …/buy-ins/:id/approve  → status 'approved', seats the player, notifies
```

So the instruction has two readings, and they are not the same size of change:

**(a) Literally no pending row ever exists.** Requires a new endpoint or a flag
on the existing one. That is a **backend change**, which the brief forbids.

**(b) The admin performs one gesture and is never asked to confirm.** The client
issues both calls back to back. A pending row exists for roughly 200ms.

**I recommend (b), and not only because of the constraint.** A new endpoint would
have to re-implement, in a second place, every rule the current pair enforces:
the buy-in ceiling, the one-pending-per-player rule, the self-approval rule,
seating the player, the socket events, the notification. That is exactly how two
code paths drift apart, and this is money. Composition inherits all of it for
free and cannot drift, because it *is* the same path.

The honest cost of (b) is in §4. It is not zero.

---

## 3. The two flows

### Flow 1 · Player initiates — unchanged

```
Player                        Admin
  Buy chips        [1 tap]
  tap ₹3,000       [1 tap]  →   appears in the needs-you band
                                 with a live countdown
                                 Approve             [1 tap]
```

Two taps for the player, one for the admin. Keep exactly as it is. This is the
flow when everyone has their phone out, and it is also the flow a player uses to
ask for something the host hasn't offered.

### Flow 2 · Admin initiates — new

**Mid-game, from the person sheet:**

```
  tap Priya at the table       [1 tap]
  Buy in                       [1 tap]
  tap ₹3,000                   [1 tap]
  ─────────────────────────────────────
  done — 3 taps, one phone
```

**During the Opening phase, from the guest list:**

```
  tap Priya                    [1 tap]
  tap ₹3,000                   [1 tap]
  ─────────────────────────────────────
  done — 2 taps
```

Two taps rather than three, because in the Opening phase buying someone in is
the *only* thing you would do to a name, so it needs no menu step. Mid-game it
is one of six things, so it does. That is
[`IA-PRESSURE-TEST.md`](IA-PRESSURE-TEST.md) §1's **demote, never delete** rule
producing a concrete tap saving rather than a slogan.

### Why there is no separate Approve tap

Your sketch had `Enter ₹3,000 → Approve → Done`. I've dropped the Approve,
because **the preset button is the confirmation**: it displays the exact amount,
and tapping a button that says `₹3,000` is an unambiguous act of committing to
₹3,000. A second screen saying "₹3,000, are you sure?" adds a tap and no
information.

**One exception.** The `Other` path opens a keypad, where the amount is being
composed rather than chosen. There, the commit is explicit and reads back the
figure:

```
        ₹  4,500
   ┌─────┬─────┬─────┐
   │  1  │  2  │  3  │
   │  4  │  5  │  6  │
   │  7  │  8  │  9  │
   │     │  0  │  ⌫  │
   └─────┴─────┴─────┘
   [   Buy Priya in for ₹4,500   ]
```

Presets commit on tap; typed amounts get a labelled commit. The distinction is
"did you *choose* a number or *build* one".

---

## 4. Four things that break, and what each does

### 4.1 The second call fails — and the failure mode is the other flow

Two HTTP calls, not one transaction. If the create succeeds and the approve
fails — dropped connection at a table with bad wifi, a 403, a race — the result
is a **pending request the admin didn't mean to create**, sitting in their own
queue.

That is a good failure. It degrades precisely into Flow 1:

```
   Couldn't complete that — Priya's ₹3,000 is
   waiting for approval in your queue instead.
```

Nothing is lost, nothing is duplicated, and the recovery is one tap the admin
already knows how to perform. **Designed for, not defended against.**

### 4.2 Every other phone flashes a request that instantly resolves

The server emits `club:buyin-requested` and then `club:buyin-decided` about
200ms apart. Every other client renders "Priya wants chips" and then removes it —
which is the teleporting-row anxiety that
[`PRODUCT-POLISH-QUALITATIVE.md`](PRODUCT-POLISH-QUALITATIVE.md) §2 identified,
now happening on six phones for something nobody was ever waiting on.

> **Rule: the needs-you band debounces insertion by ~400ms.** A request that
> resolves inside that window never renders as pending at all — it appears
> directly as a completed event: *"Rahul bought Priya in for ₹3,000."*

This is worth doing regardless of this feature: it also smooths the ordinary
case where an admin approves a request within half a second of it arriving.

### 4.3 The player already has a pending request → 409

`requestBuyIn` enforces one pending request per player
([offlineSessions.service.ts:493](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:493)).
So if Priya asked for ₹3,000 twenty seconds ago and the host — not having looked
at the queue — taps Priya and tries to bank her, they get a 409 and a dead end.

The person sheet must reflect her actual state, which is the whole point of
player-as-interaction-point. When Priya has something pending, the sheet's top
action *is* that pending thing:

```
   PRIYA
   asked for ₹3,000 · 4:12 left

   [ Approve ₹3,000 ]           ← not "Buy in"
   [ Not now ]
   ─────────────────────────
   Count out
   …
```

The collision becomes impossible to reach rather than handled after the fact.

### 4.4 The host banking themselves is still blocked, and correctly

`decideBuyInRequest` refuses self-approval when the requester is an admin who
isn't the owner and another admin exists
([offlineSessions.service.ts:544](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:544)).

Because `requestBuyIn` sets `requestedBy` to the **target** player, this rule
only ever fires on an admin buying *themselves* in — banking Priya sets
`requestedBy: Priya`, so the admin approving it is not self-approval. That is the
correct behaviour and it falls out for free.

So the fast path works for everyone at the table except the host's own rebuy,
which degrades to Flow 1 and waits for another admin. Per
[`IA-PRESSURE-TEST.md`](IA-PRESSURE-TEST.md) Revision 6, the message must name an
admin **who is still here**.

---

## 5. The same rule should govern cash-out — with one difference

`requestCashOut` takes the same optional `userId`
([offlineSessions.controller.ts:70](apps/api/src/modules/offlineSessions/offlineSessions.controller.ts:70)),
so the composition works identically. And this is where it pays most: at the end
of the night the host is already walking the table counting chips while six
people put their coats on.

**But cash-out is not symmetric with buy-in, and the interaction must not be.**

| | Buy-in | Cash-out |
|---|---|---|
| The amount is | **chosen** from round numbers | **counted** from physical chips |
| Getting it wrong | corrected by another buy-in | **locks the settlement figure** |
| Consequence | player has more chips | player leaves; seat freed |

So: buy-ins commit on a preset tap; **cash-outs always require a typed amount and
an explicit, labelled commit.** No presets, ever — a preset for a chip count
would be inviting someone to guess.

```
   MEERA — counting out

        ₹  8,200

   [    Count Meera out for ₹8,200    ]
```

Two taps plus the digits, per player, one phone. Night 5's "count six players
out" goes from a request round-trip per person to a single walk around the table.

### Sit-in stops being needed at all

`requestSitIn` takes no `userId` — it always uses the caller
([offlineSessions.controller.ts:51](apps/api/src/modules/offlineSessions/offlineSessions.controller.ts:51))
— so an admin cannot seat someone directly. It doesn't matter: **approving a
buy-in seats the player**
([offlineSessions.service.ts:557](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:557)).
The admin-initiated buy-in *is* the seating mechanism.

Sit-in survives for the case it's actually for: a player who arrives, wants to be
at the table, and isn't ready to buy chips yet.

---

## 6. The real cost — the ledger cannot tell the two flows apart

This is the one thing I'd want you to decide with your eyes open.

`BuyInRequest` stores `userId`, `amount`, `status`, `requestedBy`, `approvedBy`,
`createdAt`. `requestBuyIn` always sets `requestedBy: userId` — the target
player. There is no `initiatedBy`, and no `approvedAt`.

So a host-initiated buy-in and a player-initiated one that the host approved
produce **byte-identical records**:

```
   userId       Priya
   requestedBy  Priya      ← even when Rahul initiated it
   approvedBy   Rahul
   amount       3000
```

Six weeks later, in a dispute — *"I never asked for that ₹5,000"* — the record
says Priya asked for it. It cannot say otherwise, and no UI change can fix that,
because there is nowhere to write it.

For an app called **The House Keeps Score**, whose identity is being the ledger
of record, I think that matters more than it first appears. The mitigation is one
nullable column and one line in `requestBuyIn`:

```
   initiatedBy  String?    // set when an admin creates on someone's behalf
```

That is a backend change, so it is your call against the brief's constraint. My
recommendation: **take it.** It is the smallest possible change, it is additive
and non-breaking, it costs nothing at runtime, and it is the difference between a
ledger that can answer a question about money and one that cannot. Everything
else in this document stays inside the UX-only line.

Related, and worth noting since it's the same shape of gap: there is no
`approvedAt` either, so the audit trail cannot say how long anyone waited.

### One thing that is not recoverable

There is no un-approve. `decideBuyInRequest` goes `pending → approved | rejected`
and stops. So **a wrong amount on the fast path cannot be undone in-session** —
it is correctable only at settlement, where the buy-in figures are editable and
the server takes the submitted numbers as authoritative
([offlineSessions.service.ts:585](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:585)).

I considered an Undo window, which is the natural pattern when the actor is also
the authority, and it is what `LIVE-SESSION-IA.md` §7.3 proposed for auto-approve.
**It cannot be built** — there is no endpoint to reverse an approval, and
promising Undo and then not honouring it would be worse than not offering it.

Which is why §3's confirmation model matters: the preset button carries the
amount, and typed amounts get a labelled commit. That is the only safety net
available, so it has to be the right one.

---

## 7. Summary of what I'd build

| | Player initiates | Admin initiates |
|---|---|---|
| **Buy-in** | request → approve · unchanged | 3 taps mid-game, 2 in Opening · presets commit |
| **Cash-out** | request → confirm · unchanged | typed amount + labelled commit · no presets |
| **Sit-in** | request → approve · unchanged | not needed — the buy-in seats them |

Plus three rules the flows depend on:

1. The needs-you band **debounces insertion by ~400ms**, so a self-resolved
   request never renders as pending on anyone's phone.
2. The person sheet's top action **is whatever that player currently has
   pending**, which makes the 409 unreachable.
3. A failed second call **degrades to Flow 1** and says so plainly.

And one decision for you: **`initiatedBy`** — one nullable column, or accept a
ledger that cannot distinguish who started a buy-in.
