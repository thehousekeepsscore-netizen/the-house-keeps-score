# Socket authorization model

**Date:** 2026-08-05 · **Status:** design only — nothing here is implemented
**Follows:** [SOCKET-EVENT-CONTRACT.md](SOCKET-EVENT-CONTRACT.md)

Requested after the membership-event design was found to break its own
authorisation rule. The conclusion there was that a single room per club cannot
carry events whose contents are not visible to everyone in the club. This is the
model that fixes that properly instead of working around it.

---

## 0. A hole that existed here — **fixed in `f3c7101`**

`apps/api/src/realtime/socket.ts`:

```js
socket.on('club:join', (clubId: string) => {
  if (typeof clubId === 'string') socket.join(`club:${clubId}`);
});
```

The handshake authenticates the user. **Joining a room checks nothing else.**
Any authenticated user — any account on the platform, not merely any club member
— can emit `club:join` with any club id and receive that club's entire live
event stream: who is at the table, every buy-in amount, every cash-out, every
settlement.

This is not hypothetical and it is not created by the work below. It is the
current state. `session:join` has the same shape and the same gap.

**Fixed in `f3c7101`, on its own and ahead of the room split.** Joining now
requires owner, admin or member; membership is queried rather than read off the
token, so a removed player is refused immediately instead of when their token
expires. Nine integration tests cover it. Every design below assumes this.

---

## 1. Rooms

Three rooms per club, nested by privilege. A user joins every room their role
entitles them to, so an owner is in all three.

| Room | Who joins | Contains |
|---|---|---|
| `club:{id}:members` | Every club member, including admins and the owner | Everyone in the club |
| `club:{id}:admins` | Club admins + the owner + super-admins | Strict subset of members |
| `club:{id}:owner` | The owner + super-admins | Strict subset of admins |

Membership is derived **on the server at join time** from the authenticated
`socket.data.userId`, never from anything the client sends beyond the club id.
The client asks to join a *club*; the server decides which of the three rooms
that user is entitled to and joins them to those. A client cannot request
`club:x:admins` directly, because then the request would be the authority.

**Re-evaluation on role change.** Rooms are decided at join time, so demoting an
admin does not eject their socket. Either the demotion forces those sockets to
re-evaluate, or a demoted admin keeps receiving admin events until they
reconnect. This must be handled explicitly; it is the sharp edge of the design.

**Why not one room per user.** It would be simpler to authorise and impossible
to leak from, but it turns one broadcast into N sends and gives up the thing
rooms are for. `emitToSessionPerUser` already does exactly that for hole cards,
where per-recipient filtering is unavoidable. Reserve it for that.

---

## 2. Which room each event goes to

Derived from who is allowed to *read* the same data over REST. The rule: **an
event may go to a room only if every member of that room could have fetched its
contents themselves.**

### Existing events — all currently sent to the single `club:{id}` room

| Event | Destination | Why |
|---|---|---|
| `club:session-started` | members | Everyone at the club sees the table |
| `club:buyin-requested` | members | Buy-ins are visible at the table |
| `club:buyin-decided` | members | Same |
| `club:sitin-requested` | members | Seat state is public within the club |
| `club:sitin-decided` | members | Same |
| `club:cashout-requested` | members | Same |
| `club:cashout-decided` | members | Same |
| `club:session-settled` | members | Already contentless; recipients refetch what they may see |
| `club:history-updated` | members | Already contentless |
| `club:pending-request` | **admins** | Change requests are an admin queue |
| `club:pending-request-decided` | **admins** | Same |

Nine of eleven are unchanged in destination. The two pending-change events are
being **narrowed** — today they reach every member, which is a smaller version
of the same leak that stopped the membership work.

### New membership events

| Event | Destination | Payload |
|---|---|---|
| `club:join-requested` | **admins** | `{request}` — safe here, and only here: an admin may already read the requester's email over REST |
| `club:join-decided` | **admins** | `{request}` |
| `club:member-changed` | members | `{clubId}` only — the roster is visible to members, but the *reason* (promoted, demoted, removed) is not something to broadcast about a named person |

With an admins room, the payload for join requests can be the full row after
all. That is the point of doing this properly rather than settling for the
contentless compromise: the compromise costs every admin a GET, and this does
not.

### Audit trail and leaderboard

Still never pushed. The audit trail is owner-scoped, which the owner room would
cover — but the leaderboard is gated by `leaderboardVisibleToPlayers`, a
**per-club setting that can change**, and a room split cannot express a
condition that is re-evaluated per event. Invalidation remains correct for both.

---

## 3. Migration strategy

The constraint is that a client and a server are deployed separately and will
run mismatched for some window. Both directions must work.

**Dual-write, then dual-read, then cut over.** For one release the server emits
to *both* the old `club:{id}` room and the new rooms, and joins clients to both.
Old clients keep receiving on the old room; new clients receive on the new ones.
Nothing breaks in either direction, and the change is revertible by deploying
the previous server.

The exception is the two pending-change events, which are being narrowed. Those
cannot be dual-written, because dual-writing preserves exactly the leak the
change exists to close. They move directly, accepting that an old client which
is a non-admin member stops receiving events it should never have had.

---

## 4. Rollout order

Each step is independently deployable and independently revertible.

1. **Membership check on `club:join` and `session:join`.** Fixes §0. No room
   changes, no client changes. Ship this first and separately — it is the actual
   vulnerability, and it should not wait behind an architecture.
2. **Server-side room derivation.** `club:join` starts also joining the caller
   to `:members` / `:admins` / `:owner` per their role, while keeping them in
   the flat room. Nothing emits to the new rooms yet. No client change.
3. **Role-change re-evaluation.** Promotion, demotion and removal move the
   affected user's live sockets between rooms. Must land before anything
   sensitive is emitted to `:admins`, or a demoted admin keeps listening.
4. **Dual-write the nine unchanged events** to both the flat room and
   `:members`. Both work; verify with the two clients.
5. **Move the pending-change events to `:admins`.** Not dual-written — see §3.
6. **Add the three membership events**, emitted only to the new rooms. This is
   the work that was held, now safe to do.
7. **Drop the flat `club:{id}` room** once no deployed client depends on it.

Steps 1–3 are server-only. The first client change is at step 4.

---

## 5. What this does not solve

- **Socket.IO is single-node.** Rooms live in one process's memory; a second API
  instance would not see them. A Redis adapter is a prerequisite for scaling
  out, and was already deferred.
- **Room membership is a snapshot.** Step 3 mitigates the common case; a
  determined client that reconnects during a role change may still land in a
  room it briefly qualified for.

- **The REST endpoints are not a backstop.** ⚠️ An earlier draft of this
  document said "authorisation on the read endpoints remains the real boundary —
  sockets are an optimisation, never the only gate." **That was wrong**, and
  closing the socket hole is what proved it. There is no membership check
  anywhere in the REST layer either:

  - `GET /clubs/:clubId` and `GET /clubs/:clubId/offline-sessions/active` are
    gated by `authenticate` and nothing else. Any authenticated user can read
    any club's settings and its live table.
  - Worse, `clubInclude` in `clubs.service.ts` selects `email` for every admin,
    member and owner, and `listClubs()` applies it to **every club with no
    filter**. `GET /api/clubs` returns every member's email address on the
    platform to any authenticated caller.

  This is not created by the socket work and is not fixed by it. It is a
  separate piece of work, and it is larger than it looks: the browse feature
  depends on non-members reading club records, so the fix is to trim what the
  payload exposes and gate the private parts — not simply to add a membership
  check to the route.
