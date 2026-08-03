# Architecture Decision Records

## Principle 0 — Verify the accepted truth

Before changing an important system, identify what everyone already believes
about it and check whether it is true. The expensive mistakes in this project
were not made against unknowns; they were made against statements that sounded
correct and had never been run.

```
   Assumption → Verification → Evidence → Decision
   (not:  Assumption → Decision)
```

Every entry below that carries a **Previous assumption** exists because a
believed-true statement turned out to be false:

| Accepted belief | Reality after checking | Outcome |
|---|---|---|
| Those views were dead code | An unplugged second product with a live backend and a 1s scheduler | Roadmap changed |
| `sum(nets) + pot == 0` proved correctness | It stays balanced on invalid inputs | Testing priorities changed |
| The atomicity test proved rollback safety | It could not detect the failure it claimed | Implementation *and* test changed |
| Socket.IO reconnect restores room membership | Reconnect creates a new socket with no rooms | Real user-facing bug fixed pre-launch |
| A unique constraint would need data cleanup | Existing data already satisfied it | Migration plan simplified |
| Pot disabled just hides the pot | Players were still charged; the money vanished | Guard added at club creation |

None of these needed insight. They needed running one command instead of
trusting one sentence.

## Principle 1 — Preserve the evidence

When something unexpected happens, capture enough to explain it *before* you
tidy it away. Don't clean up, overwrite, or restart until you have looked.

The largest findings here came from not moving on too quickly:

- The mutation test **passed**, and the useful question was *why* it passed —
  not "green, next".
- The reconnect behaviour was traced through the socket lifecycle rather than
  assumed to work because Socket.IO "handles reconnection".
- The pot imbalance was not patched where it surfaced; the underlying invariant
  was identified first, which is what exposed the increment-only ledger.

This principle was also **broken once, in this project**: two pre-existing
`edit_session` audit rows were deleted during an ad-hoc cleanup before anyone
had established what they were. They were unrecoverable, and their only value
would have been as evidence. Hence the standing rule in
`MONEY-CHANGE-CHECKLIST.md`: never delete data you did not create.

---

Decisions that were **not obvious**, and would otherwise have to be re-derived.
Code shows what; this shows why, and what was rejected.

Every entry uses the same template. **Previous assumption** records the belief
the decision overturned — omit it where there wasn't one rather than inventing
one, since a padded field is worth less than an absent one. **Evidence** is the
section to keep honest —
"it seemed right" is not evidence; a test that failed for the right reason is.
**Review date** is when the decision should be re-examined, not when it expires.

Evidence is tiered, because treating every decision as equally supported is how
assumptions get mistaken for facts:

| Tier | Meaning |
|---|---|
| **Verified** | Demonstrated to hold, and demonstrated to fail when broken |
| **Measured** | Observed against real data or a running system |
| **Reasoned** | Follows from the code, but not exercised |
| **Hypothesis** | Deliberately speculative, awaiting validation |
| **Assumed** | Believed, not checked — treat as a risk |

Read as a spectrum of confidence, and expect entries to move up it over time:

```
Hypothesis  →  Reasoned  →  Measured  →  Verified
```

An entry that never moves is either settled or quietly rotting; the review date
is what forces the question.

---

## ADR-001 — One settlement engine, mirrored client and server

**Status:** Accepted · superseded by a planned change (Phase 3)

**Previous assumption.** Two copies of the engine can be kept in step by convention and code review.

**Context.** Three flows settle money: live cash-out, back-dated record, and
edit. The client also needs to preview a settlement before committing it.

**Decision.** `computeSettlement` is the single source of settlement rules. A
byte-identical copy lives in `apps/web/src/lib/` for preview only; the server
copy is authoritative.

**Alternatives considered.** Three independent implementations (rejected:
divergence surfaces as a wrong payout, not a crash). A shared package from the
start (deferred: build complexity for one file — revisited in ADR-011).

**Consequences.** Duplication that must be policed. A test strips comments from
both files and asserts they are identical, so drift fails CI.

**Evidence — Verified.** The lockstep test was verified to fail: appending one line to the
web copy turned it red; restoring turned it green.

**Review date.** Phase 3 — `packages/settlement-core` removes the mirror and
makes the lockstep test unnecessary.

---

## ADR-002 — Audit is written immediately after the record, inside the transaction

**Status:** Accepted

**Previous assumption.** Writing the audit inside the transaction is sufficient, wherever it sits.

**Context.** Settling and recording a night create money records. Neither wrote
an audit entry, while every *modification* (edit, delete, restore) did.

**Decision.** `settleSession` and `createPastSession` write their `AuditLog` row
directly after creating the settlement/record — **before** the session close and
pot movement — inside the same transaction.

**Alternatives considered.** Writing the audit at the end of the transaction,
after the pot movement.

**Consequences.** The audit is guaranteed to be *attempted* whenever the
settlement row exists. **These writes must not be reordered**; a test enforces it.

**Evidence — Verified.** The first version placed the audit last and its atomicity test
passed — but the test was hollow: the forced failure occurred in the pot step,
before the audit was reached, so "no orphaned audit row" was trivially true.
Mutation testing exposed this: switching `tx.auditLog` to `prisma.auditLog` left
the suite green. After moving the write earlier, the same mutation turns it red
(`expected 1 to be +0`). The implementation changed because of the test, not the
other way round.

**Review date.** Phase 3, when `SettlementService` takes over orchestration.

---

## ADR-003 — One settlement per session, enforced in code; database constraint planned

**Status:** Partially accepted — constraint **planned** (Phase 1)

**Previous assumption.** Adding a unique constraint would first require cleaning up duplicate rows.

**Context.** `settleSession` opens with `SELECT … FOR UPDATE` and rejects any
session whose `status !== 'active'`. Nothing at the database level prevents a
second settlement row.

**Decision.** Keep the application guard and add a **plain** unique index on
`CashOutSettlement.sessionId`.

**Alternatives considered.** A partial unique index filtered on
`isDeleted = false` (rejected: soft-deleting a settlement never returns its
session to `active`, so a session can never legitimately settle twice — the rule
is "at most one, ever").

**Consequences.** Application logic prevents mistakes; the constraint prevents
impossible states. A bug or a future second code path can no longer create a
duplicate.

**Evidence — Measured.** Verified the migration would apply cleanly: 12 settlements, 12
distinct `sessionId`s, no duplicates. Duplicate prevention verified at runtime —
retrying a settle returns `409` and audit rows stay at exactly 1.

**Review date.** On implementation in Phase 1.

---

## ADR-004 — Settlement audit carries versioned provenance

**Status:** Accepted

**Context.** `AuditLog.changes` is a free-form JSON column. Two years on,
nobody will know which payload shape a row uses, or which engine produced its
numbers.

**Decision.** Every settlement audit row stores `changes.meta` with
`settlementEngineVersion`, `auditSchemaVersion` and `createdFrom`.

**Alternatives considered.** A single combined version (rejected: the two answer
different questions — *which rules produced these numbers* versus *how is this
payload shaped* — and conflating them forces false bumps). Inferring the engine
version from `createdAt` and release history (rejected: unreliable, and
impossible once releases are rolled back).

**Consequences.** Two constants to remember to bump. `SETTLEMENT_ENGINE_VERSION`
lives in the engine; `AUDIT_SCHEMA_VERSION` in `clubRecords/auditMeta.ts`.

**Evidence — Reasoned.** Neither value is reconstructable after the fact — that is the
whole argument. An integration test asserts both are present on every row.

**Review date.** When the engine first changes behaviour, to confirm the bump
discipline actually held.

---

## ADR-005 — A re-seated player's cash-out is discarded

**Status:** Accepted (product decision by the owner)

**Previous assumption.** A confirmed cash-out can be left in place when a player is re-seated.

**Context.** A player can stand up, have their cash-out confirmed, then be
seated again. The confirmed figure was being retained.

**Decision.** Seating a player voids any confirmed cash-out. Their banked total
is untouched, and they may take another bank as normal.

**Alternatives considered.** Requiring a fresh buy-in on re-seat (rejected: the
chips never left the table). Keeping the cash-out and treating the re-seat as a
new stint (rejected: double-counts).

**Consequences.** Accounting stays correct because the money never moved —
settlement nets them against whatever they finally leave with.

**Evidence — Verified.** Replayed end to end: after re-seat `cashOuts` is empty and the
player is seated; banks accumulate across the break (3,000 + 2,000 = 5,000); the
invariant holds (banks 5,000 vs final 6,000 → net +900 after the 10% cut) with
the discarded 4,500 appearing nowhere. Before the fix, `lockedCashOut` would
have let the stale figure silently override the admin's fresh count.

**Review date.** Not scheduled — revisit only if the stand-up flow changes.

---

## ADR-006 — Request expiry applies only to at-the-table requests

**Status:** Accepted

**Context.** Buy-in, sit-in and cash-out requests could sit pending forever,
misrepresenting the live table.

**Decision.** Those three expire after 5 minutes. Club join requests and
edit-approval requests never expire.

**Alternatives considered.** Expiring every request type (rejected: nobody waits
at a table for a join request, and an owner offline for five minutes would
auto-reject every one).

**Consequences.** Enforced twice — each `decide*` path re-checks expiry, which is
what makes the deadline exact; a 15s sweep clears dead rows and emits events,
which is what makes it visible. **The sweep assumes a single API process**; with
more than one, each would emit duplicate events.

**Evidence — Verified.** Unit-level (6-min-old expires, fresh survives, missing timestamp
never expires), sweep selectivity across all three types simultaneously, and all
three `decide*` guards returning 409 on a freshly-expired request.

**Review date.** Before running more than one API instance.

---

## ADR-007 — A club charging a rake must enable the Club Pot

**Status:** Accepted

**Previous assumption.** `potEnabled` only controls whether the pot is displayed and tracked.

**Context.** With the pot disabled, the engine still deducted a rake from
winners but banked nothing — money left players and the app had no record of it.

**Decision.** `createClub` rejects a session rake or winners' cut when
`potEnabled` is false.

**Alternatives considered.** Always banking the rake regardless (rejected:
changes settlement behaviour for existing clubs). Silently not charging
(rejected: the club's configured rules would be ignored without saying so).

**Consequences.** Since club rules are immutable after creation, a club created
in the bad state could never be corrected — hence a guard at creation rather
than a warning.

**Evidence — Verified.** Demonstrated the hole: with pot disabled and a 10% cut, players
were charged 300 and `potContribution` stayed 0, so `sum(nets) + pot === 0`
silently failed. Confirmed no existing club was affected. Guard verified: `400`.

**Review date.** Not scheduled.

---

## ADR-008 — Leaderboard is private by default

**Status:** Accepted

**Previous assumption.** The leaderboard default was already safe for players.

**Context.** `leaderboardVisibleToPlayers` defaulted to `true`, so any member
could read every other member's lifetime net profit, buy-ins and biggest
win/loss. This contradicted a stated product principle.

**Decision.** Default `false`; owners opt in per club from Club Settings.

**Alternatives considered.** Removing the toggle and always hiding (rejected:
some clubs want a shared leaderboard). Per-row scoping to a player's own line
plus rank (deferred: larger change, and the toggle satisfies the requirement).

**Consequences.** Existing clubs were backfilled to `false` in the same
migration — a default-only change would have left every existing club exposed.
Client fallbacks also fail closed (`?? false`).

**Evidence — Verified.** Confirmed in a browser before the change: signed in as a plain
member, the owner's full lifetime line was visible. After: the RANKS tab
disappears and `GET /leaderboard` returns `403`; owner still `200`; the toggle
round-trips both ways.

**Review date.** After first real usage — decide whether per-row scoping is
wanted instead of an all-or-nothing toggle.

---

## ADR-009 — The three settlement flows share one UI, parameterised by mode

**Status:** Accepted

**Context.** Live settle, back-dated record and edit answer the same question
but had grown three different layouts, reading as three unrelated features.

**Decision.** `SettlementPreview` and `SettlementConfirm` render every
settlement. The flows differ only in their input controls.

**Alternatives considered.** Restyling three components to match (rejected:
they would drift again). One component with conditional branches throughout
(rejected: the input controls genuinely differ).

**Consequences.** Amounts in these screens are **always Chips**. The Chips/₹
switch belongs to History and the Leaderboard where results are *read*; these
screens are where chip counts are *entered*, and showing rupees would invite
entering them.

**Evidence — Verified.** Walked all three in a browser after the change, including
committing an edit end to end (pot 150 → 100 with a `-50` adjustment row, cut
correctly re-applied).

**Review date.** Phase C, when the unified settlement UX is designed properly.

---

## ADR-010 — No router; navigation is a `viewState` string

**Status:** Accepted for now — **planned to change** (Phase 4)

**Context.** The app has seven screens and no routing library. `App.tsx` holds
a `viewState` string union and conditionally renders.

**Decision.** Keep it until the data layer lands.

**Alternatives considered.** Introducing React Router first (rejected: see
below).

**Consequences.** No URLs, no browser back, refresh returns to the dashboard, no
deep links, harder to test. One special case: `/oauth/callback` is handled by
reading `window.location.pathname` directly.

**Evidence — Reasoned.** `ClubDetailView` receives a whole `Club` object as a prop, so it
cannot be entered from a URL — deep-linking requires the shell to fetch by
`:clubId`, which is what the data layer provides. Routing before the data layer
would mean building that fetch twice.

**Review date.** Phase 4.

---

## ADR-011 — Vertical feature slices per deployable, not across them

**Status:** Accepted (planned structure, Phase 3)

**Previous assumption.** A feature slice can hold both server services and React UI in one folder.

**Context.** Feature-based folders were proposed, co-locating a domain's
engine, services, UI, hooks and tests in one directory.

**Decision.** Slice vertically *within* each deployable, and share only the
isomorphic core via `packages/settlement-core`.

**Alternatives considered.** A single `modules/settlement/` holding both React
components and Prisma-backed services.

**Consequences.** `packages/settlement-core` carries the engine, its rules, its
types and its tests — which finally removes the mirrored engine and makes the
lockstep test unnecessary.

**Evidence — Measured.** `apps/api` and `apps/web` are separate workspaces with separate
build targets (`tsc` and `vite`). A shared folder would either fail the API
build (`.tsx` in a `tsc` project) or let Vite follow an import from `ui/` into
`services/` and **bundle the Prisma client into the browser**. Verified the
separation is currently clean: nothing server-only appears under `apps/web/src`.

**Review date.** On implementation in Phase 3.

---

## ADR-012 — The client re-joins its socket room on every connect, and refetches

**Status:** Accepted

**Previous assumption.** Socket.IO reconnect automatically restores room membership.

**Context.** `club:join` was emitted once, in a `useEffect` on mount, with no
`connect` handler anywhere in the client. Socket.IO room membership lives on the
socket, so a reconnect produces a *new* socket in **no rooms**. After any drop —
phone backgrounding, laptop sleep, wifi change, an API restart — the client
silently stopped receiving updates while the UI carried on looking normal.

**Decision.** Re-emit `club:join` on every `connect`, and refetch every slice at
the same time. Surface the connection state in the header when it is not live.

**Alternatives considered.** Re-joining without refetching (rejected: events
that fired while disconnected are gone, so the view would resume from a stale
snapshot). A permanent green "Live" badge (rejected: a always-on indicator
becomes furniture and stops being read — it appears only on trouble).

**Consequences.** A reconnect costs eight refetches. Acceptable at this scale
and far cheaper than settling against a stale table. The same bug exists in
`VirtualTableView`, which is currently unreachable — fix it if that view is
ever revived.

**Evidence — Verified (positive) / Reasoned (negative).** With the fix, an API
restart drops the socket and a subsequent sit-in request appears live with no
reload, and the "Reconnecting" badge clears. Removing the `connect` handler was
observed to leave the badge stuck on "Reconnecting", confirming the handler is
what restores live state.

The negative control was **not** cleanly demonstrated: with the handler removed,
updates still arrived, because Vite HMR can remount the component and re-join
the room as a side effect. A clean negative needs a production build. Recorded
as a known limitation rather than claimed as proof.

**Outstanding.** Re-run the negative control against a **production build**
before the first deployment. Production bundles have no HMR, so that is the only
environment where removing the `connect` handler will definitively demonstrate
the bug. Until then this ADR's negative case stays *Reasoned*, not *Verified*.

**Review date.** Phase A (production-build negative control), then Phase 1 —
the refetch fan-out becomes cache invalidation and this handler becomes one line.

---

## ADR-013 — Refresh tokens rotate on every use and are never deleted inline

**Status:** Accepted · **cleanup job planned**, session cap **open question**

**Previous assumption.** One login mints one refresh token, so a login that adds
two rows indicates a bug.

**Context.** A second Google sign-in raised `refreshToken` from 441 to **443**,
not 442. The table had also grown to 443 rows with nothing ever removed.

**Decision.** Keep rotation-with-reuse-detection as implemented. Add a scheduled
cleanup. Treat a per-user active-session cap as a separate, unresolved question.

**The +2 is correct.** The sequence, which is not obvious from the code:

```
  Google callback
        │  issueTokenPair()
        ▼
  Token A created                      refreshTokens +1
        │
        │  browser redirected to the app; AuthProvider mounts
        ▼
  POST /auth/refresh
        │  issueTokenPair() with the same familyId
        ├──► Token B created           refreshTokens +1
        └──► Token A updated: revokedAt = now, replacedBy = hash(B)
                                        (row kept, not deleted)
```

So one login produces two rows: one live, one revoked. Every subsequent page
load rotates again — B revoked, C created. Rows accumulate by design, because
`replacedBy` is what makes reuse detection possible: presenting a revoked token
proves theft and invalidates the family.

**Consequences — measured on the dev database:**

```
  total                 445
  revoked               237
  expired                 0
  live & usable         207   across 34 users
  median per user         1
  MAX HELD BY ONE USER   59
```

Two distinct problems, and the second is the one that matters:

1. **Unbounded history.** Revoked rows are never removed.
2. **Unbounded concurrency.** Nothing caps *live* tokens per user. 59 valid
   sessions for one account is 59 ways in, none of them visible to the user.

**Planned cleanup** (nightly):

```sql
DELETE FROM "RefreshToken"
WHERE  expires_at < NOW()
   OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '30 days');
```

Keeps a 30-day forensic window on revoked tokens — long enough to investigate a
reuse alert — while bounding the table.

**Evidence — Measured.** Running that rule against the current database today
matches **0 rows**: every revocation is recent and `JWT_REFRESH_TTL` has not
elapsed for any token. The rule is correct but does nothing for 30 days, so it
is not by itself a fix for the 207 live tokens. That is what the cap is for.

**Open question.** A per-user cap (revoke oldest beyond N, N ≈ 5–10) bounds live
sessions immediately rather than in 30 days. Not implemented — it changes login
behaviour for real users and needs a decision on N and on whether users get any
visibility of their sessions.

**Review date.** Before first deployment for the cleanup job; the cap decision
before inviting users beyond the first club.
