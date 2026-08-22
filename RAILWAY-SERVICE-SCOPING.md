# One railway.json, two services

**Status:** read-only finding. Nothing on Railway has been changed. No fix is
included here — the fix depends on a decision only the owner can make.
**Found:** 21 Aug 2026, while investigating why the `react-example` service had
failed on every merge since 18 Aug.

---

## The finding

There is one `railway.json`, at the repository root:

```json
{
  "deploy": {
    "healthcheckPath": "/api/health",
    "healthcheckTimeout": 300,
    "preDeployCommand": ["npm run prisma:deploy --workspace=@poker/api"]
  }
}
```

The `patient-luck` project contains **two** services built from this repository —
`@poker/api` and `react-example` (the web workspace's package name). Both read
that same file. So the frontend service is health-checked on an API endpoint it
does not serve, and is handed the API's database migration command.

This is not inference. It is in the frontend service's own deploy log for
`67e4d2c`:

```
Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL "postgres" at aws-1-ap-south-1.pooler.supabase.com:5432
5 migrations found in prisma/migrations
No pending migrations to apply.
...
Starting Healthcheck   Path: /api/health   Retry window: 5m0s
Attempt #1–#11 failed with service unavailable
1/1 replicas never became healthy!   Healthcheck failed!
```

The build itself succeeds — `✓ built in 4.93s`. Vite starts and is ready in
201ms. Everything that fails, fails after the application is running.

**Neither value appears in the service's stored settings.** Config-as-code is
layered on at deploy time, so `get-service-config` for `react-example` returns a
`deploy` block with no `healthcheckPath` and no `preDeployCommand` at all. That
is why this was invisible from the dashboard.

## Why nobody noticed for two days

`react-example` has `watchPatterns: ["/apps/web/**"]`. Between `railway.json`
landing and the first frontend change, every merge was **SKIPPED** for this
service — and GitHub reports a skipped deployment as a green check.

| | |
|---|---|
| 14 Aug, #26 | last genuine SUCCESS — **before `railway.json` existed** |
| 16 Aug, #32 | Stage 1 adds `railway.json` with `healthcheckPath: /api/health` |
| 16–18 Aug (#31, #32, #38, #39, #33) | **SKIPPED** — no `/apps/web/**` changes |
| 18 Aug, #41 | first `apps/web` change since → actually deploys → **FAILED** |
| #42, #44, #45, #46, #47, #48 | identical failure, every time |

**A correction worth keeping in the project history.** The first reading of this
was that the service "broke at #41", because #33, #38 and #39 showed green on
GitHub. They were skips, not successes. The configuration problem was introduced
on **16 Aug by Stage 1**; #41 was simply the first merge that caused the service
to try. A green check on a commit is not evidence that a deployment ran.

## What did and did not happen to the database

**Did:** the frontend container connected to the production database and ran
`prisma migrate deploy` on every one of the seven failed deployments.

**Did not:** apply anything. Every run reported `No pending migrations to
apply.`, because the API service's own pre-deploy step had already applied them
minutes earlier in the same release.

The exposure is not what happened; it is what was permitted. A release with a
pending migration would have had **two services racing to apply it** against one
database. Prisma takes an advisory lock, so the likely outcome is one applies and
the other waits — but that is a property of Prisma, not of this design, and it
was not what Stages 2 and 3 proved.

## Two further defects, independent of the above

**The start command runs a dev server.** `startCommand: npm run dev
--workspace=react-example` → `vite --port=3000 --host=0.0.0.0`. That is Vite's
development server in production, with a hardcoded port that ignores Railway's
injected `$PORT`. It predates the `railway.json` work and is not what fails the
deploy — but this service has never served a production build, including when it
was green.

**The frontend service holds the API's secrets.** Its variable list includes
`DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_TTL`, `POSTGRES_PASSWORD`,
`POSTGRES_USER`, `POSTGRES_DB` and `SEED_SUPER_ADMIN_PASSWORD`. Only names were
read; no values. This is what made the Prisma run above possible, and it stands
as a concern whatever is decided about the service.

---

## Is it needed? What the evidence says

Answered from Railway and the repository rather than from recollection.

**The service has no address.** `list-domains` on `react-example` returns
`serviceDomains: []` and `customDomains: []` — no Railway-generated domain, no
custom domain. It is not reachable from the internet. Nothing can be calling it,
because there is nothing to call.

**Production traffic goes elsewhere, and the repo says so explicitly.**
`apps/web/vercel.json` rewrites the frontend's API and socket paths:

```json
{ "source": "/api/:path*",  "destination": "https://pokerapi-production-6131.up.railway.app/api/:path*" },
{ "source": "/socket.io",   "destination": "https://pokerapi-production-6131.up.railway.app/socket.io" },
{ "source": "/(.*)",        "destination": "/index.html" }
```

`list-domains` on `@poker/api` returns exactly that host —
`pokerapi-production-6131.up.railway.app`, target port 8080. So the production
path is **Vercel → `@poker/api`**. `react-example` is not in it.

**Nothing references it.** The only `railway.app` occurrences anywhere in the
repository are the three rewrite lines above, all pointing at the API.

So for the eight days since 18 August this service's entire function has been to
build a frontend nobody can reach, connect to the production database, and turn
every `apps/web` merge red.

**What the evidence does not establish.** That the service was never intended to
matter, or that a Railway-hosted frontend is not wanted as a fallback later.
Deleting a Railway service is irreversible, so the intent question remains a
human decision — the evidence narrows it to "unused and unreachable **today**",
which is not the same claim.

**Still unverified:** `WEB_ORIGIN`. It is a CORS origin and should name the
Vercel frontend rather than this service, but that has not been confirmed.
Confirming it through the API means `list-variables`, which returns every
variable's value including secrets; reading that one variable in the Railway
dashboard is the proportionate route.

## The decision this needs first

**Is `react-example` wanted at all?** The evidence above says it is doing nothing
except harm. Until the intent question is answered, no configuration change
should be made.

### Option A — retire the service

Delete `react-example` from `patient-luck`, and remove its production
credentials.

- **For:** removes the duplicate migration path, the misdirected healthcheck and
  the frontend's database access in one action. Stops the red check on every
  merge. Nothing in the repository needs to change.
- **Against:** irreversible on Railway. If it serves a purpose nobody has
  articulated — a fallback host, a preview target — that purpose disappears with
  it.
- **Before doing it:** confirm no DNS, no client, and no `WEB_ORIGIN` points at
  its domain.

### Option B — scope the config file to the API

Keep both services. Move the deployment contract so it applies only to the
service it describes — either by moving the file to `apps/api/railway.json` and
pointing the API service's config-as-code path at it, or by setting a distinct
config path per service.

- **For:** fixes the architectural fault rather than removing one symptom of it.
  Correct regardless of what happens to `react-example`, and correct for any
  service added later.
- **Against:** the API service's config path is a Railway dashboard setting, so
  this is not a repository-only change and cannot be reviewed entirely in a PR.
  The frontend service would still need its own healthcheck, start command and a
  credential purge to be genuinely production-worthy.

### Option C — give the frontend its own correct config

Option B, plus a real production configuration for `react-example`: serve the
built `dist/` rather than running Vite, bind to `$PORT`, health-check `/` and
remove every database and JWT variable.

- **For:** the only option that leaves a working second frontend.
- **Against:** the most work, and it is work to keep a service whose necessity is
  unestablished while Vercel already serves production.

### Recommendation

**A and B**, on the evidence above: the service has no domain, carries no
traffic, and is referenced by nothing, so there is nothing to preserve by
keeping it — and B is required in every case, because the config-scoping fault is
what gives a non-API service database access and a migration command.

If the intent decision goes the other way and the service is kept, then **B then
C**, and B still comes first. Do not repair the frontend service before deciding
whether to keep it: C is a substantial piece of work to preserve something whose
purpose is currently unestablished.

Two things gate A, and neither is a repository matter: confirming `WEB_ORIGIN`
does not name this service, and the owner's decision that no Railway-hosted
frontend is wanted later.

## Decision — 21 Aug 2026: retire `react-example`

Taken by the owner on the evidence above. Recorded here rather than in a chat
log because the steps below are dashboard work with no repository trace.

Neither the deletion nor the variable removal was performed by the agent that
wrote this document. Destroying a production service and handling production
credentials are owner actions; the Railway integration available here has no
service-deletion capability, and would not have been used for it if it did.

### Retirement steps, in order

1. **Verify `WEB_ORIGIN`** in the Railway dashboard — confirm it names the Vercel
   frontend and not this service. Read it in the dashboard rather than through
   `list-variables`, which returns every secret value.
2. **Delete the `react-example` service** in `patient-luck`.
3. **Remove its environment variables** as part of retirement (they go with the
   service, but confirm rather than assume).
4. **Rotate — see below.** Steps 2 and 3 are not sufficient on their own.

### Why deletion is not the end of it

`DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_TTL`, `POSTGRES_PASSWORD`,
`POSTGRES_USER`, `POSTGRES_DB` and `SEED_SUPER_ADMIN_PASSWORD` were present in
this service's environment on every deployment from 16 August onward, and its
container demonstrably used `DATABASE_URL` to reach production.

**Deleting the service removes future access. It does not invalidate credentials
that were already present.** If those values are treated as exposed, the action
that actually closes it is rotation:

- the database password / `DATABASE_URL`,
- `JWT_ACCESS_SECRET` — note that rotating it invalidates every live access
  token, so it logs everyone out; choose the moment,
- `SEED_SUPER_ADMIN_PASSWORD`, which is already on the deferred list from the
  migration-release work.

Whether to rotate is a judgement about how the exposure is rated — the container
was unreachable from the internet and the secrets were never in the repository.
It is recorded here so the decision is made deliberately rather than skipped by
assuming deletion covered it.

## Runbook — Option B, and why the PR alone does not finish it

**The repository change and the Railway change are two separate acts, and the
first is inert without the second.** Moving the file to `apps/api/railway.json`
does not, by itself, scope anything: Railway looks for `railway.json` at the
repository root unless a service's **config-as-code path** says otherwise, and
that path is a per-service dashboard setting with no representation in this
repository.

So a merged PR that only moves the file leaves production **worse** than today:
the API would silently lose its healthcheck and its pre-deploy migration step —
because nothing at the root would be found any more — while the frontend service
would carry on unaffected. The migration gate would stop running, and the first
release to notice would be one carrying a pending migration.

**Status — 21 Aug 2026: step 1 is done, and the gap it opens is now live.**
The `@poker/api` service's config file is set to `/apps/api/railway.json`, which
did not exist in the repository at that moment. Until the move below is merged,
the API therefore has **no config-as-code at all** — no `preDeployCommand` and no
`healthcheckPath` — and falls back to its dashboard settings.

While that window is open, **nothing touching `/apps/api/**` should be merged**:
such a release would deploy with no migration gate. The window closes when the
PR carrying the move lands, and not before.

Ordering matters, and the manual step comes first:

1. **Railway dashboard, `@poker/api` service:** set the config-as-code path to
   `apps/api/railway.json`. At this moment the file does not exist there yet, so
   the service falls back to its dashboard settings — confirm what those are
   *before* changing the path, because they are what will be in force during the
   window between step 1 and step 2.
2. **Merge the PR** that moves `railway.json` → `apps/api/railway.json`.
3. **Verify on the next API release** that the pre-deploy step ran and the
   healthcheck passed — read the deploy log, do not infer it from a green check.
   That is the specific mistake this document exists to record.
4. **Verify on the next `apps/web` change** that the frontend service no longer
   runs Prisma and is no longer probed at `/api/health`.
5. Only then is Option B complete.

Whoever opens that PR must state steps 1, 3 and 4 in its description. A reviewer
reading the diff alone sees a file being moved and has no way to know that the
change is inoperative — or actively harmful — without a dashboard setting they
cannot see.

## Desired end state

```
API service                      Web (Vercel)
 ├── production start             ├── frontend build
 ├── /api/health                  ├── no API healthcheck
 ├── Prisma pre-deploy            ├── no Prisma migration
 └── database credentials         └── no production DB credentials
```

## Method note

Everything above came from read-only queries: `list-projects`,
`list-services`, `get-service-config`, `list-deployments`, `get-logs`,
`list-domains`, plus GitHub commit statuses and the repository itself. No deployment was created, cancelled, restarted or
redeployed; no variable, setting, watch path or healthcheck was modified; the
database was not touched.

The one query deliberately **not** run was `list-variables`, which returns
values. Variable names were sufficient to establish the finding, and reading
production secrets was not necessary to it.
