# Target Architecture & Evolution Plan (2–3 years)

Companion to `ARCHITECTURE.md`, which documents the system as-is. This document
proposes where it should go and in what order. **No implementation code** — the
sketches below describe shapes and boundaries only, for agreement first.

---

## 0. Two corrections to the review's premises

Both were verified against the codebase and both change a recommendation.

### The "dead code" is only dead on the client

`VirtualTableView` and `LazyDealerConsole` are unreachable from the UI, but the
**backend behind them is live and running**:

- `apps/api/src/modules/sessions/` — 1,198 lines (engine, poker hand evaluator, service, controller)
- Two routers mounted in `app.ts`: `/api/clubs/:clubId/sessions` and `/api/sessions`
- `sweepExpiredTurns()` executing **every second** in `index.ts` — a turn-timer
  sweep for a game nobody can currently open
- `PokerSession.sessionType` supports `LAZY_DEALER` and `VIRTUAL_TABLE`;
  `HandHistory` and per-socket private hole-card delivery
  (`emitToSessionPerUser`) exist to serve it

So this is not 2,500 lines of dead weight — it is ~3,700 lines of a **half-built
second product** (a real-money-free card dealer) whose frontend was unplugged.
Deleting the views strands a working backend; deleting both discards a
substantial feature. This needs a product decision, not a cleanup task. It is
Phase 5 below, and the cheapest immediate action is to stop the 1-second sweep
if the feature is parked.

### The audit trail does not cover settlement

The review assumed a shared orchestration would include `auditLog()`. It should —
because today it largely doesn't:

| Operation | writes `AuditLog`? |
|---|---|
| `settleSession` (settle a live night) | **no** |
| `createPastSession` (record a back-dated night) | **no** |
| `requestSessionChange` (edit/delete) | yes |
| `decidePendingChange` (approve/reject) | yes |
| `restoreSession` | yes |

Every operation that **creates** money is unaudited; only operations that
*modify* it are. The Audit Trail tab therefore shows edits to nights whose
original creation has no record. This alone justifies the orchestration layer,
and moves it up my priority order.

---

## 1. Requirements & Constraints

**Functional (unchanged — all existing behaviour is preserved)**
Club membership and roles · live table with sit-in/buy-in/cash-out approvals ·
settlement under configurable club rules · back-dated nights · edit/delete with
approval · append-only club pot ledger · history, leaderboard, audit trail.

**Non-functional**
- **Correctness over everything.** Real money. `sum(nets) + pot === 0` and
  table reconciliation are non-negotiable.
- Scale is small: tens of clubs, ~10 concurrent users per club. **This is not a
  scaling problem** — do not introduce infrastructure for load the app will not see.
- Latency: table actions should reflect within ~1s (already met by Socket.IO).

**Constraints that shape the design**
- **Team size ~1.** Every proposal must be landable in small independent slices.
- Socket.IO needs a **persistent process** — no serverless for the API.
- Frontend uses **relative `/api`** — production must be single-origin with a rewrite.
- **Club rules are immutable** after creation; settlement behaviour must stay
  reproducible for historical nights.
- The settlement engine is **mirrored** client/server and must stay byte-identical
  (enforced by test).
- **Test coverage exists only for the engine.** Nothing below it is covered.

---

## 2. Target Architecture

### 2.0 Two bounded contexts

The repository holds **two products**, not one product with unused code. Naming
this changes how the game engine is discussed — "used vs unused" is the wrong
axis.

```
┌─────────────────────────────────┐   ┌─────────────────────────────────┐
│   Club Management Platform      │   │      Poker Table Engine         │
│   (live, in production use)     │   │      (backend live, UI unplugged)│
├─────────────────────────────────┤   ├─────────────────────────────────┤
│  Clubs        Approvals         │   │  Dealer        Hole cards       │
│  Sessions     Leaderboard       │   │  Hands         Turn timer       │
│  Settlement   Pot               │   │  Hand history  Per-socket fanout│
│  Audit                          │   │                                 │
├─────────────────────────────────┤   ├─────────────────────────────────┤
│  money · rules · history        │   │  cards · timing · no money      │
│  Postgres, durable              │   │  engineState JSON, ephemeral    │
└─────────────────────────────────┘   └─────────────────────────────────┘
              │                                       │
              └──────────── shared ───────────────────┘
                 auth · clubs · membership · sockets
```

They share only identity and club membership. **Nothing in the table engine
touches money**, and nothing in settlement depends on cards. That is a clean
seam — which is why the third option below is viable.

The decision (Phase 5) is one of:
1. **Finish it** — build the missing frontend against the live backend.
2. **Archive it** — remove both sides behind a migration, reclaim ~3,700 lines.
3. **Split it** — move it to its own package/app sharing auth and clubs.

Until then it stays where it is. The only immediate action is stopping the
1-second turn-timer sweep, which costs nothing to keep off and nothing to
restore.

### 2.1 The central idea: one Settlement Module, three modes

The review's key observation is correct and should become the organising
principle. Today there are three flows that already share the engine, the
preview components and the settings object. Make the mode a parameter rather
than three parallel implementations.

```
                        ┌──────────────────────────────┐
                        │      Settlement Module       │
                        │   mode: live | record | edit │
                        └──────────────┬───────────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        │                              │                              │
   CLIENT (preview)              SHARED CONTRACT                 SERVER (commit)
        │                              │                              │
  useSettlementDraft          SettlementInput                  SettlementService
  ├─ player rows              { clubId, mode,                  ├─ authorize(mode)
  ├─ running tally              entries[], date?,              ├─ validate(mode)
  ├─ computeSettlement          acknowledged? }                 ├─ computeSettlement()
  ├─ SettlementPreview                                          ├─ persist(mode)
  └─ SettlementConfirm        SettlementResult                  ├─ movePot()
                              (unchanged)                       ├─ writeAudit()   ◄── new
                                                                └─ emit()
```

**Server: `SettlementService`** — one orchestration pipeline, six steps, with
mode-specific strategies plugged in:

| Step | live | record | edit |
|---|---|---|---|
| authorize | club admin | club **owner** | admin (or queue approval) |
| validate | ≥2 players, buy-in > 0, all cash-outs entered | ≥2, buy-in > 0, date ≤ today | ≥2, buy-in > 0 |
| compute | `computeSettlement` — **identical for all three** | | |
| persist | `CashOutSettlement` + close session | `HistoricalSessionRecord` | update existing record |
| pot | credit | credit | reverse old, apply new |
| audit | **currently missing** | **currently missing** | present |
| emit | `club:session-settled` | `club:history-updated` | `club:history-updated` |

Only `persist`, `authorize` and the pot delta genuinely differ. Everything else
is duplication today.

**Client: one `SettlementSheet` feature** driven by `mode`, with a per-mode
input strategy. The already-shared `SettlementPreview` / `SettlementConfirm`
stay exactly as they are — they are the proof the abstraction works.

### 2.2 Feature-module decomposition of `ClubDetailView`

The review's suggested module names don't match the real tabs. Proposed modules
follow what actually exists (6 tabs + 8 modals):

```
src/features/club/
├── ClubDetailShell.tsx          tab routing, header, bottom nav  (~150 lines)
├── session/                     the live table
│   ├── SessionTab.tsx
│   ├── TableSeats.tsx           (wraps PokerTableRing)
│   ├── BuyInSheet.tsx
│   ├── StandUpSheet.tsx
│   ├── ApprovalsPanel.tsx       pending buy-ins + cash-outs to confirm
│   └── useActiveSession.ts
├── history/
│   ├── HistoryTab.tsx
│   ├── SessionCard.tsx
│   └── useHistory.ts
├── leaderboard/  LeaderboardTab.tsx · useLeaderboard.ts
├── approvals/    PendingChangesTab.tsx · usePendingChanges.ts
├── audit/        AuditTrailTab.tsx · useAuditTrail.ts
├── pot/          PotTab.tsx · usePotLog.ts
├── members/      MembersPanel.tsx        (currently inside Club Settings modal)
├── settings/     ClubSettingsSheet.tsx
└── settlement/                  ◄── the Settlement Module (client side)
    ├── SettlementSheet.tsx      mode: live | record | edit
    ├── SettlementPreview.tsx    (exists — moves here)
    ├── SettlementConfirm.tsx    (exists — moves here)
    ├── modes/{live,record,edit}Inputs.tsx
    └── useSettlementDraft.ts    entries · calculated · confirming · preview
```

Target: no file over ~400 lines; `ClubDetailShell` under 200.

### 2.3 Data layer

Replace 8 hand-rolled refreshers and 11 socket handlers with a query cache. The
current pattern maps onto it almost exactly — **the socket already tells you
what to invalidate**:

```
socket 'club:buyin-decided'   ─► invalidate ['club', id, 'activeSession']
socket 'club:session-settled' ─► invalidate ['club', id, 'history' | 'leaderboard' | 'pot' | 'club']
socket 'club:history-updated' ─► invalidate ['club', id, 'history' | 'leaderboard' | 'audit']
```

One `useClubRealtime(clubId)` hook owns the subscription and maps events to
invalidations. Each feature module owns its own query hook. This removes the
prop-drilling that would otherwise make decomposition painful (see §3).

### 2.4 Routing

```
/                                   → redirect by auth state
/login  /onboarding
/clubs                              ClubDashboard
/clubs/:clubId                      ClubDetailShell → redirect to /session
/clubs/:clubId/session              SessionTab
/clubs/:clubId/history              HistoryTab
/clubs/:clubId/leaderboard | approvals | audit | pot
/table                              local card game (unchanged)
/oauth/callback                     replaces the manual pathname check
```

**The migration constraint to plan for:** `ClubDetailView` today receives a
whole `Club` object as a prop, so it cannot be entered from a URL. Deep-linking
requires the shell to fetch the club by `:clubId` itself. That is exactly what
the data layer provides — **which is why routing comes after it**, not before.

Modals stay component state. They are not worth routing, with one possible
exception: a settlement sheet as `?settle=<sessionId>` so a half-entered night
survives an accidental refresh. Defer that decision.

### 2.5 Domain boundaries and folder structure

The organising principle is **feature slices, not technical layers** — related
code lives together. With one adjustment forced by this repo's build setup.

**Why a single `modules/settlement/{engine,services,ui,hooks,tests}` folder
does not work here as-is:** `apps/api` and `apps/web` are separate workspaces
with separate build targets (`tsc` and `vite`). A folder holding both React
components and Prisma-backed services would either fail the API build (`.tsx`
in a `tsc` project) or, worse, let Vite follow an import from `ui/` into
`services/` and **bundle the Prisma client into the browser**. Today the
separation is clean — nothing server-only appears anywhere under `apps/web/src`.

So the slice is vertical *within each deployable*, plus a shared package for
the part that is genuinely isomorphic:

```
packages/                              ◄── new workspace (root currently ["apps/*"])
└── settlement-core/                   pure domain, no I/O, no React, no Prisma
    ├── engine.ts                      computeSettlement — ONE copy
    ├── rules.ts                       SettlementSettings, club-rule mapping
    ├── types.ts                       SettlementInput · SettlementResult
    └── engine.test.ts                 the 1,097 tests move here

apps/api/src/modules/                  server slice
├── settlement/
│   ├── settlement.service.ts          orchestration for all three modes
│   ├── settlement.controller.ts
│   ├── potLedger.ts                   extracted from clubRecords
│   ├── modes/{live,record,edit}.ts    authorize + persist strategies
│   └── settlement.service.test.ts     co-located
├── clubs/  sessions/  approvals/  audit/  leaderboard/  pot/
└── game-engine/                       renamed from sessions/ — see §2.0

apps/web/src/features/                 client slice
├── settlement/
│   ├── SettlementSheet.tsx            mode: live | record | edit
│   ├── SettlementPreview.tsx
│   ├── SettlementConfirm.tsx
│   ├── modes/{live,record,edit}Inputs.tsx
│   ├── useSettlementDraft.ts
│   └── settlement.test.tsx            co-located
├── session/  history/  leaderboard/  approvals/  audit/  pot/  members/
├── auth/  clubs/  table/
└── shared/ui · shared/api · shared/lib
```

**The payoff:** the settlement domain is one slice with its tests beside it, and
`packages/settlement-core` **removes the mirrored engine entirely**. That was
deferred earlier as "not worth the build complexity for one file" — adopting
feature slices changes the calculus, because the package now carries the engine,
its rules, its types and its test suite rather than a lone file. The lockstep
guard test then becomes unnecessary: there is nothing left to drift.

**Ordering note:** the package extraction is safe to do *with* Phase 3
(Settlement Module), not before. Moving the engine while three callers still
have divergent orchestration would mean touching money code twice.

---

## 3. Where I differ from the review's ordering

The review puts **`ClubDetailView` first**. I'd put the **data layer first or
alongside it**, for a concrete reason:

`ClubDetailView` holds 8 refresh callbacks and 11 socket subscriptions in one
closure. Split the component *first* and each of 7 new modules needs those
callbacks passed down — you replace a large file with a prop-drilling problem
and a tangle of `useEffect` dependencies, then have to unpick it again when the
data layer lands.

Introduce the query cache first and each extracted module simply calls its own
hook. The extraction becomes mechanical rather than architectural.

```
   review's order                 proposed order
   ──────────────                 ──────────────
   1. split component             1. test seams  (safety net)
   2. router                      2. data layer  (removes prop drilling)
   3. data layer                  3. split component (now mechanical)
   4. settlement service          4. settlement service
                                  5. router      (needs data layer for deep links)
                                  6. game-engine decision
```

Settlement service could move to position 2 if the **unaudited settlement** gap
is treated as urgent — it is a correctness/traceability issue, not a tidiness one.

---

## 4. Phased plan

### Phase 0 — Audit trail + test seams *(prerequisite, ~1–1.5 weeks)*

**0a. Close the settlement audit gap — the first issue to open.**
`settleSession` and `createPastSession` write an `AuditLog` entry recording who
settled what, the figures, and the pot movement. This is a production-readiness
blocker: today every operation that *creates* money is untraceable while every
operation that *modifies* it is recorded. Small, self-contained, no behaviour
change beyond the new rows.

**0b. Service-level tests** for `settleSession`, `createPastSession`,
`applySessionChange`, `restoreSession` against a test database: pot movement,
reversal/re-apply, approval routing, authorization, and the new audit rows.

*Why first:* every later phase moves money code, and today **nothing below the
engine is tested**. Three of the four bugs found in the last browser walkthrough
were inputs and wiring — precisely what these tests would catch.
**Incremental. No user-visible change.**

### Phase 1 — Data layer *(~1–2 weeks)*
Add TanStack Query. Convert the 8 refreshers to queries and the 11 socket
handlers to a single `useClubRealtime` invalidation map. `ClubDetailView` stays
one file for now.
**Incremental** — convert one refresher at a time; both mechanisms can coexist.

### Phase 2 — Decompose `ClubDetailView` *(~2–3 weeks)*
Extract tab by tab in the order: pot → audit → approvals → leaderboard →
history → session. Each is a standalone PR. Modals move with their tab.
**Incremental**, and the riskiest extraction (session) comes last, once the
pattern is proven on trivial tabs.

### Phase 3 — Settlement Module *(coordinated, ~2 weeks)*
Server orchestration first (single pipeline, close the audit gap), then collapse
the three client sheets into `SettlementSheet mode=…`.

**This is the one phase that cannot be done in slices.** The three server
functions share persistence and pot behaviour; unifying them halfway leaves two
sources of truth for the pot. Do it behind Phase 0's tests, in one change, with
the engine untouched.

### Phase 1 also carries — request ids + the settlement unique constraint
Both are small, additive and independently deployable (see §5b). Landing the
request id alongside the data layer means every later phase inherits
correlation for free.

### Phase 4 — Router *(~1 week)*
Introduce React Router, map tabs to routes, replace the `viewState` switch and
the manual OAuth pathname check. Requires the data layer (deep-link fetch).
**Mostly incremental** — the local card game can keep its own state machine
inside `/table`.

### Phase 5 — Game-engine decision *(product, not engineering)*
Choose: finish the virtual table, or retire it. Until then, stop the 1-second
`sweepExpiredTurns` interval. Retiring means removing `sessions/` (1,198 lines),
the two views (2,510), `HandHistory`, `emitToSessionPerUser`, and the
`SessionType` enum values — a migration, so it needs a decision, not a delete.

---

## 5. Trade-offs

| Decision | For | Against | Call |
|---|---|---|---|
| TanStack Query | removes ~200 lines of refresh logic; socket→invalidate is a natural fit | a dependency and a mental model to learn | **Adopt.** The invalidation mapping already exists implicitly. |
| Feature folders | scales past one big file; clear ownership | more files; some churn | **Adopt.** |
| `SettlementService` | one place for money orchestration; closes audit gap | one coordinated refactor | **Adopt**, gated on Phase 0. |
| React Router | back button, deep links, testability | migration touches every screen | **Adopt**, but last. |
| Keep the mirrored engine | preview without a round trip; lockstep enforced by test | duplication | **Keep.** It works and is guarded. |
| Server state management library (Redux etc.) | — | solves a problem this app doesn't have | **Reject.** |
| Microservices / queues / caching tier | — | no load justifies it | **Reject.** |
| `packages/settlement-core` | removes the mirror; tests live with the domain | adds a workspace and a build step | **Adopt with Phase 3.** Feature slicing changes this call — the package carries engine + rules + types + tests, not one file. |
| Vertical slice spanning api and web | maximum co-location | crosses two build targets; risks Prisma in the browser bundle | **Reject.** Slice per deployable, share the isomorphic core. |

---

## 5b. Backlog

**Correlation id on audit records.** Each audit row should carry the id of the
HTTP request that produced it, so an entry can be tied to server logs when
investigating a dispute. **Prerequisite: the API does not generate one today** —
there is no request-id middleware (`app.ts` mounts only cors, json and
cookie-parser), and every `requestId` in the codebase is a domain identifier
(pending-change, join-request), not a trace id.

So this is two small pieces, both additive and independently deployable:
1. Middleware assigning `crypto.randomUUID()` per request, honouring an
   inbound `x-request-id` if a proxy supplies one, exposed on `req`.
2. Include it in `changes.meta.requestId`. No settlement logic changes;
   `auditSchemaVersion` bumps to 2.

Worth doing before the Settlement Module phase, so the orchestration layer
carries it from the start rather than being retrofitted.

Design it as a shared trace id from the outset, not an audit-only field — the
same id should reach everything that can be correlated later:

```
        Request  (or inbound X-Request-Id from a proxy)
           │
   RequestId middleware
           │
   ┌───────┼────────┬──────────────┬─────────────────┐
   ▼       ▼        ▼              ▼                 ▼
 Logger  Audit  Socket events  Error responses  Background sweeps
```

Cheap now, and it means a future structured logger (Pino/OpenTelemetry) inherits
correlation rather than needing it threaded through afterwards. The two interval
sweeps have no request context, so they should mint their own id per run.

**Enforce "one settlement per session" in the database.** Today this is an
application invariant only: `settleSession` opens with `SELECT … FOR UPDATE` and
rejects a session whose `status !== 'active'`. That prevents the mistake; it does
not make the state impossible. Application logic prevents mistakes, constraints
prevent impossible states — a bug, a manual query or a future second code path
could still create a duplicate.

`CashOutSettlement.sessionId` currently carries no unique constraint (the model
has only `@@index([clubId])`). **Verified it would apply cleanly:** 12
settlements, 12 distinct `sessionId`s, no duplicates to clean up first.

A *plain* unique index is right here, not a partial one filtered on
`isDeleted = false`. Soft-deleting a settlement never returns its session to
`active`, so a session can never legitimately produce a second settlement — the
business rule is "at most one, ever", and the plain constraint states exactly
that. Same reasoning applies to `HistoricalSessionRecord`, which by contrast
*should* allow many rows per club and needs no such constraint.

## 6. What I'd revisit as it grows

- **A third settlement consumer** (mobile app, exports) → promote the engine to
  a shared workspace package and delete the mirror.
- **Clubs > ~100 or history > ~10k rows** → the leaderboard currently recomputes
  from every record on each request; it would need materialising.
- **More than one API instance** → `expireStaleRequests` and `sweepExpiredTurns`
  would double-fire; move to a scheduler or leader election.
- **Refresh-token table growth** — it only grows today; a cleanup job is needed
  before production regardless of any of the above.
- **Multi-currency or per-session rules** → the immutable-rules design would
  need versioned rule sets attached to each session rather than to the club.

---

## 6b. Roadmap

**The app is not deployed.** Everything below Phase 0 was written as though a
production environment existed to observe. It does not — so the next milestone
is reaching production readiness, not observing production.

```
✅ Phase 0 — COMPLETE
   architecture docs · settlement audit trail · atomicity (mutation-tested)
   · versioned audit metadata · engine test suite
        │
        ▼
   Phase A — PRODUCTION READINESS          ◄── highest priority; unlocks the rest
        │
        │  Security
        │   🔴 rotate the exposed Resend API key
        │   □ decide the fate of the stale Firebase project (see below)
        │   □ add firebase-applet-config.json to .gitignore before `git init`
        │   □ confirm all production secrets come from env vars only
        │
        │  Infrastructure
        │   □ managed Postgres · `prisma migrate deploy`
        │   □ API on a host with persistent processes (Socket.IO — not serverless)
        │   □ web as static files · domain + DNS + HTTPS
        │   □ single origin with an /api/* rewrite
        │   □ WEB_ORIGIN exactly matching · Google OAuth callback URL
        │
        │  Auth hygiene (see ADR-013)
        │   □ nightly refresh-token cleanup:
        │       DELETE WHERE expires_at < NOW()
        │          OR (revoked_at IS NOT NULL AND revoked_at < NOW() - 30 days)
        │   □ decide a per-user active-session cap (N ≈ 5–10, revoke oldest).
        │     The cleanup alone does not bound live sessions — one dev account
        │     already holds 59 valid refresh tokens.
        │
        │  Operational readiness (the part first deployments skip)
        │   □ centralised logging
        │   □ automated daily database backups
        │   □ **a restore test** — a backup you have never restored is a guess
        │   □ error monitoring (Sentry or similar)
        │   □ uptime monitoring against /api/health (already exists)
        │   □ SSL renewal (automatic on most hosts — confirm, don't assume)
        │   □ separate development and production environments
        │
        │  Release validation (walk it yourself before inviting anyone)
        │   □ create a club · play a full session · settle it
        │   □ edit it · approve a change · verify audit entries
        │   □ verify Socket.IO updates · email notifications · mobile layout
        │   □ **negative control on a production build**: remove the socket
        │     `connect` handler, confirm live updates stop, restore it.
        │     Dev has HMR, which masks the bug — see ADR-012.
        │
        │  Email — validate the app's own path, not the Resend API
        │   Order: rotate key ✅ → point DNS → verify domain in Resend →
        │   MESSAGING_ENABLED=true → then test. Confirm the startup banner
        │   reads RESEND-EMAIL, not NOOP, before believing anything sent.
        │   Drive a real settle and check each recipient's email for:
        │   □ correct recipient
        │   □ that player's own figures, correct
        │   □ **no other player's settlement anywhere in it**
        │   □ club name · session name/date · sensible subject line
        │   □ a failed send is logged clearly
        │   □ one failed recipient does not stop the others being sent
        ▼
   Phase B — FIRST PUBLIC DEPLOYMENT
        │  real club · real poker nights · observe logs, audit rows, settlements
        │  collect UX feedback from actual use
        │
        │  Treat the first nights as observation, not validation. Expect
        │  something in these documents to be proven wrong — that is the
        │  process working, not failing.
        ▼
   Phase C — UX
        │  unify Live/Record/Edit into one settlement experience · simplify
        │  cashout · reduce cognitive load · mobile · visual hierarchy
        ▼
   then, only if the product needs it:
   Phase 1   request ids · settlement unique constraint · data layer / query cache
        ▼
   Phase 2   ClubDetailView decomposition
        ▼
   Phase 3   SettlementService · packages/settlement-core
        ▼
   Phase 4   routing · deep links · browser history
        ▼
   Phase 5   game-engine product decision
```

Each phase has one objective, is independently validatable, and keeps
infrastructure work separate from business-logic change. Phase 0 is done. The
next move is **Phase A**, not Phase 1 — the architectural phases are deferred
until real usage says which of them the product actually needs.

### Capturing what happens at the table (Phase B)

At a live table the observation and the investigation are hours apart — someone
says "it didn't update" and by the time you look, it has. Write it down *there*,
not afterwards. One entry per report:

```
Time:                     (needed to line up with logs and audit rows)
Club / table:
Who noticed:              (and whether they were admin or player)
What they expected:
What they actually saw:
Did it self-correct?      (and roughly how long it took)
Screenshot:
```

Then reconcile after the session against the **audit trail**, the **pot ledger**,
**server logs**, and — once request ids exist (§5b) — the socket events for that
request. That is what turns "it felt laggy" into something with a cause.

Most of the failure modes worth catching are silent by nature: a stale table
looks identical to a current one. The timestamp is the field that makes the rest
usable.

### Disaster-recovery exercise (before first release)

The goal is not perfection — it is knowing how the system behaves under failure
*before* real players do. Each scenario, with what the code says today:

| Scenario | Expected behaviour | Status |
|---|---|---|
| Duplicate settle request | `409 Session is already settled`, no second settlement, audit stays at 1 | **verified** |
| API restarts mid-settlement | uncommitted transaction rolls back; settlement and audit die together | reasoned, untested live |
| Database drops mid-settlement | same — atomicity is the DB's guarantee | **partly verified** (forced `22003` inside the transaction) |
| User loses internet after pressing Settle | server may have committed while the client shows a network error; retrying is safe (409) | reasoned — **verify the message is understandable** |
| Browser refresh mid-settlement | **entered cash-outs are lost** — the settle draft is component state with no persistence | known gap |
| Socket disconnect mid-session | **live updates stop silently** — see below | **known bug** |

**Known bug — live updates stop after any socket reconnect.**
`club:join` is emitted once, in a `useEffect` on mount, and there is no
`connect` handler anywhere in the client. Socket.IO room membership lives on the
socket, so a reconnect produces a *new* socket in **no rooms**. After any drop —
phone backgrounding, laptop sleep, wifi blip, an API restart — the client
silently stops receiving updates. The UI looks normal and goes stale until the
component remounts or the page is refreshed.

This is the most likely failure in real use (phones background constantly). The
settlement itself stays correct because the server re-reads state at settle
time; the risk is an admin entering figures against a stale table.

Fix is small: re-emit `club:join` on `socket.on('connect')` and refetch the
active session. Worth doing in Phase A rather than after the first real night.

### Security finding from the pre-deployment scan

There is **no git history**, so nothing has been committed and no secret can
have leaked that way. `.env` is correctly ignored. One thing did turn up:

`apps/web/firebase-applet-config.json` holds a live Firebase project's client
config — `apiKey`, `appId`, `projectId`, `authDomain`, `oAuthClientId`. It is
**not** in `.gitignore`, so `git init` would commit it.

These are Firebase *web* keys, which are public by design and not equivalent to
a service-account secret — so this is not a critical leak. The real question is
different: **Firebase is entirely vestigial.** `lib/firebase.ts` is imported
only by `pdfHistorySeed.ts` (imported by nothing) and `LazyDealerConsole.tsx`
(imported by nothing), yet `firebase@^12` remains a production dependency of
the web bundle. The app moved to Postgres/Prisma.

So the risk isn't the key — it's an **abandoned Firebase project that may still
be reachable with whatever Firestore rules it had in the pre-Postgres era**.
Phase A should decide: lock the rules and delete the project, or keep it and
ignore the config file. Either way, removing the dead Firebase chain and its
dependency is a bundle-size win at no functional cost.

## 7. Agreed priorities

| Priority | Item | Phase |
|---|---|---|
| 🔴 Critical | Settlement audit trail | 0a |
| 🔴 Critical | Tests around settlement workflows | 0b |
| 🟠 High | Data layer | 1 |
| 🟠 High | Split `ClubDetailView` | 2 |
| 🟡 Medium | `SettlementService` + `settlement-core` package | 3 |
| 🟡 Medium | Routing | 4 |
| 🔵 Strategic | Future of the table engine (product decision) | 5 |

## 8. Summary

The architecture is already pointing where it should go: one engine, one
preview, one flow shape. The work is to make money movement traceable, put
tests under it, give the client a data layer so decomposition is mechanical,
finish the convergence on the server, and only then take on routing.

Sequence: **audit + tests → data layer → decompose → Settlement Module →
router → game-engine decision.**

Two products live here, not one. Keep them separate in the folder structure and
the eventual decision about the table engine becomes a choice rather than a
cleanup.

Nothing here requires a rewrite, and no business logic changes.
