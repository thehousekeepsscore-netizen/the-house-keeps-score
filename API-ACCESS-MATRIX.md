# API access matrix

**Date:** 2026-08-05 · **Status:** implemented and tested
**Enforced by:** `apps/api/src/modules/clubs/nonMemberExposure.integration.test.ts`
**Related:** [SOCKET-AUTHORIZATION-MODEL.md](SOCKET-AUTHORIZATION-MODEL.md)

---

## 1. The four levels

| Level | Who | Established by |
|---|---|---|
| **Authenticated** | Any signed-in account | `authenticate` middleware |
| **Member** | Owner, admin or member of that club | `assertClubMember` |
| **Admin** | Club admins + owner + super-admins | `assertClubAdmin` |
| **Owner** | Owner + super-admins | `assertClubOwner` |

Each level contains the ones below it. Super-admins pass every club check.

**The bug this fixes was structural, not a missed line.** Admin and owner
checks existed from the beginning, so anything gated on them was safe. But
`assertClubMember` did not exist at all, so every endpoint that was not
admin-gated fell straight through to *authenticated* — a level that every
account on the platform satisfies. The missing rung was the whole problem.

---

## 2. Clubs

| Endpoint | Level | Notes |
|---|---|---|
| `GET /clubs` | Authenticated | **Two projections.** Clubs you belong to come back whole; everything else is reduced. This is the only endpoint a non-member may read. |
| `POST /clubs` | Authenticated | Anyone may create a club |
| `GET /clubs/:id` | **Member** | Browsing uses the list; nothing outside the club needs one club's full record |
| `PATCH /clubs/:id` | Owner | |
| `DELETE /clubs/:id` | Owner | |
| `POST /clubs/:id/superuser-join` | Super-admin | |
| `POST /clubs/:id/join-requests` | Authenticated | By definition — the caller is not yet a member |
| `GET /clubs/join-requests` | Authenticated | Scoped: your own requests, plus those for clubs you administer |
| `POST /clubs/:id/join-requests/:rid/:decision` | Owner | |
| `POST /clubs/:id/admins` · `DELETE .../admins/:uid` | Owner | |
| `DELETE /clubs/:id/members/:uid` | Admin | |

### The two projections

| Field | Public | Member |
|---|---|---|
| `id`, `name`, `code`, `description`, `maxCapacity`, `createdAt` | ✅ | ✅ |
| `memberCount`, `adminCount` | ✅ | ✅ |
| `isMember`, `isAdmin`, `isOwner` | ✅ (all false) | ✅ |
| `members`, `admins`, `owner` — **the roster, and every email in it** | ❌ | ✅ |
| `ownerId` | ❌ | ✅ |
| `clubPotBalance` | ❌ | ✅ |
| rake, mismatch, winner, rounding, devaluation, buy-in settings | ❌ | ✅ |
| `leaderboardVisibleToPlayers` | ❌ | ✅ |

**The public projection is an allowlist.** Building it by deleting sensitive
keys from the full record fails open — and failing open is precisely how every
member's email reached `GET /clubs`. A field added to the club model tomorrow is
private until someone chooses to publish it.

`code` is public because it is a display label. Nothing joins a club by code;
joining is always request-and-approval. If a join-by-code flow is ever added,
`code` must move out of the public projection in the same change.

`memberCount` and `adminCount` exist so the browse card can render "12/20
members" without the roster. The client previously derived those from
`memberUids.length`, which is why it needed a roster to draw a number.

---

## 3. Live sessions — `/clubs/:clubId/offline-sessions`

| Endpoint | Level |
|---|---|
| `GET /active` | **Member** |
| `GET /:sid/buy-in-requests` | **Member** |
| `POST /` (start session) | Admin |
| `POST /:sid/join` · `/sit-in-requests` · `/cash-out-requests` · `/buy-in-requests` | **Member** |
| `POST /:sid/*-requests/:decision` (approve/reject) | Admin |
| `POST /:sid/settle` | Admin |

The self-service writes needed the check as much as the reads did: without it a
stranger could request a seat at a club's table.

---

## 4. Club records — `/clubs/:clubId`

| Endpoint | Level | Notes |
|---|---|---|
| `GET /history` | **Member** | Admins additionally see soft-deleted records |
| `GET /leaderboard` | **Member** | Then gated again by `leaderboardVisibleToPlayers` for non-admins |
| `GET /pot-log` | Admin | |
| `GET /pending-changes` · `POST /pending-changes` | Admin | |
| `POST /history/past-session` | Owner | |
| `POST /history/link` | Admin | |
| `GET /deleted-sessions` · `POST /deleted-sessions/:id/restore` | Owner | |
| `GET /audit-log` | Owner | |

History and leaderboard were the subtle pair. Every other record endpoint
*asserts* admin, which incidentally excluded non-members. These two *branch* on
admin — admins see more, players see less — so a stranger fell through to the
player view and read the club's results. `leaderboardVisibleToPlayers` did not
save it: that flag distinguishes players from admins, and was never asked to
decide whether someone outside the club should see anything.

---

## 5. Rules for adding an endpoint

1. **Name the level first.** If it is not Authenticated, call the matching
   `assert*` helper. Passing `userId` into a service is not a check.
2. **Branching on a role is not asserting one.** `isClubAdmin(...)` decides how
   much to show; it never decides whether to show anything.
3. **Add to an allowlist, never subtract from a record.** Any new projection
   follows `serializeClubPublic`.
4. **Prove it with a request, not a reading.** Add a case to
   `nonMemberExposure.integration.test.ts`, which drives real HTTP as an
   authenticated account with no relationship to the club.

---

## 6. Known gaps

- **`GET /clubs` still returns every club on the platform.** That is browse
  working as intended, and no private field goes with it — but there is no
  pagination, so the response grows with the platform.
- **`sessions.routes.ts` is unaudited** because it is not mounted
  (`app.ts:62`, commented out). If the virtual table is ever enabled, it needs
  this treatment first — it has no membership checks at all.
- **Emails are still the display fallback** for members with no display name, so
  the member projection necessarily carries them. Members can already see each
  other, so this is in scope; it is noted because it means the roster can never
  become a fully public shape.
