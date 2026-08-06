# Stage 1 — dependency map and slice plan

**Date:** 2026-08-06 · **Branch:** `product-polish` · **Status:** analysis only, no code
**Implements:** [`PRODUCT-BRIEF.md`](PRODUCT-BRIEF.md) §13, §9, §10, §11 · [`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md) Stage 1

Every row was read out of the code at `5ce45fa`, not recalled.

**Stage 1 scope, as defined:** audit fields · truthful ledger · admin buy-in ·
notification wording · activity timeline · cash-out preservation.

---

## 1. Three findings that change the plan before it starts

### 1.1 The audit needs **one** new column, not two

`PRODUCT-BRIEF` §13 says "minimum change: `initiatedBy` and `approvedAt`". That
over-buys. `BuyInRequest` already has a field for the initiator — it is simply
**written wrong**:

| Question | Field | State |
|---|---|---|
| Requested **For** | `userId` | ✅ correct |
| Requested **By** | `requestedBy` | ⚠️ exists, currently written as the *target* |
| Approved **By** | `approvedBy` | ✅ correct |
| Approved **At** | — | ❌ missing |

So: **`approvedAt` is the only new column.** No `initiatedBy`. Correcting
`requestedBy` to name the true caller makes the existing column mean what its
name says, and the four questions are answerable.

Cash-outs need no migration at all — they live in `PokerSession.engineState`
JSON, so `requestedBy` and `confirmedAt` are a shape change, not a schema change.

### 1.2 The second `requestedBy` copy is **dead code**

`IMPLEMENTATION-PLAN` Stage 1a says `sessions.service.ts:395` must change "in
lockstep or the two copies drift". It cannot drift, because the router is
commented out — [app.ts:10](apps/api/src/app.ts:10) and
[app.ts:108](apps/api/src/app.ts:108):

```
// import { clubSessionsRouter, sessionsRouter } from "./modules/sessions/sessions.routes.js";
// app.use("/api/sessions", sessionsRouter);
```

The virtual-table module is unreachable — consistent with
[`NAVIGATION-AUDIT.md`](NAVIGATION-AUDIT.md) §4 finding its screens unreachable
too. This lowers 1a's risk. It is a consistency edit, not a money path, and it
should not share a commit with the live one.

### 1.3 The notification wording has an **external dependency**

This is the one with lead time, and it is not a code problem.

`notifyBuyInApproved` sends over `['sms', 'whatsapp']`
([notifications.service.ts:118](apps/api/src/modules/notifications/notifications.service.ts:118)),
and the WhatsApp path uses a **Meta-preapproved template**
([messageTemplates.ts:92](apps/api/src/lib/messageTemplates.ts:92)):

```
Name: buy_in_approved
Body: Hi {{1}}, your buy-in of {{2}} has been approved at {{3}}.
```

Changing the wording for admin-initiated buy-ins means **registering a new
template and waiting for Meta's approval**. Email and SMS bodies are free to
change; WhatsApp is not.

`MESSAGING_CHANNEL` defaults to `email`
([env.ts:46](apps/api/src/env.ts:46)) and buy-in approvals exclude email — so on
the default configuration **this notification sends nothing at all**. I cannot
read production's value from here. **I need you to tell me what
`MESSAGING_CHANNEL` is set to in production**, because it decides whether this
item is a one-line change, a no-op, or a two-week wait.

---

## 2. Full surface inventory

### Database

| Table / field | Change | Migration? |
|---|---|---|
| `BuyInRequest.approvedAt` | **new**, `DateTime?` | ✅ yes |
| `BuyInRequest.requestedBy` | **meaning corrected** — no schema change | no |
| `Club.defaultBuyIn` | **new**, `Int?` | ✅ yes |
| `PokerSession.engineState.cashOuts[]` | `+requestedBy`, `+confirmedAt`, `status` gains `'voided'` | ❌ JSON |
| `CashOutSettlement`, `ClubPotLog`, `AuditLog` | **untouched** | — |

Both migrations are **additive and nullable** — old code ignores new columns, so
migrate-then-deploy is safe in either order.

### API endpoints

| Endpoint | Stage 1 change |
|---|---|
| `POST /clubs/:clubId/offline-sessions/:sessionId/buy-in-requests` | writes true `requestedBy` |
| `POST …/buy-in-requests/:requestId/:decision` | writes `approvedAt`; **predicate moves** |
| `GET  …/buy-in-requests` | returns two new fields |
| `POST …/cash-out-requests` | writes `requestedBy`; 409 guard must ignore `voided` |
| `POST …/cash-out-requests/:decision` | writes `confirmedAt` |
| `POST …/settle` | **reads** `cashOuts` — must keep filtering `confirmed` |
| `PATCH /clubs/:id` | accepts `defaultBuyIn` |

### Socket events

All four carry payloads that gain fields. Every client spreads rather than
destructures exhaustively, so these are additive and safe — but they are the
mechanism by which a shape change reaches other phones mid-session.

`club:buyin-requested` · `club:buyin-decided` · `club:cashout-requested` ·
`club:cashout-decided`

### Cache resources

| Key | Effect |
|---|---|
| `club:<id>:active-session` → `{ session, buyIns }` | **both halves change shape.** 7 of 11 socket events target it ([`CLUB-RESOURCE-MAP.md`](CLUB-RESOURCE-MAP.md) §3) — the hot path |
| `club:<id>` | gains `defaultBuyIn` |

### Frontend

| File | Change |
|---|---|
| `lib/offlineSessions-api.ts` | wire types for both shapes |
| `types.ts` | `BuyInRequest`, `PokerSession.cashOuts`, `Club` |
| `ClubDetailView.tsx:1804` | **the client mirror of the moved predicate** |
| `ClubDetailView.tsx:2364, 2653, 2719` | three more `requestedBy === currentUser.uid` reads |
| `components/session/ActionQueue.tsx` | `blockedReason` wording |
| new — activity timeline | reads existing data |

⚠️ **Four client-side reads of `requestedBy` change meaning simultaneously.**
Today `requestedBy === currentUser.uid` means "this is my own buy-in". After the
correction it means "I created this request", which for an admin includes ones
they created *for other people*. All four need reviewing together, and three of
them are in the settle/history modals rather than the live screen.

---

## 3. Grouped as requested

### UI only — no server, no schema

- **Activity timeline** (§11). Derivable today: `listBuyInRequests` returns *all*
  requests including rejected, with `createdAt`, and `engineState.cashOuts`
  carries `requestedAt`. Only the *voided cash-out* event needs new data.
- **`blockedReason` wording** naming a present admin (§6.3).

### Frontend + backend — no schema

- **Cash-out provenance and preservation.** JSON shape only.
- **Admin-initiated buy-in** (§9.2) — composes two existing endpoints. No new
  endpoint, deliberately: composition inherits the ceiling check, the
  one-pending rule, seating, sockets and the notification, and cannot drift.

### Database migration required

- **`BuyInRequest.approvedAt`** — one nullable column.
- **`Club.defaultBuyIn`** — one nullable column.

### High-risk money logic

- **The `requestedBy` correction + predicate move.** Permission-adjacent: split
  it and every admin-initiated buy-in 403s, or the fix is a silent no-op.
- **Cash-out `voided` status.** [settleSession:612](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:612)
  reads `cashOuts` to decide settlement figures. A voided entry leaking through
  would corrupt a night's numbers.
- **The 409 guard at [:414](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:414)** —
  misses a status check today; once `voided` exists, a returning player could
  never cash out again.

---

## 4. Proposed sequence — six PRs

Ordered so that every money-touching change ships alone, and nothing that
changes behaviour ships before the data it depends on.

| # | PR | Group | Risk | Depends on |
|---|---|---|---|---|
| **1** | Buy-in provenance + predicate move | migration · money | **High** | — |
| **2** | Cash-out provenance + preservation | backend · money | **High** | — |
| **3** | Dead virtual-table copy | consistency | None | — |
| **4** | Club default buy-in | migration · FE+BE | Low | — |
| **5** | Admin-initiated buy-in | FE+BE | Medium | 1, (4) |
| **6** | Activity timeline | UI only | Low | 2 |
| **7** | Notification wording | backend | Low | 1, **Meta** |

Seven, not six — the dead-code edit separates out because it must not share a
commit with the live money path.

### PR 1 — Buy-in provenance · *the one that must not be split*

One commit: migration for `approvedAt`, `requestedBy` corrected at
[:502](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:502),
predicate moved at
[:544](apps/api/src/modules/offlineSessions/offlineSessions.service.ts:544),
client mirror at [ClubDetailView:1804](apps/web/src/components/ClubDetailView.tsx:1804),
and the three other client reads reviewed.

Test matrix — five rows, and the fourth is the one that fails if the commit is split:

| Approver | Buy-in for | Other admins | Expect |
|---|---|---|---|
| Owner | themselves | yes | allow |
| Non-owner admin | themselves | yes | **403** |
| Non-owner admin | themselves | no | allow |
| Non-owner admin | **another player** | yes | **allow** |
| Admin | another, player-initiated | yes | allow |

### PR 2 — Cash-out provenance · *ships alone, next to settlement*

`clearCashOutFor` marks `voided` instead of deleting; `:414` gains a status
filter; `:612` proven to still ignore anything not `confirmed`. Must tolerate
**existing rows written without the new fields** — there are live sessions in
production whose `cashOuts` predate this.

### PRs 3–4 — low risk, any order

### PR 5 — Admin-initiated buy-in

The first user-visible behaviour change of Stage 1. Blocked on PR 1: without the
predicate move it 403s for every admin who is not the owner.

### PR 6 — Activity timeline

Blocked on PR 2 only for the rejoin event ("her ₹8,200 count no longer
applies"). Could ship earlier without it, but that event is the reason
[`PRODUCT-BRIEF`](PRODUCT-BRIEF.md) §10.1 exists.

### PR 7 — Notification wording

Blocked on PR 1 for the signal (`requestedBy !== userId` ⇒ admin-initiated) and
possibly on **Meta**, per §1.3.

---

## 5. Deploy ordering

Both migrations are additive and nullable, so there is no destructive step and
no backfill. Recommended per migration-bearing PR:

1. `prisma migrate deploy` against Railway **first** — old code ignores new columns.
2. Then the application deploy.
3. Rollback is a code revert; the columns stay and stay unread.

The one ordering that is *not* safe is deploying code that **writes** `voided`
before every reader tolerates it — which is why PR 2's reader changes and writer
change are one commit.

---

## 6. What I need from you before PR 1

1. **`MESSAGING_CHANNEL` in production** — decides whether PR 7 is a one-liner, a
   no-op, or gated on Meta approval.
2. **The dead virtual-table module** — correct it for consistency (PR 3), or
   delete it? It is ~460 lines behind a commented-out router.
3. **Confirmation that `prisma migrate deploy` against Railway is mine to run**,
   or whether you run migrations yourself.

Nothing else blocks. PR 1 is fully specified.
