# Navigation Audit

**Date:** 2026-08-04 · **Scope:** whole application · **Status:** audit only, nothing implemented

Evidence is from source inspection at commit `01b4238`. Where a finding could not be
observed in a running signed-in session, it is marked **unverified** rather than asserted.

---

## 1. The finding that governs everything else

**The application has no router, and no in-app navigation touches browser history.**

The entire frontend contains three history operations:

| File | Line | Call |
|---|---|---|
| `lib/auth-context.tsx` | 121 | `location.replace('/api/auth/google')` |
| `App.tsx` | 186 | `history.replaceState({}, '', '/')` — OAuth success |
| `App.tsx` | 198 | `history.replaceState({}, '', '/')` — OAuth failure |

Navigation is a `viewState` string union in `App.tsx` plus `activeTab` strings inside
each view. No `pushState`. No route table. `package.json` has no router dependency.

Three consequences, all of which show up repeatedly below:

1. **Browser Back exits the application from every screen.** It never moves one level
   up — it leaves, because nothing in the app ever added an entry.
2. **Browser Back and in-app Back are not merely inconsistent — they are unrelated.**
   In-app Back moves within a hierarchy; browser Back abandons it.
3. **No screen is addressable.** A club, a session, a leaderboard cannot be linked,
   bookmarked, refreshed in place, or shared. Refresh always returns to the dashboard.

This is the root cause of most items in the table below, and it is why I would treat
"add a Back button to screen X" as the wrong unit of work.

---

## 2. Screen inventory

### Top level — `App.tsx` `viewState`

| Screen | Parent | Entry | Exits | Browser Back | In-app Back | Notes |
|---|---|---|---|---|---|---|
| `register` (Login) | — | app load when signed out | Sign in → `clubDashboard` | leaves app | none (root) | Correct: root needs no Back |
| `profileSetup` | `register` | forced when `!profileComplete` | completion → `clubDashboard` | leaves app | **none** | **Trap by design** — no skip, no sign-out |
| `clubDashboard` | — | after auth | select club → `clubDetail`; sign out | leaves app | none (root) | Correct root |
| `clubDetail` | `clubDashboard` | select a club | header ← → dashboard | leaves app | ✅ header `ArrowLeft` (1487) | In-app Back correct |
| `lobby` / `host` / `player` | — | `onProceedToLobby`, never called | — | leaves app | — | **Unreachable** (see §4) |

### Dashboard tabs — `ClubDashboardView`

| Tab | Entry | Exit | In-app Back | Priority |
|---|---|---|---|---|
| `myClubs` (default) | default | tab bar | n/a — root tab | — |
| `browse` | tab bar / empty-state CTA | tab bar only | ❌ none | Medium |
| `create` | tab bar / empty-state CTA | ✅ `ArrowLeft` (519) | ✅ | — |
| `requests` | tab bar, header bell | tab bar only | ❌ none | Low |
| `superuser` | tab bar (super-admin) | tab bar only | ❌ none | Low |
| Account Settings | header / bottom nav | modal close | ✅ | — |

### Club tabs — `ClubDetailView`

| Tab | In nav bar | Entry | Exit | Priority |
|---|---|---|---|---|
| `activeSession` | ✅ | nav | nav | — |
| `history` | ✅ | nav | nav | — |
| `leaderboard` | ✅ (if permitted) | nav | nav | — |
| `pendingApprovals` | ✅ (admin) | nav | nav | — |
| `pot` | ❌ **orphaned** | Coins button (1554), admin + pot enabled + no active session | nav bar only | **High** |
| `auditTrail` | ❌ **orphaned** | Settings modal (3185), owner/super-admin | nav bar only | **High** |

Nine modals: Link Player, Edit Session, Past Session, Stand Up, Buy In, Cashout, Club
Info, Profile, Settings. All have close affordances (14 close calls found).

---

## 3. Traps, dead ends and inconsistencies

**`profileSetup` is a genuine trap.** Reached automatically when `profileComplete` is
false (`App.tsx:109`). No Back, no skip, no sign-out. A user who cannot or will not
complete it has only one exit: closing the tab. Browser Back leaves the app entirely,
and returning re-enters the same screen. **Priority: Critical.**

**`pot` and `auditTrail` are orphaned tabs.** Both are entered from a contextual
control and neither appears in the nav bar, so while on them *no nav item shows as
selected* — the user is somewhere the navigation claims they are not. They can escape
via any nav item, so this is disorientation rather than entrapment. Note this was a
true dead end on desktop until `01b4238`, since no nav rendered at all above 768px.
**Priority: High.**

**`pot`'s entry condition is unstable.** The Coins button renders only when
`!activeSession && club.potEnabled` (1550–1554). Start a session while viewing the pot
and the way back in disappears. **Priority: Medium.**

**Browser Back is destructive everywhere.** Two levels deep in a club, the instinctive
gesture — especially on mobile, where edge-swipe Back is muscle memory — exits the
app. **Priority: High.**

**Refresh loses position.** Any reload returns to the dashboard regardless of where the
user was, because state lives only in memory. **Priority: Medium.**

---

## 4. Navigation that resets state or remounts

| Transition | Cost |
|---|---|
| `clubDetail` → `clubDashboard` | Dashboard remounts; since `735006d` the club list is served from cache, so this should now be instant — **unverified in production** |
| `clubDashboard` → `clubDetail` | `ClubDetailView` remounts and refetches **all eight** resources (club, roster, active session, history, leaderboard, pot log, pending changes, audit trail) from empty. The single largest remaining navigation cost |
| Any tab switch within a club | No refetch — tabs are conditional renders |
| Browser Back / refresh | Full application boot |

`ClubDetailView` is the obvious next consumer of the shared server-state layer, for the
same reason the dashboard was.

**Unreachable screens:** `lobby`, `host`, `player` are rendered by `App.tsx` but the only
entry point is `onProceedToLobby`, which `ClubDashboardView` accepts as a prop and never
calls. Dead navigation surface — consistent with the Virtual Table finding in `rc2`.

---

## 5. Is the hierarchy logical?

The intended hierarchy is shallow and sound:

```
Dashboard  →  Club  →  (tabs: Session · History · Ranks · Approvals · Pot · Audit)
```

Tabs are siblings, not depth, so "one logical level up" from anywhere inside a club is
the Dashboard — which is exactly what the header ← does. **No shortcut-to-dashboard
control is needed; the hierarchy is already only two levels deep.**

The problem is not the shape. It is that the hierarchy exists only in `viewState` and is
invisible to the browser, so the platform's own Back gesture cannot participate in it.

---

## 6. Recommendations, in priority order

| # | Recommendation | Priority | Size |
|---|---|---|---|
| 1 | Give `profileSetup` an exit — sign-out at minimum | **Critical** | Small |
| 2 | Surface `pot` and `auditTrail` in the nav bar, or give them a Back control and a selected state | High | Small |
| 3 | Make `viewState` + `activeTab` reflect into history via `pushState`, and handle `popstate`, so browser/edge-swipe Back moves one level up instead of exiting | High | Medium |
| 4 | Migrate `ClubDetailView`'s eight resources to `useResource` | High | Medium |
| 5 | Add a Back control to `browse`, `requests`, `superuser` for consistency with `create` | Medium | Small |
| 6 | Keep the `pot` entry point visible when a session is active | Medium | Small |
| 7 | Delete or revive the unreachable `lobby`/`host`/`player` screens | Low | Small |

**Recommendation 3 is the one that matters.** It converts browser Back from destructive
to useful, makes edge-swipe work on mobile, and survives refresh — and it subsumes most
of the individual "missing Back button" complaints, because the platform gesture starts
doing the job. It can be done without adding a router: push a state object on each
`viewState`/`activeTab` change and restore from `popstate`.

It also bears directly on the open Google-login Back issue: once the app owns history
entries, the OAuth entry is no longer the only thing in the stack.

---

## 7. Verification status

| Finding | Confidence |
|---|---|
| Three history calls; no router; no `pushState` | ✅ Verified — source + live bundle |
| `profileSetup` has no exit | ✅ Verified — source |
| `pot` / `auditTrail` orphaned from nav | ✅ Verified — source |
| `lobby`/`host`/`player` unreachable | ✅ Verified — `onProceedToLobby` never called |
| `ClubDetailView` refetches 8 resources on entry | ✅ Verified — source |
| Dashboard now instant on Back | ❌ Deployed, behaviour not verified |
| Desktop nav renders at ≥768px | ⚠️ Verified locally only |
| Perceived speed of each transition | ❌ Not measured — needs a signed-in session |
