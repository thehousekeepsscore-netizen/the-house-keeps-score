# The House Keeps Score — Current Architecture

Documentation of the implementation **as it stands**. No proposals, no
refactors — this describes what is there today so it can be understood before
anything is changed.

---

## 0. The two things you must know first

**There is no router.** No `react-router`, no history API beyond one OAuth
special case. The entire application is a single `viewState` string in
`App.tsx` and a chain of conditional renders. Nothing has a URL. Refreshing the
page always returns you to the club dashboard (or login).

**There are two disjoint applications in this codebase.**

| | Club Scorekeeper | Local Table Game |
|---|---|---|
| Purpose | tracks money: buy-ins, cash-outs, settlement, history | deals cards on a shared screen |
| Backing | Express + Postgres + Socket.IO | none — pure client state |
| Sync | Socket.IO rooms | `BroadcastChannel` between browser tabs |
| Persistence | full | none; refresh loses everything |
| Screens | `clubDashboard`, `clubDetail` | `lobby`, `host`, `player` |

They share only the auth shell and the visual language. Everything this
session's work touched — settlement, pot, history — lives entirely in the first.

**Dead code:** `VirtualTableView.tsx` (1,158 lines) and `LazyDealerConsole.tsx`
(1,352 lines) are imported by **nothing**. They are unreachable from any screen.

---

## 1. Screen Inventory

"Screen" means a value of `viewState` in `App.tsx`. All are mounted/unmounted by
conditional render, none have routes.

### `register` — Login / Register
- **Purpose** — email+password auth, Google OAuth entry.
- **Route** — none (default when unauthenticated).
- **Parent** — none (root).
- **Component** — `LoginPage`.
- **Children** — `BrandLogo`, `ChipCardDecoration` (full-strength hero variant).
- **Entry** — app start with no valid refresh cookie; after `logout()`.
- **Exit** — successful login → `profileSetup` (if `!profileComplete`) else
  `clubDashboard`. Google → full page redirect to `/api/auth/google`.

### `profileSetup` — Complete your profile
- **Purpose** — forced onboarding gate; captures first name, last name,
  username, **mobile number (required)**, optional avatar.
- **Route** — none.
- **Parent** — `register`.
- **Component** — `ProfileSetupView`.
- **Entry** — any authenticated user whose `profileComplete` is false.
- **Exit** — `PATCH /auth/me` succeeds → `clubDashboard`. Sign out → `register`.
- **Note** — the seed does not populate these fields, so every seeded account
  hits this gate on first login.

### `clubDashboard` — Your Poker Clubs
- **Purpose** — club list, browse/join, create club, join requests, superuser tools.
- **Route** — none. **Parent** — `register`/`profileSetup`.
- **Component** — `ClubDashboardView`.
- **Internal tabs** (`activeTab` local state): `myClubs`, `browse`, `create`,
  `requests`, `superuser` (superadmin only).
- **Children** — `BrandLogo`, `InfoHint`, `AccountSettingsModal`.
- **Entry** — post-login; "Back to Clubs List" from `clubDetail`.
- **Exit** — select a club → `clubDetail`; "proceed to lobby" → `lobby`;
  sign out → `register`.

### `clubDetail` — Club Table (the main screen)
- **Purpose** — everything about one club: the live night, history, leaderboard,
  approvals, audit trail, pot.
- **Route** — none. **Parent** — `clubDashboard`.
- **Component** — `ClubDetailView` (~3,860 lines — the largest file in the app).
- **Internal tabs**: `activeSession`, `history`, `leaderboard`,
  `pendingApprovals` (admin), `auditTrail` (owner/superadmin), `pot` (admin,
  pot enabled).
- **Entry** — "Enter Club Table" from dashboard. Requires a `Club` object passed
  as a prop — it cannot be entered directly.
- **Exit** — back arrow → `clubDashboard`.

### `lobby` — Local Table Lobby
- **Purpose** — create or join a **client-only** card table.
- **Component** — `LobbyView`. Tabs: `landing`, `create`, `join`.
- **Entry** — from `clubDashboard`. **Exit** — `host` or `player`.

### `host` — Dealer / Display
- **Purpose** — deals cards, reveals flop/turn/river, rotates dealer, drag-drop seats.
- **Component** — `MergedHostDisplayView`. **Children** — `PlayingCard`, `ToastContainer`.
- **Entry** — `lobby` → create table. **Exit** — leave → `lobby`.

### `player` — Player Hand View
- **Purpose** — one seat's private hole cards, peek (hold/toggle), rabbit hunt.
- **Component** — `PlayerView`. **Children** — `PlayingCard`.
- **Entry** — `lobby` → join table. **Exit** — leave → `lobby`.

### Splash
Not a `viewState` — `SplashScreen` renders whenever `authStatus === 'loading'`,
i.e. during the initial refresh-token exchange.

---

## 2. Screen Flow

```
(app start)
   │
   ├── authStatus === 'loading' ────────────► SplashScreen
   │
   ├── unauthenticated ────────────────────► register (LoginPage)
   │                                            │
   │                                            ├── login / register ──┐
   │                                            └── Google OAuth ──────┤
   │                                                (redirect /oauth/callback)
   │                                                                   │
   └── authenticated ◄────────────────────────────────────────────────┘
            │
            ├── !profileComplete ──────────► profileSetup
            │                                    │ (save)
            │                                    ▼
            └────────────────────────────► clubDashboard
                                                 │
                    ┌────────────────────────────┼──────────────────────┐
                    │                            │                      │
              (select club)              (proceed to lobby)        (sign out)
                    │                            │                      │
                    ▼                            ▼                      ▼
              clubDetail                       lobby                register
                    │                            │
                    │ (back)                     ├── create ──► host ──┐
                    └──────► clubDashboard       └── join ────► player ┤
                                                          (leave) ◄────┘
                                                              │
                                                            lobby
```

### Modal navigation inside `clubDetail`
Modals are booleans, not routes. None are URL-addressable; all close on
backdrop click or ✕.

```
clubDetail
├── tab: activeSession
│   ├── modal: Buy In                  (+ FAB / Quick Action)
│   ├── modal: Stand Up                (player cash-out request)
│   ├── modal: CASHOUT   ◄── settle the live night (admin)
│   └── modal: Club Settings           (admin; rules are read-only)
├── tab: history
│   ├── modal: Record a past night     (owner only)
│   ├── modal: Edit Session            (admin; expand a row first)
│   └── modal: Delete Session confirm
├── tab: leaderboard                   (hidden unless admin or club opts in)
├── tab: pendingApprovals              (admin)
├── tab: auditTrail                    (owner / superadmin)
├── tab: pot                           (admin, pot enabled)
└── modal: Account Settings            (via Profile nav)
```

---

## 3. Screen Lifecycle

### `LoginPage`
- **Receives** — optional `onBack`. **Global** — `useAuth()`.
- **APIs** — `POST /auth/login`, `POST /auth/register`; Google is a full page
  navigation to `/api/auth/google`.
- **Local state** — email, password, mode, error, submitting.
- **Calculations** — none.

### `ProfileSetupView`
- **Receives** — nothing; reads `useAuth()`.
- **APIs** — `PATCH /auth/me`.
- **Local state** — form fields, `cameraStream` (getUserMedia for avatar capture).
- **Validation** — native HTML `required` on first/last name, username, **phone**.

### `ClubDashboardView`
- **Receives** — `currentUser`, `playerAvatarUrl`, `onSelectClub`,
  `onProceedToLobby`, `onSignOut`.
- **APIs** — `GET /clubs`, `GET /clubs/join-requests`, `POST /clubs`,
  `POST /clubs/:id/join-request`, join-request decisions, superuser join.
- **Local state** — `rawClubs`, `requests`, `activeTab`, the whole create-club
  form (`buyInMode`, rake fields, devaluation…), `expandedClubMembersId`.
- **Calculations** — client-side derivation of member/admin counts for display.

### `ClubDetailView` — the important one
- **Receives** — `club` (initial snapshot), `currentUser`, `playerAvatarUrl`,
  `onBackToDashboard`.
- **Global** — `useAuth()` indirectly via `currentUser` prop; `getSocket()`.
- **Data sources** — seven independent refresh functions, each its own
  `useCallback` and its own endpoint:

  | refresher | endpoint |
  |---|---|
  | `refreshClub` | `GET /clubs/:id` |
  | `refreshRoster` | `GET /clubs/:id/roster` |
  | `refreshActiveSession` | `GET /clubs/:id/offline-sessions/active` + buy-in requests |
  | `refreshHistory` | `GET /clubs/:id/history` |
  | `refreshLeaderboard` | `GET /clubs/:id/leaderboard` (403 → empty) |
  | `refreshPotLog` | `GET /clubs/:id/pot-log` |
  | `refreshPendingChanges` | `GET /clubs/:id/pending-changes` |
  | `refreshAuditTrail` | `GET /clubs/:id/audit-log` + `/deleted-sessions` |

- **Initial load** — all seven fire in one `useEffect` keyed on `club.id`.
- **Live sync** — one `useEffect` joins the socket room `club:<id>` and
  subscribes to **11 events**; each handler re-fetches the affected slice rather
  than trusting the payload:

  `club:session-started`, `club:buyin-requested`, `club:buyin-decided`,
  `club:sitin-requested`, `club:sitin-decided`, `club:cashout-requested`,
  `club:cashout-decided`, `club:session-settled`, `club:history-updated`,
  `club:pending-request`, `club:pending-request-decided`

- **Calculations performed locally** — see §8.

---

## 4. Component Hierarchy

```
main.tsx
└── AuthProvider                       (React context; the only global store)
    └── App                            (viewState switch; no router)
        ├── SplashScreen               (authStatus === 'loading')
        ├── ChipCardDecoration         (ambient watermark, all non-login screens)
        │
        ├── LoginPage
        │   ├── BrandLogo
        │   └── ChipCardDecoration (hero)
        │
        ├── ProfileSetupView
        │
        ├── ClubDashboardView
        │   ├── BrandLogo
        │   ├── InfoHint ×n
        │   └── AccountSettingsModal
        │
        ├── ClubDetailView                    ◄── the god component
        │   ├── InfoHint ×n
        │   ├── PokerTableRing                (oval table + seats)
        │   ├── ToastContainer
        │   ├── AccountSettingsModal
        │   ├── SettlementPreview             (shared by all 3 settle flows)
        │   └── SettlementConfirm             (shared last-look panel)
        │
        ├── LobbyView                          (local game)
        ├── MergedHostDisplayView
        │   ├── PlayingCard ×n
        │   └── ToastContainer
        └── PlayerView
            └── PlayingCard ×n

NOT MOUNTED ANYWHERE:
    VirtualTableView   (1,158 lines)  ── imports PlayingCard
    LazyDealerConsole  (1,352 lines)  ── imports PlayingCard
```

### `ClubDetailView` internal tree

```
ClubDetailView
├── Header            club name · code · role badge · currency badge · InfoHint
├── Tab content
│   ├── activeSession
│   │   ├── session banner + Request-to-sit-in / Stand-up button
│   │   ├── Max buy-in card (InfoHint)
│   │   ├── PokerTableRing → seat cards (name + banked chips)
│   │   ├── My Buy-Ins   (player view: own requests only)
│   │   ├── Approvals    (admin: pending buy-ins)
│   │   └── Cash-outs to confirm (admin)
│   ├── history
│   │   ├── header: currency toggle · Record a past night · completed count
│   │   └── session cards (collapsed: your own net · expanded: per-player
│   │       breakdown + edit/delete controls)
│   ├── leaderboard   → rank · player · profit/loss  (desktop table + mobile cards)
│   ├── pendingApprovals → change requests with diffs
│   ├── auditTrail    → audit log + soft-deleted sessions (restore)
│   └── pot           → club pot balance + ledger
├── Bottom nav        session · history · ranks · approve · cashout · profile
└── Modals
    ├── BuyIn ── mini table picker · amount presets · ceiling guard
    ├── StandUp ── declare chips
    ├── CASHOUT ─────────┐
    ├── Record past night ├─► all three: inputs → tally → Calculate
    ├── Edit Session ─────┘        → SettlementPreview → SettlementConfirm
    ├── Club Settings ── rules in a disabled fieldset (immutable)
    ├── Delete Session confirm
    └── AccountSettingsModal
```

---

## 5. Shared Components

| Component | Used by | Props | Responsibility | Type |
|---|---|---|---|---|
| `SettlementPreview` | ClubDetailView ×3 flows | `result`, `club`, `formatAmount`, `formatSigned`, `potDisplay`, `mismatchAcknowledgement?` | Renders a `SettlementResult`: per-player nets + deductions, totals, house take, engine steps, mismatch ack, pot | Presentation |
| `SettlementConfirm` | ClubDetailView ×3 flows | `result`, `title`, `warning`, `formatSigned` | Last-look panel restating final figures | Presentation |
| `PokerTableRing` | ClubDetailView | seats, labels, highlight | Oval table with seats positioned around it | Presentation |
| `InfoHint` | ClubDetailView, ClubDashboardView, AccountSettingsModal | `children` | Tap-to-reveal ⓘ popover — the app's preferred alternative to on-screen prose | Presentation |
| `PlayingCard` | Host, Player, + the two dead views | card, size, facedown | Renders one card | Presentation |
| `ToastContainer` | ClubDetailView, MergedHostDisplayView | `toasts`, `onDismiss` | Renders the toast stack | Presentation |
| `BrandLogo` | LoginPage, ClubDashboardView | size variants | Wordmark | Presentation |
| `ChipCardDecoration` | App, LoginPage | `variant: 'ambient' \| 'hero'` | Themed background motif | Presentation |
| `SplashScreen` | App | none | Boot state during token refresh | Presentation |
| `AccountSettingsModal` | ClubDashboardView, ClubDetailView | `onClose`, `club?`, `isClubAdmin`, `onOpenClubSettings` | Profile edit, theme, personal record (rank, biggest win/loss), club settings entry | **Mixed** — own API calls |

**Note:** toast state is implemented **twice** — `App.tsx` has its own
`toasts` + `addToast` for the local game, and `ClubDetailView` has a separate
`toasts` + `pushToast`. They share only `ToastContainer`.

---

## 6. State Management

### There is no store library
No Redux, Zustand, Jotai, or React Query. State is React `useState` plus one
context.

**Global (the only one): `AuthProvider`** — `apps/web/src/lib/auth-context.tsx`
- Holds `user: AppUser | null` and `status: 'loading' | 'authenticated' | 'unauthenticated'`.
- Exposes `login`, `register`, `logout`, `loginWithGoogle`, `exchangeOAuthCode`, `updateProfile`.
- On mount: `POST /auth/refresh` → on success `GET /auth/me`; on failure marks
  unauthenticated.

**Module-level singletons (not React state):**
- `api-client.ts` — the access token lives in a module variable, never in
  `localStorage`. A single-flight `refreshPromise` prevents a 401 stampede.
- `socket.ts` — one shared `Socket` for the whole app; components join/leave
  rooms rather than opening their own connections.

**Screen state** — `App.tsx` owns `viewState`, `selectedClub`, and the entire
local card game (deck, seats, boards, dealer, street, hand number).

**Derived state** in `ClubDetailView` (recomputed every render, not memoised
unless noted):
- `settlementUids` — `useMemo`; union of seated players and confirmed cash-outs.
  **The union is the whole point** — a stood-up player leaves `activePlayerUids`
  but still settles.
- `preview` / `pastPreview` / `editPreview` — `computeSettlement(...)` run
  client-side for live display.
- `canSeeLeaderboard`, `isAdmin`, `isOwner`, `isSuperUser`, `activeSessionBuyIns`,
  `largestActiveBank`, `buyInCeiling`, `confirmedCashOutByUid`,
  `normalizedSessions`, `currencyToggle`.

### Data flow

```
                      ┌──────────────────────────┐
                      │  AuthProvider (context)  │
                      │  user · status           │
                      └───────────┬──────────────┘
                                  │ currentUser prop
                                  ▼
   ┌──────────┐   props    ┌──────────────┐
   │   App    ├───────────►│ClubDetailView│
   │ viewState│            └──┬────────┬──┘
   └──────────┘               │        │
                    refreshX()│        │ user action
                              ▼        ▼
                        ┌───────────────────┐
                        │  lib/*-api.ts     │
                        │  apiFetch()       │──── Bearer token (module var)
                        └─────────┬─────────┘     httpOnly refresh cookie
                                  │ /api/*  (relative — Vite proxy in dev)
                                  ▼
                        ┌───────────────────┐
                        │  Express API      │
                        │  service → Prisma │
                        └─────────┬─────────┘
                                  │ emitToClub(clubId, event)
                                  ▼
                        ┌───────────────────┐
                        │ Socket.IO room    │
                        │   club:<id>       │
                        └─────────┬─────────┘
                                  │ event
                                  ▼
                        handler → refreshX()  ← re-fetch, never trust payload
```

**The loop is deliberate:** a mutation returns, the server emits, every client
in the room (including the one that acted) re-fetches the affected slice. The
socket payload carries identifiers, not state.

---

## 6a. Authentication (single-writer state machine)

`AuthProvider` (`lib/auth-context.tsx`) is the **sole owner** of authentication
state. Nothing else may establish a session; consumers read `user`, `status` and
`phase` and never write them.

```
initialising ─┬─ oauth-exchange ─┬─ authenticated
              │                  └─ (failure) ─┐
              └──────────────────── refreshing ─┴─ authenticated
                                                 └─ unauthenticated
```

Exactly one path reaches a terminal state. `status` ('loading' | 'authenticated'
| 'unauthenticated') is derived from `phase` and preserves the older contract.

**Why it is built this way.** It previously was not. The refresh bootstrap lived
in `AuthProvider` while the `/oauth/callback` code exchange lived in an
independent effect in `App.tsx`. Both wrote the same state, and on the callback
page both ran at once: the exchange established a session, while the refresh —
which had no cookie yet — 401'd and its `catch` cleared the user, the phase and
the access token. Whichever finished last won. Measured production latencies
were 0.37–0.60s for the refresh against 0.53–0.70s for the exchange: overlapping
ranges, so the outcome turned on network jitter. That is what produced
intermittent "I signed in but I'm on the login screen, it works if I retry".

Three invariants hold the fix in place:

1. **Single writer.** Every `setAccessToken` call lives in this file. The OAuth
   code is consumed inside the startup routine, not by a consumer.
2. **Sequential, not concurrent.** The refresh runs only if there is no code, or
   if the exchange failed. On success the routine returns before reaching it.
3. **Monotonic startup.** `markSignedOut()` refuses to clear a live session; only
   an explicit `logout()` may, via `markSignedOut(true)`. Even a future stray
   async failure cannot downgrade an established session.

A `startupRan` ref guards the routine against React StrictMode's development
double-invoke, which would otherwise consume the one-time OAuth code twice.

**Rule for future work:** anything needing authentication state consumes it from
this provider. New sign-in methods become new transitions inside this machine,
not new effects elsewhere.

## 7. Navigation Architecture

- **Routing library** — none.
- **Mechanism** — `viewState` string union in `App.tsx`, conditional rendering.
- **Nested routes** — none. Nesting is simulated by `activeTab` state inside
  `ClubDashboardView`, `ClubDetailView`, `LobbyView`, and the two dead views.
- **Modal navigation** — boolean state per modal. Not addressable, no history
  entry, back button does not close them.
- **Guards / protected routes** — no route guards. Protection is:
  1. `App.tsx` renders `LoginPage` when `authUser` is null;
  2. `!authUser.profileComplete` forces `profileSetup`;
  3. every club screen additionally requires its prop (`selectedClub`) to exist;
  4. **real** enforcement is server-side — `authenticate` middleware plus
     `assertClubAdmin` / `assertClubOwner` in the services. The UI hides
     controls; the API is what actually refuses.
- **Deep links** — none, with **one exception**: `/oauth/callback`. `App.tsx`
  reads `window.location.pathname` directly, extracts `?code`, calls
  `history.replaceState({}, '', '/')` to clean the URL, then exchanges the code.
- **Consequence** — no shareable URLs, no browser back/forward, a refresh always
  lands on the dashboard.

---

## 8. Business Logic

### Where it lives
- **`settlementEngine.ts` — exists twice**, byte-identical except comments:
  `apps/api/src/modules/offlineSessions/` (authoritative) and
  `apps/web/src/lib/` (preview only). A test asserts they stay identical.
- **Services** (`*.service.ts`) hold authorisation, persistence and the pot ledger.
- **Controllers** hold zod validation.

### Validation
| Rule | Enforced where |
|---|---|
| Two-player minimum | `settleSession` and `createPastSession` |
| Buy-in > 0 | zod on settle / record / edit; buy-in requests already positive |
| Buy-in ceiling (`MATCH_HIGHEST`) | `assertWithinBuyInCeiling`, re-checked at approval; client pre-flights |
| Past date not in future | `createPastSession`; `<input max>` client-side |
| Request TTL 5 min | each `decide*` path + a 15s sweep |
| Club rules immutable | `updateClub` rejects any changed rule field |
| Rake requires pot | `createClub` |
| Manual mismatch | engine sets `requiresManualResolution`; callers 409 unless acknowledged |

### Settlement pipeline (`computeSettlement`)
```
1. gross profit        = cashOut − buyIn
2. winners             per winnerDefinition (PROFIT_POSITIVE | TOP_N | MANUAL)
3. mismatch + rake     order decided by rakeOrder
       MISMATCH_FIRST → cut charged on profit AFTER the mismatch
       RAKE_FIRST     → cut charged on gross, then mismatch applies
4. refund pass         un-charges rake levied on profit the mismatch reversed
5. rounding            per roundingRule; residual applied so the table reconciles
6. potContribution     = potEnabled ? rake + mismatchPotEffect : 0
```

**Mismatch resolution** — shortfall (buy-ins > cash-outs) goes to the pot;
excess (cash-outs > buy-ins) is charged per `mismatchStrategy`
(`PROPORTIONAL_WINNERS`, `EQUAL_WINNERS`, `EQUAL_ALL`, `EXCESS_FROM_POT`,
`SHORTFALL_TO_POT`, `MANUAL`).

**Invariants** (1,097 tests): `sum(nets) + potContribution === 0`, and the
stronger physical one — players' take-home plus the pot equals total buy-ins.

### Pot ledger
`ClubPotLog` is append-only and is the record of truth; the balance is the sum
of its rows. Rows key off the **live session id** (`CashOutSettlement.sessionId`)
or, for back-dated nights, the historical record id.
- settle / record → credit
- delete → reverse (`session_reversal`)
- restore → re-apply
- edit → re-settle and move by the delta (`manual_adjustment`)

### Save paths
| Action | Endpoint | Effect |
|---|---|---|
| Settle live | `POST …/offline-sessions/:id/settle` | `CashOutSettlement` + pot + session settled |
| Record past | `POST …/history/past-session` | `HistoricalSessionRecord` + pot |
| Edit / delete | `POST …/pending-changes` | applied directly (owner) or queued for approval |
| Restore | `POST …/deleted-sessions/:id/restore` | un-deletes + re-applies pot |

Owner applies edits immediately; a non-owner admin with other admins present
creates a `PendingChangeRequest` instead.

---

## 9. The three cashout-related screens

```
Settlement Module  (all inside ClubDetailView)
│
├── Live Session   — "CASHOUT" modal
│      inputs: seated players + stood-up (locked rows)
│      buy-ins pre-filled from approved BuyInRequests
│
├── Record Session — "Record a past night" modal   (owner only)
│      inputs: date + club-member picker + guest rows
│
└── Edit Session   — "Edit Session" modal          (admin)
       inputs: existing player stats + account links
```

**Shared**
- `computeSettlement` — same engine, same club rules.
- `SettlementPreview` + `SettlementConfirm` — identical presentation.
- `clubSettlementSettings` — one object built from the club, feeding all previews.
- The same shape: inputs → running tally → Calculate → preview → confirm → commit.
- Amounts always in Chips (the ₹ toggle belongs to History/Leaderboard).

**Unique**
| | Unique to it |
|---|---|
| Live | locked stood-up rows; `settlementUids` union; buy-ins from approved requests; `allCashOutsEntered` gate |
| Record | date field (capped at today), member picker + "Add everyone", guest rows, owner-only |
| Edit | account-link selects, notes field, writes through the change-request flow, pot shown as *share* not projected balance |

**Server-side they diverge completely:** `settleSession`, `createPastSession`
and `applySessionChange` are three separate functions in two modules that
happen to call the same engine.

---

## 10. Architecture Summary

### Folder structure
```
apps/api/
  prisma/schema.prisma            15 models; migrations/ (2)
  src/
    app.ts                        route mounting
    index.ts                      server entry + 2 interval sweeps
    env.ts  lib/  middleware/     config, prisma, auth, error handling
    realtime/socket.ts            io init, room join/leave, emit helpers
    modules/
      auth/                       login, register, refresh, google oauth
      clubs/                      CRUD, membership, admin, immutable rules
      offlineSessions/            THE LIVE TABLE
        settlementEngine.ts       authoritative money logic
        settlementEngine.test.ts  1,097 tests
      clubRecords/                history, leaderboard, pot ledger, audit
      sessions/                   game engine (LAZY_DEALER / VIRTUAL_TABLE)
      notifications/              messaging (parked)

apps/web/src/
  App.tsx                         viewState switch — the "router"
  main.tsx                        createRoot + AuthProvider
  components/                     screens and shared components
  lib/                            api clients, auth context, socket,
                                  settlementEngine (mirror), theme
```

### Layer map
```
main.tsx → AuthProvider → App(viewState)
                             ├── auth screens
                             ├── club screens ──► lib/*-api ──► /api ──► services ──► Prisma
                             │                        ▲                     │
                             │                        └── socket events ◄───┘
                             └── local game (client-only, BroadcastChannel)
```

### Characteristics of the current implementation
- **One context, no store.** All server data is component-local and re-fetched
  on socket events.
- **One very large component.** `ClubDetailView` is ~3,860 lines: 6 tabs, 8
  modals, 8 refreshers, 11 socket subscriptions.
- **Server is the authority.** The client mirrors the settlement engine for
  preview only; every rule is re-enforced server-side.
- **Relative `/api` paths.** No base URL anywhere — dev works via the Vite
  proxy to `:4001`, production requires single-origin with a rewrite.
- **Tests cover the engine only.** No tests for services, pot ledger, API
  routes, or any component.
