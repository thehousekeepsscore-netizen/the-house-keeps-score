# Engineering audit

**Date:** 2026-08-05 · **Branch:** `engineering-audit` · **Base:** `main` @ `a291cdd`
**Status:** first pass complete — not the whole brief. See §6.

---

## 0. Honest scope

The brief listed roughly thirty areas. This pass covered **authentication,
authorization, websocket lifecycle, HTTP surface, error handling, deployment
resilience, dependencies and a first accessibility sweep**, and produced four
commits with tests.

It did **not** cover, in any depth: React render performance, component
decomposition, N+1 beyond a first scan, bundle splitting, keyboard navigation,
responsive layout, animation, logging/monitoring design, or frontend test
infrastructure. Those are listed in §6 with what is already known about each.

Saying "audit complete" would be the same failure this project has hit twice
before: a claim printed rather than derived. What follows is what was actually
traced and measured.

---

## 1. Findings

### CRITICAL

**C-1 · Socket survived sign-out with the previous user's identity and rooms**
*Security · fixed in `9f913bf`*

- **Evidence.** `getSocket()` memoises one connection per document; nothing in
  the codebase called `disconnect()` — a repo-wide search returned zero hits.
  `logout` in `auth-context.tsx` is pure state (`markSignedOut`), with no page
  reload.
- **Root cause.** Socket.IO authenticates once, at the handshake, and rooms are
  server-side state keyed to that connection. Neither survives a client-side
  identity change, and neither is told about one.
- **Risk.** Two separate failures. The next user on that tab kept receiving
  events for the previous user's clubs — buy-ins, cash-outs, settlements. And
  because `socket.data.userId` still held the previous user, every later
  `club:join` was authorised as *them*, which silently defeated the membership
  check added in `f3c7101`.
- **Fix.** `resetSocket()` on any change of authenticated identity, mirroring
  `ResourceCacheProvider`'s existing identity guard.
- **Effort.** ~1h including tests.

### HIGH

**H-1 · No rate limit outside `/auth`; `/auth/refresh` unlimited**
*Security · fixed in `703d8d3`*

Settle, buy-in and approve had no ceiling. `/auth/refresh` takes a secret and
reports whether it is valid — the same shape as login — and was the one auth
route with no limit. **Two fixes were possible**: put `/refresh` on the existing
login budget of 20/15min, or give it its own. The second is superior: the first
would sign people out for using several tabs, since each tab refreshes on load
and every 15 minutes. A guesser attacking a 48-byte random token is stopped as
dead by 60 as by 20, so the stricter option bought nothing and cost real usage.

**H-2 · No graceful shutdown**
*Reliability · fixed in `83fe059`*

No `SIGTERM` handler at all. Railway signals on every redeploy. For an app that
moves money the specific risk is a settlement interrupted between its transaction
committing and its response being written — the client sees a network error for
work that succeeded, and settle is not idempotent from the user's side.
**Verified by signalling a real process with a live WebSocket attached**, which
is how the first attempt was caught failing: `io.close()` also closes the
attached HTTP server, so the following `httpServer.close()` threw
`ERR_SERVER_NOT_RUNNING` and the process exited **1** — reporting a failed
shutdown for one that had worked. Now exits **0 in 66ms**.

**H-3 · Client mistakes reported as 500**
*Reliability · fixed in `703d8d3`*

Found by writing the test for the body limit, not by reading code. An oversized
body and malformed JSON both returned `500 Internal server error`, because
`errorHandler` did not recognise body-parser errors. A client error reported as
a server fault is a retry that can never succeed and an alert nobody should get.

### MEDIUM

**M-1 · No security headers, unbounded body** *Security · fixed in `703d8d3`*
`helmet` added with `contentSecurityPolicy: false` — deliberate, since this
process serves JSON to another origin and never renders a page. Body capped at
64kb explicitly rather than relying on a library default that can change.

**M-2 · Parked Virtual Table code cannot be restored as specified**
*Maintainability · **not fixed** — see §5*
2,510 lines (`VirtualTableView`, `LazyDealerConsole`) are unreachable from the
entry point, their API routes are commented out in `app.ts`, **and they import
`lib/firebase.ts`** — the Firestore integration the app migrated away from. The
comment in `index.ts` says "restore this together with the route mounts", which
is no longer accurate: restoring would also require reinstating or replacing
Firestore.

### LOW

**L-1 · Three unused dependencies** *Maintainability · fixed in `081ed14`*
`@google/genai`, `express` and `dotenv` were dependencies of the **web**
workspace, imported by nothing in it.

**L-2 · Two icon-only buttons with no accessible name** *UX · fixed in `081ed14`*
Announced as "button" by a screen reader. Worth recording how this was found:
the first scan reported **ten** and was wrong — it stripped JSX expressions, so
every submit button labelled `{loading ? … : …}` looked empty. A scan that
over-reports is worse than none, because it trains you to skim.

---

## 2. Verified as already sound

Checked and found correct — recorded so the next audit does not redo them:

- **Timer and listener cleanup.** Every `setInterval` and `addEventListener` in
  `apps/web/src` has a matching cleanup. No leaks found.
- **Indexes.** `clubId` and `sessionId` are indexed on every large table;
  `RefreshToken.tokenHash` is `@unique`, so refresh is an index lookup.
- **No N+1 in service loops.** No `await prisma.*` inside a `for` over a result
  set.
- **Socket auth on reconnect.** `auth: (cb) => …` is the callback form, so
  Socket.IO re-reads the token on every reconnect attempt rather than reusing a
  stale one.
- **Error bodies.** No stack or internal path reaches a client; now asserted.
- **TypeScript.** `strict: true`.

---

## 3. Before / after

| | Before | After |
|---|---|---|
| API unit tests | 1,097 | 1,097 |
| Integration tests | 62 | **71** (+9) |
| Integration test files | 7 | **8** |
| Security headers | 0 | nosniff, frame-deny, no X-Powered-By |
| Rate-limited routes | `/auth/login`, `/auth/register` | all of `/api`, plus `/auth/refresh` on its own budget |
| Max request body | library default | 64kb, explicit |
| Malformed JSON | `500` | `400` |
| Oversized body | `500` | `413` |
| SIGTERM | process killed | exits 0 in 66ms, sockets drained, Prisma disconnected |
| Socket across sign-out | kept identity + rooms | connection closed |
| Unused web dependencies | 3 | 0 |
| Bundle | 649.94 kB / 186.49 kB gzip | unchanged — not addressed |

---

## 4. Remaining technical debt

| Item | Severity | Note |
|---|---|---|
| No frontend test runner | High | No jsdom or Testing Library, so the two optimistic rollbacks in `OPTIMISTIC-UPDATE-AUDIT.md` remain untested |
| Optimistic rollback discards concurrent events | Medium | Restores a snapshot taken before the request; an event arriving mid-flight is lost. Needs restore-by-id or entry versioning |
| `ClubDetailView.tsx` is 4,403 lines | Medium | Every audit of it has been slower than it should be |
| Bundle is one 650 kB chunk | Medium | No `React.lazy` anywhere |
| No structured logging or monitoring | Medium | `console.log` only; no request ids |
| Socket.IO is single-node | Medium | Rooms are in-process; a second instance needs the Redis adapter |
| `GET /clubs` has no pagination | Low | Grows with the platform |
| Modals have no `role="dialog"` | Low | 6 files with modals, 0 with the role |
| `JWT_ACCESS_SECRET` + Supabase password rotation | High | Outstanding from earlier sessions |

---

## 5. Intentionally not changed

- **The parked Virtual Table code (2,510 lines).** M-2 makes it look deletable.
  Deleting someone's parked work on the strength of an audit is not a call to
  make unilaterally — and the removal was actually attempted here and reverted
  when `LazyDealerConsole`'s Firebase import surfaced. **This needs your
  decision:** delete it, or schedule the Firestore removal that would make it
  restorable.
- **`firebase` dependency.** Kept solely because the parked code imports it.
- **Membership socket events / room split.** Held per your instruction, designed
  in `SOCKET-AUTHORIZATION-MODEL.md`.
- **`express.json` global CSP.** Omitted deliberately, not missed (M-1).

---

## 6. Recommended roadmap

**Now — finish what this pass exposed**
1. Add `jsdom` + `@testing-library/react`; test the two optimistic rollbacks.
2. Fix the rollback-versus-concurrent-event bug.
3. Decide the Virtual Table question (§5).

**Next — the areas this pass did not reach**
4. React render audit: `React.lazy` on the four largest views, memoisation
   review, context re-render tracing.
5. Decompose `ClubDetailView`.
6. Structured logging with request ids, then an error reporter.

**Then — scale**
7. Redis adapter for Socket.IO, then the room split.
8. Pagination on `GET /clubs`.
9. Rotate the outstanding secrets.

**Not yet** — keyboard navigation and a full accessibility pass deserve a
dedicated session with a screen reader, not a grep.
