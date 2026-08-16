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
- **Migrations are manual.** Nothing in the build or start command applies them.
- **History is small:** 5 settled nights, 0 back-dated records, 3 clubs.
- **Engine versions in production:** v1 ×2, v2 ×1, v3 ×2. All three still run.
- **One record is permanently uncorrectable** (`cmsf5a2gt…`) until a human
  states the rules that were in force, which would then be audited as their
  statement rather than as data.
