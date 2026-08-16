# Making `migration → deploy` a controlled release step

Investigation and proposal. **Nothing here is implemented**, and no production
setting has been changed.

The problem, from `DEPLOYMENT-LOG.md`: nothing applies migrations. Every schema
change depends on a human running a command in the right order, and on
2026-08-16 that failed — #28 was deployed before its migration. Nothing came of
it, because nobody settled a night that day. The next path we build **writes
money**, so the process should not still be a habit by then.

---

## 1. What is actually true today

*(established from the repo and from production, not assumed)*

| Fact | Evidence |
|---|---|
| The API runs on Railway | `/api/health` reports `commitSource: RAILWAY_GIT_COMMIT_SHA` |
| There is a Dockerfile | `apps/api/Dockerfile`, multi-stage, unchanged since `613525d` |
| The runtime image **can** run migrations | its final stage copies `node_modules` **and** `apps/api/prisma` — so the CLI and the migration files are both present |
| Nothing runs them | `CMD ["node", "dist/index.js"]`; `build` is `prisma generate && tsc`; no `postinstall` |
| No deployment config is version-controlled | no `railway.json`, `railway.toml`, `nixpacks.toml` or `Procfile` anywhere in the repo |
| Migrations are applied by hand | the four applied rows in `_prisma_migrations` were each run manually from a laptop |

The last two are the actual problem, and they compound: the deploy configuration
is **invisible to code review**, so no PR can ever show that a release step
exists or that someone removed it.

### What could not be determined from here, and how to settle it

- **Whether Railway builds from that Dockerfile or from Nixpacks.** The
  Dockerfile's `COPY apps/api …` paths require the repo root as build context,
  which suggests it is configured with a root directory and an explicit
  Dockerfile path — but that lives in the dashboard.
- **The current dashboard values** for healthcheck path, restart policy and
  replica count.
- **Whether a pre-deploy command runs from the application image.** The docs say
  it runs in "a separate container"; they do not say from which image.

None of these block the recommendation, and §5 turns all three into a cheap,
read-only first step rather than an assumption.

---

## 2. The primitive that fits: Railway's pre-deploy command

*(from Railway's documentation, quoted rather than remembered)*

Railway supports **config as code** — `railway.json` or `railway.toml` in the
repo — and *"configuration defined in code will always override values from the
dashboard."* That alone fixes the invisibility problem.

Among the settings is `preDeployCommand`, *"the command to run before starting
the container"*. Its documented behaviour is exactly what a release step needs:

- it executes **"between building and deploying your application"** — after the
  build, before the new container starts
- **if it fails, "it will not be retried and the deployment will not proceed"** —
  the deployment is aborted and the previous version stays live
- it runs in a separate container from the application
- **database migrations are the documented example use case**

There is a caveat that pre-deploy commands *"should not attempt to read or write
data to the volume or filesystem"* because volumes are not mounted. That does
not apply here: a migration writes to Postgres over the network, and touches no
volume.

### Why this answers the concern about health checks and restarts

Railway's healthcheck *"will query the endpoint until it receives an HTTP 200
response. Only then will the new deployment be made active and the previous
deployment inactive"*, with a **300-second** budget.

With `preDeployCommand`, the migration finishes **before** anything is health
checked. The app never boots against a half-migrated schema, and a restart
cannot re-enter the migration, because the migration is not part of starting the
app at all.

---

## 3. Why *not* the startup approach

The obvious shortcut is:

```dockerfile
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
```

It is the thing to avoid, and specifically:

**It runs once per replica, and once per restart.** A migration is a
release-level event; a start command is a process-level one. Scale to two
replicas and two migrations race. Prisma takes an advisory lock so they
serialise rather than corrupt — but the second waits, and the wait is spent
inside the healthcheck budget.

**A restart loop becomes a migration loop.** With `restartPolicyType` of
`ON_FAILURE` or `ALWAYS`, a container that crashes for any unrelated reason
re-runs the migration on every attempt.

**A slow migration eats the 300-second healthcheck window.** The migration and
the health probe are then competing for the same budget, and the failure is
reported as "unhealthy" rather than "migration failed" — the wrong diagnosis at
the worst moment.

**The worst failure mode is silent.** If `migrate deploy` fails, `&&` stops the
app from starting, which looks like a crash loop. If it *partially* succeeds,
the app starts against a schema nobody has described. With a pre-deploy command
a failed migration is a **failed deployment** with the previous version still
serving — which is the outcome we want and the one we did not get on 2026-08-16.

---

## 4. Options considered and rejected

| Option | Why not |
|---|---|
| **Keep it manual, add a checklist** | The status quo plus paperwork. It already failed once, and the next failure lands on a path that writes money. |
| **Migrate from CI** (GitHub Actions job before deploy) | Requires the production `DATABASE_URL` as a CI secret, which widens who and what can reach production. It also splits release ordering across two systems that do not know about each other — CI cannot tell whether Railway's deploy actually went out. |
| **Docker `ENTRYPOINT` wrapper** | Identical to the startup approach; the problems in §3 are about *when* it runs, not *how* it is spelled. |
| **`postinstall` hook** | Runs at build time, when the production database should not be reachable at all. |

---

## 5. Proposed rollout, in three deploys

Each step is separately verifiable and the first two cannot change data. This
sequencing exists because §1 lists three things we could not determine from
here — and this finds them out rather than betting on them.

**Deploy 1 — config as code, no behaviour change.**
Add `railway.json` describing only what is already true (healthcheck path,
restart policy). If the deploy behaves identically, config-as-code is being read
and the Dockerfile question is answered by the build log. Nothing has changed
but the fact that the configuration is now reviewable.

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "deploy": {
    "healthcheckPath": "/api/health",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5
  }
}
```

**Deploy 2 — a read-only pre-deploy command.**

```json
"preDeployCommand": ["npx prisma migrate status"]
```

`migrate status` reads and never writes. It proves three things at once: the
pre-deploy container has the Prisma CLI, it has the migration files, and it can
reach the database. If any of that is wrong the deploy fails **with the previous
version still live and nothing altered** — which is precisely the safety
property being bought, demonstrated before it is relied on.

**Deploy 3 — the real thing.**

```json
"preDeployCommand": ["npx prisma migrate deploy"]
```

Verify with a deliberately trivial migration (add a nullable column to a table
nothing reads, then drop it in a later release), so the first real exercise is
one whose failure costs nothing.

---

## 6. The constraint this imposes, which is the important part

A pre-deploy command runs **while the previous version is still serving
traffic**. The old code meets the new schema, every time, for the length of a
deploy.

> **Every migration must be backward-compatible with the version currently
> running.** Additive and nullable is not a style preference here; it is a
> structural requirement of this release model.

Both migrations so far satisfy it by luck as much as design — one added nullable
columns, the other added a table. A destructive change (dropping a column,
renaming one, adding a `NOT NULL` without a default) needs **two releases**:

1. expand — add the new shape, write to both, deploy
2. contract — stop reading the old shape, deploy, *then* drop it

This is worth writing into the PR template alongside the config, because the
release model will not enforce it and a reviewer is the only thing that can.

### Smaller notes

- **Connections.** The pre-deploy container takes one Postgres connection for
  the duration. The pooler has fifteen shared across everything, so this is
  immaterial — but scripts run from a laptop should keep pinning
  `connection_limit=1`, as they already do.
- **Advisory lock.** `prisma migrate deploy` takes one, so even if two ran they
  would serialise. That is a backstop, not a reason to allow two.
- **The health endpoint is now load-bearing.** #29 made `/api/health` report the
  commit, and Railway polls that same path to decide whether a deploy is
  healthy. It must stay cheap and stay free of database calls, or a slow
  database turns into a failed deploy.

---

## 7. Correction to the staging, found while implementing

Stage 1 was described as *"config as code, no behaviour change"*. That is not
quite achievable, and the reason is worth recording rather than glossing:

> *"If the deployment does not have a healthcheck configured, Railway will mark
> the deployment as `Active` after starting the container."*

So adding `healthcheckPath` is inert **only if the dashboard already sets it**.
If it does not, this is a real change: deploys begin waiting for a `200` instead
of going active the moment the container starts. That change is desirable — it
is half of the release flow being built — but it is a change, and stage 1 cannot
both prove config-as-code is read and alter nothing.

What stage 1 does instead: it changes **nothing that can touch data**, and its
only possible effect is health gating we want anyway. The endpoint is public,
does no database work and answers in well under a second, so the 300-second
budget is not in question.

`restartPolicyType` is deliberately **omitted**. Railway's documented reference
does not state the default, so setting it could silently change behaviour to
something other than what the dashboard has today. It stays dashboard-owned
until someone reads the current value.

## 8. What I recommend

Adopt `railway.json` with `preDeployCommand`, rolled out in the three deploys
above, **before** the correction workflow ships. It is the only option that
makes a failed migration a failed deployment rather than a running application
with an undescribed schema.

The two decisions that need a human:

1. **Approve the approach** — this proposes, it does not implement.
2. **Decide who runs deploy 1**, since it needs to be confirmed against the
   Railway dashboard's current values, which I cannot read from here.

Until then the manual order stands, and it is written down in
`DEPLOYMENT-LOG.md` where the next person will find it.
