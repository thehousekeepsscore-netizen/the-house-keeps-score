# ClubDetailView resource dependency map

**Date:** 2026-08-04 · **Purpose:** de-risk the remaining cache migration
**Status:** analysis only — nothing implemented from this document yet

Extracted from source at `362dbd8`. Every row was read out of the code, not recalled.

---

## 1. Two corrections to the plan

**`ClubDetailView` does not poll.** `grep -c setInterval` → **0**. It is already
fully socket-driven. The only polling in the application is
`ClubDashboardView`'s two `pollMs: 15_000` resources, and that view has **no
socket listeners at all**. So "replace polling with socket invalidation" is
dashboard work, not club work.

**`invalidate()` is the wrong primitive for a mounted screen.** `invalidate()`
marks a key stale so the *next read* revalidates; it does not fetch. A component
already on screen would show stale data until something remounted. The correct
split is:

| Situation | Primitive |
|---|---|
| Resource is on screen and an event changes it | `refresh()` — fetch now |
| Resource is **not** mounted (e.g. the club list while you are inside a club) | `invalidate()` — refetch when next visited |

Today every socket handler calls `refreshX()`, which is already correct for a
mounted view. The gain from the cache here is **not** fewer requests while
watching a live table — it is that re-entry is free and that unmounted screens
stop being refetched from scratch.

---

## 2. Resource writers

| Resource | Writers | Migrated |
|---|---|---|
| roster, history, leaderboard, potLogs, pendingChanges, auditLogs + deletedSessions | 1 each — their own `refreshX` | ✅ `362dbd8` |
| `activeSession` | 1 — `refreshActiveSession` | ❌ |
| `buyInRequests` | 2 — both inside `refreshActiveSession` (set, or cleared when no session) | ❌ |
| `club` | **5** — `refreshClub` plus four mutation results | ❌ |

The four non-refresh `setClub` writers are mutation responses at lines 327, 377,
397, 530 (remove member, promote admin, demote admin, update club). Under the
cache these become `cache.update(clubKey, () => updated)` — a write-through, not
a refetch.

---

## 3. Socket events → resources

| Event | Refreshes |
|---|---|
| `club:session-started` | activeSession |
| `club:buyin-requested` | activeSession |
| `club:buyin-decided` | activeSession |
| `club:sitin-requested` | activeSession |
| `club:sitin-decided` | activeSession |
| `club:cashout-requested` | activeSession |
| `club:cashout-decided` | activeSession |
| `club:session-settled` | activeSession, history, leaderboard, potLog, **club** |
| `club:history-updated` | history, leaderboard, auditTrail |
| `club:pending-request` | pendingChanges |
| `club:pending-request-decided` | pendingChanges, history, leaderboard, auditTrail |
| `connect` (reconnect) | **all eight** via `resync()` |

`activeSession` is the hot path: **7 of 11** events target it, and it is the
resource carrying live buy-in and cash-out requests. It is also the one whose
latency the admin feels.

---

## 4. Mutations → resources

| Mutation | Refreshes |
|---|---|
| start / end / join / sit-in / buy-in / cash-out request and decisions (9 sites) | activeSession |
| settle session (1469) | activeSession, history, leaderboard, potLog, club |
| record past night (1226) | history, leaderboard, potLog, club |
| approve pending change (1044) | history, leaderboard, potLog, club, auditTrail |
| remove member / promote / demote / update club | club (write-through) |

---

## 5. Resources that must stay synchronised

**`activeSession` ⇄ `buyInRequests`** — the hard one. `buyInRequests` is keyed by
session id and fetched inside `refreshActiveSession`, and is cleared when there
is no session. Splitting them into two independent cache keys risks a window
where the session is present and its buy-ins are stale, or vice versa. The
buy-in badge counts on the nav bar read from `buyInRequests`, so a mismatch is
visible.

Proposed handling: one resource returning `{ session, buyIns }`, so they cannot
disagree — same pattern already used for audit + deleted sessions.

**`club` ⇄ `roster`** — both currently derive from `GET /clubs/:id`, fetched
twice per entry (once by `ClubRoute` for the club, once by `refreshRoster`).
`getClubBundle` collapses them into one key, one request. Note `App.tsx` seeds
`club:<id>` with a `Club` before navigating, so the bundle's shape change must
be made in the seed at the same time or the seeded entry will be the wrong type.

**`club.clubPotBalance` ⇄ `potLogs`** — settlement moves both. Already refreshed
together everywhere; keep that pairing.

---

## 6. Where stale state could be introduced

| Risk | Mitigation |
|---|---|
| Session and buy-ins drift apart | Keep them in one resource |
| Seeded `club:<id>` has the pre-bundle shape | Change the seed in the same commit |
| Mutation write-through diverges from server truth | `cache.update` then let the normal revalidation confirm |
| A non-admin's null-keyed resource is read as "loaded and empty" | Already handled: `status === 'empty'` for a null key |
| Reconnect `resync()` refetches all eight at once | Deduplicated per key by the shared in-flight promise |

---

## 7. Proposed slice order

1. **`activeSession` + `buyInRequests`** as one resource. Highest value (7 of 11
   events), highest risk, so it goes alone.
2. **`club` + `roster`** via `getClubBundle`, including the `App.tsx` seed.
   Removes the duplicate `GET /clubs/:id`.
3. **Dashboard polling → sockets.** Requires giving `ClubDashboardView` socket
   listeners it does not currently have; only then can `pollMs` be dropped.

---

## 8. Verification plan

Production measurements, using the `__mark` / `__since` probe:

| Scenario | Before | After |
|---|---|---|
| First club entry | 9 requests | ? |
| Club re-entry within 30s | 9 → 3 after slice 1 | ? |
| Buy-in request → admin sees it | ? | ? |
| Cash-out request → admin sees it | ? | ? |
| Approval → player sees it | ? | ? |
| Dashboard polling requests / minute | 8 (2 resources × 4 ticks) | 0 target |

Latency rows need a two-device measurement — one player, one admin — timing from
action to visible update. Those cannot be derived from code.
