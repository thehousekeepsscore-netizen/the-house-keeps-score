# Socket event contract

**Date:** 2026-08-05 · **Status:** design, agreed before implementation
**Follows:** [CLUB-RESOURCE-MAP.md](CLUB-RESOURCE-MAP.md)

Governing principle, as agreed:

> No mutation should require a refetch unless the backend cannot deterministically
> compute the new state.

---

## 1. Two constraints that shape every row below

**Authorisation limits what an event may carry.** Leaderboard visibility is
owner-toggleable (`leaderboardVisibleToPlayers`), and the audit trail is
owner/super-admin only. A socket event is broadcast to the whole club room, so
pushing leaderboard rows or audit entries would hand them to players the club has
deliberately excluded. **Any resource with per-recipient visibility must be
invalidated, never pushed.** This is the main reason some rows below say
"invalidate" rather than "patch", and it is a correctness rule, not a shortcut.

**Some state genuinely cannot be reconstructed client-side.** Settlement
recomputes leaderboard aggregates across the club's entire history and moves the
pot ledger. A client holding one session cannot derive the result. Invalidation
is the correct answer there, and the principle above explicitly allows it.

**`clubs.service.ts` currently emits nothing.** Join requests, approvals,
promotions, demotions and removals produce no events at all — the dashboard's 15s
poll is the only path. Those events have to be created, not upgraded.

---

## 2. The contract

`Update` column: **append** · **patch** (replace one item in a list) ·
**replace** (whole resource) · **remove** · **invalidate** (mark stale, refetch on
next read).

### Live table — `club:{id}:active-session` holds `{ session, buyIns }`

| Event | Current payload | Proposed payload | Update | GETs removed | Optimistic? | Rollback |
|---|---|---|---|---|---|---|
| `club:buyin-requested` | `{sessionId, requestId}` | `{sessionId, request}` | append to `buyIns` | active-session, buy-in-requests | **Yes** — insert a pending row on submit | Remove the temp row, restore the modal, toast the server's message |
| `club:buyin-decided` | `{sessionId, requestId, approve, expired?}` | `{sessionId, request}` (the updated row) | patch `buyIns` by id | active-session, buy-in-requests | **Yes** for the deciding admin | Restore previous status |
| `club:sitin-requested` | `{sessionId, userId}` | `{sessionId, session}` | replace `session` | active-session | No — server owns seat order | n/a |
| `club:sitin-decided` | `{sessionId, userId, approved, expired?}` | `{sessionId, session}` | replace `session` | active-session | No | n/a |
| `club:cashout-requested` | `{sessionId, userId, amount}` | `{sessionId, session}` | replace `session` | active-session | No — amount is validated server-side | n/a |
| `club:cashout-decided` | `{sessionId, userId, approved, expired?}` | `{sessionId, session}` | replace `session` | active-session | No | n/a |
| `club:session-started` | `{sessionId, sessionType}` | `{session}` | replace `session`, clear `buyIns` | active-session | No | n/a |

Seat state lives in `engineState`, a single JSON blob the server rewrites
atomically. Sending the whole session is both simpler and safer than sending a
diff the client must apply in the right order.

### Settlement and history — deliberately invalidate

| Event | Current payload | Proposed | Update | Why not push |
|---|---|---|---|---|
| `club:session-settled` | `{sessionId}` | `{sessionId}` unchanged | invalidate `active-session`, `history`, `leaderboard`, `pot-log`, `club` | Leaderboard is recomputed across all history and is visibility-gated; pot balance moves. Not reconstructible, and not safe to broadcast |
| `club:history-updated` | `{recordId}` | unchanged | invalidate `history`, `leaderboard`, `audit` | Same: edits re-settle and shift lifetime standings |

### Pending change requests — `club:{id}:pending-changes`

| Event | Current payload | Proposed payload | Update | GETs removed | Optimistic? |
|---|---|---|---|---|---|
| `club:pending-request` | `{requestId}` | `{request}` | append | pending-changes | Yes |
| `club:pending-request-decided` | `{requestId, approve}` | `{request}` + invalidate history/leaderboard/pot | patch, then invalidate the rest | pending-changes | Yes for the row; the money resources still refetch |

### Club membership — **new events, none exist today**

> **Corrected 2026-08-05, before implementing.** The table below originally
> proposed pushing `{request}` and `{member}` into the club room. That breaks §1
> of this document. `listRelevantJoinRequests` restricts join requests to club
> admins, the owner and the requester, and the row it returns **includes the
> requester's email address** — a person who is not yet a member of the club.
> A socket event goes to the whole club room, so pushing the row would hand a
> stranger's email to every ordinary member. Contentless events, below.

| Event | Payload | Update | GETs removed | Optimistic? |
|---|---|---|---|---|
| `club:join-requested` *(new)* | `{clubId}` — **no row** | admins invalidate `clubs:join-requests` | replaces the 15s poll | n/a |
| `club:join-decided` *(new)* | `{clubId}` — **no row** | admins invalidate `clubs:join-requests`; invalidate `clubs` | replaces the 15s poll | **Yes, locally** — already shipped in `3ba8cb7`: the deciding admin removes the row without waiting for anything |
| `club:member-changed` *(new)* | `{clubId}` — **no member** | invalidate `clubs`, roster | roster poll | Yes, locally |

The cost of going contentless is one GET *for admins only*, replacing a poll
that currently runs every 15 seconds for everyone whether or not anything
changed. The optimistic local write is what makes the acting admin's screen
instant; the event exists to make *other* admins' screens converge in under a
second instead of up to fifteen.

Even a bare `{clubId}` tells every member of the room that something about
membership changed. That is a far smaller signal than an identity, and members
can already see the roster, but it is the reason this needs a decision rather
than a default: the alternative is an admins-only room, which does not exist
today and is the larger piece of work.

---

## 3. What this eliminates

Measured today, from the production probe:

```
entering a club        9 requests
approving a join       3 requests  (POST + clubs + join-requests)
requesting a buy-in    1 request   (already fixed in 9617124, was 3)
approving a buy-in     3 requests  (POST + active-session + buy-in-requests)
```

After this contract:

```
approving a join       1 request
approving a buy-in     1 request
sit-in / cash-out      1 request
settling a session     1 request + 5 invalidations (refetched only if still on screen)
```

Entering a club is unchanged at 9 — that is a cold cache, not a mutation. It is
addressed by the cache migration, not by this contract.

---

## 4. Optimistic UI and rollback

Applied only where the client can predict the server's answer:

- **Yes**: buy-in request (append pending row), join approve/reject (remove row),
  pending-change decide (patch status), member removal.
- **No**: anything the server computes — settlement figures, seat ordering,
  cash-out validation, the buy-in ceiling.

Rollback is uniform: `cache.update` back to the previous value, captured before
the optimistic write, then surface the server's message. The write-through
already committed in `9617124` is *not* optimistic — it applies after
confirmation — and stays as it is.

---

## 5. Versioning and risk

Payloads are **additive**: existing fields stay, new ones are added alongside. A
client running older code keeps working, because it ignores the new field and its
existing handler still refetches. That makes every step below independently
deployable and reversible without coordinating a frontend and backend release.

| Risk | Mitigation |
|---|---|
| Event carries data a recipient may not see | Visibility-gated resources are invalidated, never pushed (§1) |
| Client applies events out of order | Session events replace wholesale; list events are keyed by id, so a repeat is idempotent |
| Optimistic row diverges from server truth | Server row replaces the temp row on the event; revalidation reconciles |
| Old clients after deploy | Additive payloads; old handlers still refetch |

---

## 6. Implementation order

1. **Backend payloads** — enrich the seven existing offline-session events. No
   frontend change; old handlers keep refetching.
2. **Frontend handlers** — switch to `cache.update`, drop the refetches.
3. **New membership events** — emit from `clubs.service.ts`, handle in the
   dashboard. This is what lets the dashboard poll be dropped.
4. **Optimistic writes** — the four cases marked Yes, with rollback.
5. **Measure** via `/debug/performance`: write-throughs should rise, refreshes
   and network requests should fall, hit rate should rise.
