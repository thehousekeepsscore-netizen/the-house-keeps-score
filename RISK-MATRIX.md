# Risk matrix

**Updated:** 2026-08-05 · **Branch:** `engineering-audit`
**Companion to:** [ENGINEERING-AUDIT.md](ENGINEERING-AUDIT.md)

Living document. Add a row when something is found; update the row when it
ships. **Severity** is how bad it is if it happens. **Likelihood** is how often
the conditions occur. **User impact** is what the person actually experiences.

---

## Fixed

| Issue | Severity | Likelihood | User impact | Fixed |
|---|---|---|---|---|
| Every member's email on `GET /clubs` to any account | Critical | High | High | ✅ `3416d36` |
| Non-members could read any club's live table, history, leaderboard | Critical | High | High | ✅ `3416d36` |
| Socket survives sign-out with previous identity + rooms | Critical | Medium | High | ✅ `9f913bf` |
| Any account could join any club's socket room | Critical | Medium | High | ✅ `f3c7101` |
| OAuth refresh cookie scoped to the API host — Google sign-ins never persisted | High | High | High | ✅ (earlier) |
| No rate limit outside `/auth`; `/refresh` unlimited | High | Medium | Medium | ✅ `703d8d3` |
| No graceful shutdown — requests severed on every redeploy | High | High | Medium | ✅ `83fe059` |
| No error boundary — one render throw blanks the app | High | Medium | High | ✅ `deec132` |
| Client mistakes (bad JSON, oversized body) reported as `500` | High | Low | Low | ✅ `703d8d3` |
| Settle refused with no usable reason ("check your inputs") | High | Medium | High | ✅ `2d70ded` |
| Duplicate submissions created ~20 rows from one frozen screen | High | High | High | ✅ (earlier) |
| Failed rollback resurrected state a socket event had moved past | Medium | Medium | Medium | ✅ `7a39f79` |
| No security headers; unbounded request body | Medium | Low | Low | ✅ `703d8d3` |
| Forced 7 refetches on every club open, defeating the cache | Medium | High | Medium | ✅ `1e2399d` |
| Club held in local state, drifting from the cache | Medium | Medium | Medium | ✅ `1e2399d` |
| Single 650 kB bundle, no code splitting | Medium | High | Medium | ✅ `3de89d3` |
| Approve/reject rows lingered a full round trip | Low | High | Medium | ✅ `cf5225c` |
| 3 unused web dependencies | Low | — | None | ✅ `081ed14` |
| 2 icon-only buttons unlabelled for screen readers | Low | Medium | Medium | ✅ `081ed14` |
| Auth context value identity churn | Low | High | Low | ✅ `686cd5a` |

## Open

| Issue | Severity | Likelihood | User impact | Status |
|---|---|---|---|---|
| `JWT_ACCESS_SECRET` + Supabase password not rotated after exposure | **High** | Low | High | ⏳ needs you — I cannot rotate credentials |
| Modals have no focus trap, no `role="dialog"`, no Escape-to-close | Medium | High | **High for keyboard/AT users** | ⏳ next |
| No structured logging, request ids, or error reporting | Medium | High | Low (operator impact) | ⏳ |
| `ClubDetailView.tsx` is 4,403 lines | Medium | High | None (velocity) | ⏳ |
| Socket.IO single-node — rooms are in-process | Medium | Low | High if it happens | ⏳ blocks horizontal scale |
| Parked Virtual Table code depends on removed Firestore integration | Medium | — | None | ⏳ **your decision** |
| `GET /clubs` unpaginated | Low | Medium | Medium at scale | ⏳ |
| Unmounted `sessions.routes.ts` has no membership checks | Low | Low | Critical *if ever mounted* | ⏳ audit before enabling |
| Web workspace has no CI running the new test suite | Medium | High | None (safety net) | ⏳ |

---

## Frontend audit — what this pass covered

| Area | Verdict |
|---|---|
| Error boundaries | ❌ none existed → ✅ per-route, 9 tests |
| Suspense / lazy loading | ❌ none existed → ✅ 3 routes split, −22.5% gzip |
| Bundle splitting | ✅ measured 649.94 → 453.03 kB |
| Dead code | ✅ 3 unrendered imports removed; 2,510 lines parked (§ open) |
| Optimistic updates | ✅ audited, interference bug found and fixed |
| Cache consistency | ✅ versioned entries, 8 tests |
| Context usage | ✅ both providers now memoise their value |
| Memory leaks / listeners | ✅ verified — every timer and listener has a cleanup |
| Testing gaps | ✅ runner added, 22 tests where there were 5 |
| State duplication | ✅ the one real case (`club`) fixed in `1e2399d` |
| Accessibility — labels | ✅ 2 real issues fixed (scan initially over-reported 10) |
| **Accessibility — focus/keyboard** | ❌ **not done** — see open |
| **Re-render profiling** | ❌ **not done** — needs a running app + DevTools profiler |
| **Component decomposition** | ❌ **not done** |
| **Responsive / animation review** | ❌ **not done** |

---

## Note on measurement honesty

Two rows above exist because a first attempt was wrong and got caught:

- The icon-button scan reported **10** issues; **2** were real. It stripped JSX
  expressions, so every `{loading ? … : …}` submit button looked empty.
- The first graceful shutdown exited **1** while printing success, because
  `io.close()` also closes the attached HTTP server. Found by signalling a real
  process, not by reading the diff.

Re-render profiling is listed as not done rather than estimated for the same
reason. Counting `useMemo` calls is not a measurement of anything.
