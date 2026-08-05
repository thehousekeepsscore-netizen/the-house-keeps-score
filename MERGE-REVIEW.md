# Merge review — `engineering-audit` → `main`

**Date:** 2026-08-05 · **Commits:** 13 · **Base:** `main` @ `a291cdd`
**Companions:** [ENGINEERING-AUDIT.md](ENGINEERING-AUDIT.md) · [RISK-MATRIX.md](RISK-MATRIX.md)

---

## 1. Production behaviour that changed

| Change | Who notices | Visible how |
|---|---|---|
| Socket closes on any change of signed-in identity | Anyone signing out and in again in one tab | Live updates reconnect; previously they carried the old session |
| API-wide rate limit, 300/min per client | Only a client exceeding it | `429` with a JSON message |
| `/auth/refresh` limited to 60 per 15 min per client | Only above ~60 refreshes | `429` |
| Request bodies capped at 64kb | Nobody in normal use | `413` instead of `500` |
| Malformed JSON | Anyone sending it | `400` instead of `500` |
| Security headers on every response | Nobody functionally | `nosniff`, frame-deny, no `X-Powered-By` |
| SIGTERM drains instead of killing | Every redeploy | Fewer severed requests during deploys |
| Render errors show a fallback | Anyone hitting one | A message and a retry, not a white screen |
| Route chunks load on demand | Every user | Faster first paint; a brief skeleton on first navigation to a screen |
| Contested optimistic rollback refetches | Rare concurrent failure | Correct data instead of resurrected stale data |

**Not changed:** no business logic, no settlement maths, no money handling, no
auth token lifetimes, no cookie settings.

## 2. API contract changes

**None on this branch.** No route added, removed, renamed, or changed shape.

Status codes changed for two malformed-input cases (`500` → `400`/`413`), which
is a correction, not a contract change — no client depended on those.

> The projection split (`GET /clubs` public vs member) was **`3416d36` on
> `main`**, already deployed. It is not part of this merge.

## 3. New environment variables

**None.** `apps/api/src/env.ts` is unchanged.

## 4. Migrations required

**None.** `apps/api/prisma/` is untouched — no schema change, no migration.

## 5. Manual deployment steps

**None required.** Standard push-to-deploy.

Two follow-ups that are *not* blockers but should be done:

1. **Rotate `JWT_ACCESS_SECRET` and the Supabase password.** Outstanding from
   earlier sessions; unrelated to this branch but still open.
2. **Confirm Railway's stop timeout is ≥ 10s.** The new shutdown backstop
   force-exits at 10s. If the platform kills sooner, graceful shutdown is
   truncated — it would still be no worse than today, but the benefit is lost.

## 6. Backwards-incompatible changes

**One, and it is deliberate:** a client whose bundle predates this deploy keeps
a socket open across sign-out. That client is served from Vercel and replaced on
the same deploy, so the window is a page load.

Nothing else is incompatible. The `firebase` dependency and 4,417 lines removed
in `b15aa0a` were unreachable — verified by a byte-identical bundle before and
after.

---

## 7. Merge checklist

| # | Item | Status |
|---|---|---|
| 1 | API unit tests | ✅ 1,097 passing |
| 2 | API integration tests | ✅ 71 passing (8 files) |
| 3 | Web tests | ✅ 22 passing (3 files) |
| 4 | TypeScript — API and web | ✅ clean, `npm run typecheck` |
| 5 | Production build | ✅ `npm run build` succeeds |
| 6 | Lint | ⚠️ **no linter configured** — see §8 |
| 7 | Bundle size report | ✅ 649.94 → 453.09 kB (186.49 → 144.47 kB gzip, −22.5%) |
| 8 | `npm ci` — lockfile agrees with manifests | ✅ verified locally |
| 9 | Security audit | ✅ see `ENGINEERING-AUDIT.md`; 4 Critical/High fixed |
| 10 | CI configured | ✅ `.github/workflows/ci.yml`, every step run locally first |
| 11 | Deletion is revertible | ✅ `b15aa0a` is self-contained; `git revert` restores all 10 files and the dependency |
| 12 | No migrations | ✅ `prisma/` untouched |
| 13 | No new env vars | ✅ `env.ts` untouched |
| 14 | **Console errors in a running app** | ❌ **not verified** — see §8 |
| 15 | **CI green on a real run** | ❌ **not verified** — no run exists until this is pushed as a PR |
| 16 | **Manual smoke test** | ❌ **not done** — see §8 |

## 8. What I could not verify, and what you should do before merging

Three checklist items are honestly unchecked.

**No linter is configured.** There is no ESLint config in either workspace, so
"lint clean" cannot be asserted. Adding one is a change with its own diff and
does not belong in a merge review; it is on the roadmap.

**No console-error check and no smoke test.** Both need the app running and
signed in against a real database. I cannot sign in. This is the one part of the
checklist that requires you, and it is the part most likely to catch something,
because every change in §1 that a user would notice is a change I verified by
test rather than by using the app.

**Suggested smoke test**, aimed at exactly what this branch touched:

1. Sign in, open a club, confirm the table loads and buy-ins are live.
2. Sign out, sign in as a **different** account, open a club — confirm live
   updates work and no data from the first account appears. *(This is the
   Critical fix; it is the single most important thing to check.)*
3. Navigate dashboard → club → back. Confirm the brief skeleton on first
   navigation, and no skeleton the second time.
4. Approve a buy-in; confirm the row disappears immediately.
5. Watch the browser console throughout for errors.
6. Redeploy the API while a club screen is open; confirm reconnection.

**CI has never run.** The workflow is correct as far as local execution can
show — every step was run on this machine — but a GitHub runner is a different
environment. Open this as a PR and let CI go green before merging, rather than
merging and trusting it.
