# Proposal: replace `viewState` navigation with a client-side router

**Date:** 2026-08-04 · **Status:** proposal only, nothing implemented
**Follows:** [NAVIGATION-AUDIT.md](NAVIGATION-AUDIT.md)

---

## Summary

**Recommendation: migrate to React Router, incrementally, in four shippable steps.**

The measured cost is **+13.25 kB gzipped** — and route-level code splitting is likely to
*recover more than that*, because the app currently ships as one 644 kB chunk.

---

## 1. What the current architecture is

| | |
|---|---|
| `App.tsx` | 668 lines, 7 `viewState` branches |
| Real screens | `register`, `profileSetup`, `clubDashboard`, `clubDetail` |
| Dead screens | `lobby`, `host`, `player` — unreachable (audit §4) |
| Dashboard tabs | 5 (`myClubs`, `browse`, `create`, `requests`, `superuser`) |
| Club tabs | 6 (`activeSession`, `history`, `leaderboard`, `pendingApprovals`, `pot`, `auditTrail`) |
| Router dependency | none |
| History integration | none — 3 `replaceState`/`replace` calls, all in the OAuth flow |

Two facts make migration cheaper than it looks:

**`ClubDetailView` already works from an id.** It takes a `club` prop but only reads
`initialClub.id`, refetching via `getClub(id)` (lines 563, 568, 572). So `/clubs/:clubId`
needs no restructuring of the component.

**The two hardest prerequisites are already done.** Deep links need an SPA fallback —
shipped in `rc5`. URL-driven screens need data fetched by id without a flash — that is
exactly what `useResource` (`a658c23`) provides.

---

## 2. Benefits vs today

| Capability | `viewState` today | Custom `pushState` | React Router |
|---|---|---|---|
| Browser Back | ❌ exits the app | ✅ | ✅ |
| Forward | ❌ | ⚠️ manual | ✅ |
| Deep linking | ❌ | ⚠️ hand-rolled parsing | ✅ |
| Refresh persistence | ❌ always resets to dashboard | ✅ | ✅ |
| Bookmarking / sharing a club | ❌ | ⚠️ | ✅ |
| Navigation guards (auth, profile) | ⚠️ ad hoc in `App.tsx` | ⚠️ ad hoc | ✅ route guards |
| URL-driven state | ❌ | ⚠️ | ✅ params + search params |
| Mobile edge-swipe Back | ❌ exits the app | ✅ | ✅ |
| Scroll restoration | ❌ | ❌ build it | ✅ built in |
| Code splitting | ❌ one chunk | ❌ | ✅ natural per-route boundaries |
| Maintenance burden | grows | **ours** | library's |

The custom-`pushState` column is the honest cost of the approach I suggested in the
audit: roughly 80 lines to start, then scroll restoration, forward handling, relative
navigation and blocking get rebuilt one bug at a time.

---

## 3. Impact

**Measured** — clean clone, `react-router-dom@7.18.2`, `BrowserRouter`/`Routes`/`Route` wired:

```
baseline            644.89 kB │ gzip 180.87 kB
with react-router   682.06 kB │ gzip 194.12 kB
delta                +37.17 kB │ gzip  +13.25 kB   (+7.3%)
```

Vite already warns the bundle exceeds 500 kB. Splitting `ClubDetailView` (3,938 lines)
and `ClubDashboardView` (~1,100 lines) into route-level lazy chunks should cut first-load
well below the current figure, so the net effect on perceived performance is plausibly
**positive**. That is a projection, not a measurement.

**Files affected — about five:**

| File | Change | Size |
|---|---|---|
| `main.tsx` | wrap in `BrowserRouter` | trivial |
| `App.tsx` | `viewState` switch → route layout | **major** |
| `ClubDashboardView.tsx` | `onSelectClub`/`onSignOut` → `useNavigate` | small |
| `ClubDetailView.tsx` | `club` prop → `useParams` + `useResource` | small |
| `LoginPage.tsx` | redirect on success | trivial |

**Runtime performance:** neutral. React Router's matcher is not a bottleneck at this
scale. Route-level `React.lazy` is the real lever.

---

## 4. Migration strategy — four shippable steps

Each step is independently deployable and reversible. `viewState` and routes coexist
throughout; nothing is a big-bang cutover.

**Step 1 — Mount the router, change nothing.** Wrap `<App/>` in `BrowserRouter` with a
single `/*` catch-all. Zero behaviour change; proves the SPA fallback and the build.

**Step 2 — Top-level screens become routes.**
```
/                     dashboard (auth guard)
/setup                profile setup
/clubs/:clubId        club detail
/oauth/callback       OAuth landing (replaces the effect in App.tsx:186)
/login                signed-out
```
`viewState` loses `register`/`profileSetup`/`clubDashboard`/`clubDetail`; the three dead
screens keep theirs until deleted. **This step alone fixes** browser Back, edge-swipe,
refresh persistence, deep links, and the `profileSetup` trap — the trap becomes a guard
with a sign-out escape rather than a state you cannot leave.

**Step 3 — Tabs become nested routes.**
```
/clubs/:clubId/session · /history · /leaderboard · /approvals · /pot · /audit
```
`pot` and `auditTrail` stop being orphans by construction: they get URLs and selected
states, so the audit's High-priority item resolves as a side effect rather than a patch.

**Step 4 — Code splitting.** `React.lazy` per route, then re-measure the bundle.

---

## 5. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Entering a club renders a skeleton where the object used to be passed directly | **Medium** | Seed the cache from the dashboard list via `cache.update('club:'+id, …)` before navigating — the `update()` API exists for this |
| `App.tsx` is 668 lines of interwoven state; splitting it may disturb the table-game props | Medium | Steps 2–3 touch only the real screens; the dead ones are untouched until deleted |
| Deep links to a club the user cannot access | Medium | Route guard returning a 403 view — better than today, where the URL does not exist |
| Auth-state races on first paint | Low | `authStatus === 'loading'` already exists; guards await it |
| Bundle growth | Low | Measured at 13 kB; Step 4 targets a net reduction |
| Regression in a production app with live users | **Medium** | Four independent deploys, each verifiable; no step requires the next |

---

## 6. Alternatives considered

**Keep evolving `viewState`.** Rejected. Every audit finding traces back to navigation
not existing as a concept. Deep linking and refresh persistence cannot be added at all.

**Custom `pushState` layer.** ~80 lines, no dependency, and it does fix Back. Rejected
because it delivers two of the ten capabilities above and we maintain it. The 13 kB buys
scroll restoration, guards, relative navigation and code splitting we would otherwise
write ourselves.

**TanStack Router.** Better type safety and first-class search-param handling. Rejected
for now: larger conceptual surface for a solo maintainer, and React Router is what most
future reference material assumes. Reconsider if route-level type safety becomes painful.

---

## 7. Recommendation

**Migrate to React Router.** Justification, in order of weight:

1. The app already needs three router capabilities it cannot currently provide —
   shareable club links, refresh persistence, and a working Back gesture on mobile.
2. The expensive prerequisites are already paid for: SPA fallback (`rc5`) and cached
   fetch-by-id (`a658c23`).
3. It resolves audit items 1, 2, 3 and 5 as consequences of the architecture rather than
   as four separate patches.
4. Measured cost is 13 kB gzipped, with a credible path to a net reduction via splitting.
5. Migration is genuinely incremental — four deploys, each reversible.

**Sequencing:** do this *after* the dashboard cache is behaviourally verified in
production. That verification is the evidence that the cache layer works, and Step 2
depends on it for club-by-id loading.

**Categorisation:** Architecture improvement. The `profileSetup` trap is a production
bug fix that Step 2 delivers; the orphaned tabs are UX polish that Step 3 delivers.

---

## 8. Verification status

| Claim | Confidence |
|---|---|
| Bundle delta +13.25 kB gzipped | ✅ Measured — clean clone, real build |
| `ClubDetailView` works from an id alone | ✅ Verified — source |
| SPA fallback already deployed | ✅ Verified — `/oauth/callback` returns 200 in production |
| No router dependency today | ✅ Verified — `package.json` |
| Code splitting yields a net reduction | ❌ Projection, not measured |
| Migration effort estimates | ⚠️ Reasoned from file sizes, not from doing it |
