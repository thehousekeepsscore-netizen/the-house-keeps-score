# Deployment log — settlement history work

Production operations for `SETTLEMENT-HISTORY-DESIGN.md` steps 1–4. Written so
the sequence, the evidence and the one mistake are visible without anyone having
to reconstruct them from PR descriptions.

**The rule these operations follow:** additive migration first, deploy second,
data operation third, each verified before the next. It is written down because
it was broken once — see the incident below.

---

## Operational incident — #28 merged before its migration

**Date:** 2026-08-16
**Impact:** none. Recorded because the ordering rule exists to prevent exactly
this, and a near miss with no consequence is the cheapest version of the lesson.

### What happened

PR #28 (the revision model) was merged and deployed **before** its migration
`20260814100000_settlement_revision` had been applied to production. That
inverts the order established for #27 and stated as non-negotiable: migration,
then deploy.

The deployed code writes a `SettlementRevision` row inside the settlement
transaction (`settleSession`). Against a database with no such table, settling
a night would have thrown, and the transaction would have rolled back.

### Blast radius, established from data rather than assumed

**Nothing happened in the window.** Zero settlements were recorded on
2026-08-16 at all. The two most recent settlements predate the deploy by a day
and two days:

```
cmsv0lsgu…  2026-08-15T23:36:23Z
cmstjdgr3…  2026-08-14T22:46:15Z
settlements on 2026-08-16: 0
```

Had one occurred, the failure mode would have been a **refused settlement**, not
a corrupted one — the write is inside a transaction, so a missing table aborts
the whole thing rather than half-writing it. No cleanup was required and nothing
was undone.

### Fix

The migration was applied as soon as the ordering error was noticed, closing the
window. State verified afterwards: four migrations applied, the partial unique
index present, financial values unchanged.

### What would prevent a recurrence

The real gap is that **nothing applies migrations automatically** — no
`prisma migrate deploy` in the API's build or start, and no deploy config in the
repo. So every schema change depends on a human running a command in the right
order. Options, none of them taken yet because each is a deployment change in
its own right:

- add `prisma migrate deploy` to the API's start command, so the order cannot be
  got wrong
- or keep it manual and add a release checklist that the PR template enforces

Worth deciding before the first correction ships, since that path writes money.

---

## Timeline

| Date | Operation | Verified by |
|---|---|---|
| 2026-08-14 | **#25** step 1 merged — replayability audit, read-only | CI; audit run against production |
| 2026-08-14 | **#26** step 2 merged — versioned engine | golden fixtures from each version's original source out of git |
| 2026-08-14 | Migration `20260814000000_canonical_settlement_contract` → production | 6 columns, all nullable, all NULL; financial digest unchanged |
| 2026-08-14 | **#27** step 3 deployed — canonical replay contract | API and web healthy; audit re-run identical |
| 2026-08-16 | **#29** merged — deployment identity on `/api/health` | endpoint called in production |
| 2026-08-16 | **#28** step 4 deployed — revision model | *(ordering incident above)* |
| 2026-08-16 | Migration `20260814100000_settlement_revision` → production | 4 migrations applied; partial unique index present |
| 2026-08-16 | **Revision 1 backfill executed** | ten checks, all pass — below |

---

## The health endpoint, and why it exists

`/api/health` returned `{"status":"ok"}` and nothing else. During the #27 deploy
the migration, the schema and the financial digest were all verifiable, and
**which build was serving was not**. #29 closed that.

Verified in production immediately before the backfill:

```json
{
  "status": "ok",
  "commit": "898a3e57aa6dc38a010da6f197fea5bbb9793f08",
  "commitShort": "898a3e5",
  "commitSource": "RAILWAY_GIT_COMMIT_SHA",
  "settlementEngineVersion": 3,
  "auditSchemaVersion": 1,
  "startedAt": "2026-08-16T13:28:11.434Z",
  "uptimeSeconds": 96
}
```

`898a3e5` is #28's merge commit, so the instance answering was provably the one
carrying the revision model. That check was impossible a deploy earlier.

---

## Revision 1 backfill — 2026-08-16

### Population

| | |
|---|---|
| records examined | 5 |
| eligible | 4 |
| skipped — `rules-unknown` | 1 |
| legacy / non-engine-settled | 0 |
| replay mismatches | 0 |
| other failures | 0 |

**Skipped:** `cmsf5a2gt…` (Texas Holdem, 2026-08-04). Engine version known (v1),
rules never recorded anywhere. Skipped rather than repaired — the club's current
rules are not evidence of what that night used.

### Written

| Record | Engine | Players | Rake | Split |
|---|---|---|---|---|
| `cmsl1zrnr…` | v1 | 11 | 20,150 | `null` + reason |
| `cmsmbsezu…` | v2 | 12 | 0 | `null` + reason |
| `cmstjdgr3…` | v3 | 11 | 0 | known |
| `cmsv0lsgu…` | v3 | 12 | 0 | known |

The two v3 nights were settled **after** the canonical contract shipped, so
their revision 1 uses the contract captured at settle time rather than a
reconstruction — which is why their seat fee and winners' cut are real values
instead of nulls.

### Verification — ten checks, all pass

```
PASS   1. exactly 4 revision-1 rows created
PASS   2. each record has exactly one isLive revision
PASS   3. skipped Texas Holdem record has no revision
PASS   4. every revision reproduces its settlement at its own engine version  (4/4)
PASS   5. per-record financials, club pot and ledger unchanged  (0 changed)
PASS   6. participant order and seatIndex preserved  (4/4)
PASS   7. canonical inputs/outputs/rules/engineVersion populated  (4/4)
PASS   8. seatFee null + reason on the 2 pre-contract records; real split on the 2 v3
PASS   9. no duplicate live revisions
PASS  10. no new settlement rows, and none for skipped/legacy
```

The dry run beforehand was proven to write nothing: revision rows 0 → 0, and
all five per-record hashes identical.

### A method note worth keeping

The original single global digest taken on 2026-08-14 **stopped matching**, and
correctly so: two real poker nights were settled on the 14th and 15th. All
pre-existing records were byte-identical throughout.

On a live system a global digest is not an invariant — it changes whenever
somebody plays. Every check since compares **per record**, against a snapshot
taken immediately before the operation. Anything else produces a false alarm
that trains people to ignore the alarm.

---

## Standing facts about production

- **Database:** Supabase pooler, session mode, ~15 client slots shared by every
  instance. Scripts pin `connection_limit=1`; a script that takes a third of the
  budget to count rows can cause the outage it exists to prevent.
- **Migrations run as a pre-deploy step**, not manually and not at startup:
  `preDeployCommand` in `railway.json` runs `prisma migrate deploy` before a
  release goes live (Stage 3, 2026-08-18). This line previously read "migrations
  are manual"; that stopped being true and the log did not say so.
  **Caveat:** that file is read by every service in the project, so the step
  currently runs on the frontend service too — see `RAILWAY-SERVICE-SCOPING.md`.
- **History is small:** 5 settled nights, 0 back-dated records, 3 clubs.
- **Engine versions in production:** v1 ×2, v2 ×1, v3 ×2. All three still run.
- **One record is permanently uncorrectable** (`cmsf5a2gt…`) until a human
  states the rules that were in force, which would then be audited as their
  statement rather than as data.

---

## Configuration finding — one railway.json applied to two services

**2026-08-21, read-only. Nothing changed on Railway.**

The `react-example` (frontend) service reads the same root `railway.json` as
`@poker/api`. It is therefore health-checked at `/api/health`, which it does not
serve, and runs `prisma migrate deploy` against the production database on every
deployment. Its build succeeds; the healthcheck then fails for five minutes and
the container is stopped.

Seven failed deployments (#41, #42, #44, #45, #46, #47, #48) each connected to
production and reported `No pending migrations to apply.` — nothing was applied,
because the API service had already applied them in the same release. The
exposure is the permission, not the outcome: a release carrying a pending
migration would have had two services racing to apply it.

**The correction this log exists to preserve:** #33, #38 and #39 showed green
checks on GitHub for this service and were read as successful deployments. They
were **SKIPPED** — the service watches `/apps/web/**` and none of those merges
touched it. The last genuine success was #26 on 14 Aug, *before* `railway.json`
existed. The fault was introduced by Stage 1 on 16 Aug; #41 was merely the first
merge that made the service attempt a deployment.

A green check on a commit is not evidence that a deployment ran.

Full evidence, the two further defects found alongside it (a Vite dev server as
the production start command, and API secrets present on the frontend service),
and the options with their tradeoffs are in `RAILWAY-SERVICE-SCOPING.md`. No fix
is proposed there, because it depends on whether `react-example` is needed at
all — Vercel serves production and succeeded on every commit this service failed
on.

---

## Design finding — the seed guard checks NODE_ENV, not the database

**2026-08-22. A documented weakness, not an incident.** Nothing here says this
has happened; it says it is possible.

`assertSeedingAllowed` (`apps/api/src/lib/seedGuard.ts`) refuses to seed when
`NODE_ENV === "production"` unless `ALLOW_PRODUCTION_SEED` is set. Its first
line is:

```ts
if (env.NODE_ENV !== "production") return;
```

**The check is on `NODE_ENV`. It never looks at where `DATABASE_URL` points.**
So the guard protects a production *process*, not a production *database*. A
seed run from a laptop — `DATABASE_URL` set to production, `NODE_ENV` unset or
`development` — returns early on that first line and proceeds to write.

For `seed.ts` that write is a super-admin account with access to every club's
money, created with `SEED_SUPER_ADMIN_PASSWORD`. `seed-history.ts` shares the
same guard and inserts `HistoricalSessionRecord` rows.

What is currently true of the deployed system, and worth recording so the shape
of the risk is not overstated:

- the seed is **not wired into any deploy path** — `apps/api/railway.json` runs
  `prisma migrate deploy` and nothing else, and the start command is
  `npm run start`;
- `ALLOW_PRODUCTION_SEED` is **not set** on the `@poker/api` service;
- the guard has existed since the first commit (3 Aug), and `seed.ts` is
  byte-identical to that version (`00e0ab24…`), so there is no window in
  recorded history where an unguarded seed shipped.

The remaining exposure is therefore entirely the local-invocation path above.

**Related and still open:** `SEED_SUPER_ADMIN_EMAIL` and
`SEED_SUPER_ADMIN_PASSWORD` on the API service still hold the `.env.example`
defaults — the server says so at every boot — and this repository is public, so
those values are published. Seeding is create-or-promote only (`seed.ts`): it
writes `passwordHash` when creating a user and never updates it afterwards, and
no password-reset mechanism exists anywhere in `apps/api/src`. Changing the
Railway variable therefore would not alter an account that already exists.

**Resolved, 22 Aug 2026.** A production lookup for that address returned **zero
rows** — no such account was ever created, so there was nothing to reset and the
production database was not modified.

The remediation was therefore preventative, and was done in this order on
purpose:

1. **The Railway variables were rotated first**, while the code still compared
   against the old published pair. The next boot's banner lost its
   `⚠ Seed credentials` line, which proved the *values* had changed.
2. **Then the defaults were removed from the repository** (#51 at `c4304cc`) —
   from both `.env.example` files and from `env.ts` together, because moving
   only the example file would have published a new working password that
   `describeSeedCredentialRisk` did not recognise, silencing the warning for the
   exact string people copy.

That order matters and cannot be repeated: once the constants moved, the warning
would have gone quiet whether or not anything was rotated, and the check would
have passed for the wrong reason. `seedGuard.test.ts` now enforces that the
published values and the constants cannot drift apart again.

`JWT_ACCESS_SECRET` was deliberately not rotated — presence in a container is not
evidence of exposure, and the cost is logging every session out.