# The House Keeps Score — Session Handoff

Written 3 Aug 2026, updated later the same day after a browser walkthrough
session. Everything below was verified unless marked otherwise. Where something
is untested, it says so — trust those labels.

---

## What this is

A poker club management app. Clubs have members; members play sessions
("nights"); each night has buy-ins ("banks") and cash-outs, which the app
settles into per-player net results, applying club rules (rake, winners' cut,
mismatch handling). It tracks history, leaderboards, and a club "pot" funded by
rake.

Terminology used in the UI (and expected by the user): **Chips**, not "pts".
**Bank** = a buy-in. **Stand up** = leave the table early.

---

## Tech stack

| Layer | Choice |
|---|---|
| Monorepo | npm workspaces, `apps/api` + `apps/web` |
| Backend | Node 23, **Express 4** (4.22.2), TypeScript, run via `tsx` |
| DB | PostgreSQL via Prisma ORM |
| Realtime | Socket.IO (`emitToClub`) |
| Auth | JWT access token + refresh-token cookie, plus Google OAuth |
| Frontend | React 19, Vite 6, TypeScript |
| Styling | Tailwind v4 (`@theme` in `index.css`, no config file) |
| Animation | `motion/react` (framer-motion), respects `useReducedMotion` |
| Email | Resend (parked — see Deployment) |

---

## Folder structure

```
apps/api/
  prisma/
    schema.prisma
    migrations/20260803000000_init/     # single squashed migration
  src/
    app.ts                              # route mounting
    index.ts                            # server entry
    env.ts                              # env var schema
    middleware/                         # authenticate, errorHandler (HttpError)
    lib/
      messaging.ts                      # email/SMS/WhatsApp provider abstraction
      messageTemplates.ts
    modules/
      auth/          clubs/             sessions/
      offlineSessions/                  # THE LIVE TABLE — most important module
        settlementEngine.ts             # AUTHORITATIVE settlement logic
        offlineSessions.service.ts
      clubRecords/                      # history, leaderboard, pot, audit, past nights
      notifications/

apps/web/src/
  components/
    ClubDetailView.tsx                  # ~3000 lines, the main screen
    ClubDashboardView.tsx
    PokerTableRing.tsx                  # oval table with seats
    ChipCardDecoration.tsx              # app-wide themed background
    InfoHint.tsx                        # tap-to-reveal ⓘ popover
    BrandLogo.tsx
    VirtualTableView.tsx  LazyDealerConsole.tsx  LobbyView.tsx  PlayerView.tsx
  lib/
    settlementEngine.ts                 # MIRROR of the API copy — keep in lockstep
    api-client.ts                       # uses RELATIVE /api paths
    clubRecords-api.ts  offlineSessions-api.ts  auth-context.tsx  theme.ts
```

---

## Critical architecture notes

**The settlement engine exists twice.** `apps/api/.../settlementEngine.ts` is
authoritative; `apps/web/src/lib/settlementEngine.ts` mirrors it so the client
can show a live preview before committing. They must stay logically identical.
Verify with:

```bash
diff apps/web/src/lib/settlementEngine.ts apps/api/src/modules/offlineSessions/settlementEngine.ts
```

Expect ~9 differing lines, all comments. Any logic diff is a bug.

**Session transient state lives in a JSON column.** `PokerSession.engineState`
holds `pendingSitInUids`, `cashOuts`, and seat data. This was deliberate — it
avoids a migration every time session mechanics change. Don't go looking for
those as real columns.

**The frontend uses relative `/api` paths.** No base URL, no `VITE_API_URL`. In
dev this works through Vite's proxy to `localhost:4001`. In production this
means you should serve web and API from **one origin** with a rewrite, not a
separate `api.` subdomain (see Deployment).

**Do not upgrade to Express 5.** `offlineSessions.routes.ts` uses inline regex
path params (`/:decision(approve|reject)`, four routes). Express 5 removed that
path-to-regexp syntax; upgrading silently 404s every approve/reject endpoint.

**Standing up removes a player from `activePlayerUids`** but they remain part of
the night. The server settles the *union* of seated players and confirmed
cash-outs. Any code iterating players for settlement must use that union —
`settlementUids` in `ClubDetailView.tsx` does this. Getting it wrong silently
drops players.

---

## Settlement model

Two independent charges, either may be zero, both fund the club pot:

- **`winnersCutPercent`** — % of each winner's profit at that point in the
  pipeline (so a mismatch already applied is respected).
- **`sessionRakeAmount`** — flat fee for the night, **split equally across all
  players**, winners and losers alike. Last player absorbs the rounding
  remainder so shares total exactly.

Buy-in modes (only two, by explicit user decision):
- `UNCAPPED` — table decides, no app-side cap
- `MATCH_HIGHEST` — ceiling = the largest bank any player has taken, including
  players who have left. The opening buy-in of a night is unbounded.

**Invariant to preserve:** `sum(player nets) + potContribution == 0`. Verified
across 8 edge cases (all-lose, excess chips, one winner sweeping, fractional
12.5% cut, flat rake, break-even, both `RAKE_FIRST` and `MISMATCH_FIRST`
orderings, mismatch exceeding profit). If a change breaks this, it is minting or
destroying money.

---

## Environment variables (`apps/api/.env`)

Required: `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_ACCESS_TTL`,
`JWT_REFRESH_TTL`, `WEB_ORIGIN`, `PORT` (currently 4001), `NODE_ENV`.

OAuth: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`.

Seeding: `SEED_SUPER_ADMIN_EMAIL`, `SEED_SUPER_ADMIN_PASSWORD`,
`SEED_SUPER_ADMIN_NAME` — **remove or harden before production.**

Messaging: `MESSAGING_ENABLED`, `MESSAGING_CHANNEL=email`,
`MESSAGING_FROM_EMAIL=scores@thehousekeepsscore.com`, `RESEND_API_KEY`,
`MESSAGING_DEFAULT_COUNTRY_CODE`. WhatsApp/Twilio vars exist but are unused.

**The Resend key in this file is exposed in a prior chat transcript and needs
rotating.** Confirm `.env` is gitignored.

---

## Commands

```bash
# API (port 4001) — the dev script IS `tsx watch`, edits hot-reload
npm run dev --prefix apps/api

# Web (5173 is occupied by an unrelated project; use 5180)
npm run dev --prefix apps/web -- --port 5180 --strictPort

# Typecheck
cd apps/web && npx tsc --noEmit
cd apps/api && npx tsc --noEmit

# Prisma — MUST run from apps/api so .env loads; from the repo root it fails
# with "Environment variable not found: DATABASE_URL" even with --schema.
cd apps/api && npx prisma migrate status
cd apps/api && npx prisma migrate dev --name describes_change   # NOT db push
```

---

## Environment gotchas that cost time

- **Port 4000 is Docker**, not this API. The API is on **4001**.
- **Postgres is on 5433**, not the default 5432 (5432 is a different Docker
  container). The `DATABASE_URL` in `apps/api/.env` already points at 5433.
- **Port 5173 is a different project** ("Lalwani Print ERP"). Use 5180.
- **Prisma CLI must be run from `apps/api`** — see Commands above.
- **Prisma CLI takes minutes.** It is not hung. Background it.
- **The `_prisma_migrations` table had two orphaned rows** — `20260729163829_init`
  and `20260729171020_add_user_phone_and_profile`, still recorded as applied
  after last session deleted them from disk during the squash. `migrate status`
  did not notice, but `migrate dev` refused to run and demanded
  `migrate reset`, **which would have dropped the whole database**. Fixed by
  deleting just those two bookkeeping rows so history matches the folder;
  `migrate dev` now works normally. If a future squash deletes migration files
  again, delete the matching rows too. A copy of the removed rows was printed
  to the session scratchpad in case they ever need re-inserting.
- **Zod silently strips unknown keys.** A new field missing from the schema is
  discarded with no error. This already caused one bug (`buyInMode`).
- **`prisma db push` was used historically** and caused schema drift. Do not use
  it now that migrations exist.
- If `npx`/`node` are "command not found", `/opt/homebrew/bin` is missing from
  PATH; `~/.zprofile` has the brew shellenv fix.

---

## Current progress

**Done and verified this session:**

- Squashed init migration generated (`20260803000000_init`, 381 lines, 15
  tables) and baselined. `prisma migrate status` reports **"Database schema is
  up to date!"**. Local data was never touched — `migrate diff` works from the
  schema file.
- Two July migrations deleted at user request (backup was session-scoped and is
  now gone).
- Flat rake changed from "pot gets it, nobody pays" to **split equally**. Fixed
  a double-count discovered while testing (`totalRakeCollected` was adding
  `sessionRakeAmount` on top of the per-player deductions, crediting 400 for a
  200 rake).
- Settle form now includes stood-up players as **locked rows**. Before this the
  preview showed everyone at net 0 while the server returned entirely different
  numbers — a serious display bug, though no data was ever at risk.
- **Two-player minimum** enforced server-side on both live settle and
  back-dated nights. Verified: 1 player → `400`, 2 players → `201`.
- 12 single-player test settlements soft-deleted (`isDeleted: true`). That was
  *all* settlements in the DB.
- Past-night recording: owner-only API + UI modal with club-member picker,
  date capped at today, live buy-in/cash-out tally, guest rows. Members link by
  `userId` so nights land on their record.
- Production build succeeds (`vite build`, ~11 min, warns on >500 kB chunks).
- Both apps typecheck clean.

**Done and verified in the follow-up browser session:**

The player-flow walkthrough (previously the #1 risk) is **done**. Driven as
Rohan in a real browser at 5180, with the owner's approvals via API. Verified
working end to end:

- Login → dashboard → club detail. Rohan sees only his own club.
- Live table renders (`PokerTableRing`), correct seats, "Chips" terminology,
  `InfoHint` ⓘ icons present throughout.
- Request to Sit In → `201`, toast, dashed "Me / Waiting…" seat.
- Owner approves → **Socket.IO pushes the update live**, seat solidifies,
  count 2 → 3, button becomes "Stand Up". No reload needed.
- Buy-in modal: presets correctly capped at the ceiling. An over-ceiling
  amount (6,000 vs 5,000) is blocked **client-side before any POST**, with a
  clear toast; the server guard sits behind it as defense in depth.
- Valid buy-in → approved → chips update live; "My Buy-Ins" is correctly
  scoped to Rohan alone.
- Stand Up → cash-out request `201` → owner confirms → player leaves
  `activePlayerUids` while his confirmed cash-out is retained, exactly as the
  settlement-union design requires.
- History and Leaderboard empty states render (this club has no settled
  sessions, so **role-scoping of leaderboard data was still not exercised** —
  it needs a club with settled data and a non-admin login).

**Done and verified in the owner pass** (owner driven in the browser, the
player driven via API — the reverse of the first pass, since every remaining
unverified surface was owner-side):

- Owner dashboard and club view render with role differentiation: `OWNER` /
  `ADMIN` badges, plus `APPROVE` and `CASHOUT` nav that players do not get.
- **`club:cashout-requested` now confirmed live** — the one listener from the
  first fix that had been written but never observed. With the owner sitting
  untouched on the session screen, a player's API cash-out request surfaced
  "CASH-OUTS TO CONFIRM (1)" with no reload.
- Confirming a cash-out from the admin UI works (toast, player leaves table).
- **The settle form renders correctly**, including the stood-up player as a
  locked `🔒 STOOD UP` row with an `InfoHint` — the display fix that had never
  been seen. Preview totals, winner tagging, winners' cut, house take and the
  club-pot projection are all correct.
- **The past-night modal renders and works**: date field capped at today
  (`max` = today, checked in the DOM), club-member picker that moves a member
  into a linked row, "Add everyone", guest rows, and a live buy-in/cash-out
  tally with a running difference. Owner-only — it is absent for players.
- Nothing was committed: club pot still 0, zero settlements, zero historical
  records. The fixture is restored.

Four bugs were found across the two passes. All four are fixed — see below.

**Fixed:** cash-out events had no client listeners. The server emits
`club:cashout-requested` and `club:cashout-decided`, but `ClubDetailView.tsx`
subscribed to nine socket events and neither of those. A player who stood up
sat on "CASH-OUT PENDING…" indefinitely, with a stale seat and table count,
until a manual reload; admins likewise got no live notice of someone asking to
stand up. Server state was always correct — purely a missing live refresh.
Fixed by adding both listeners alongside the existing ones in
`ClubDetailView.tsx`; verified live (no reload) and `tsc --noEmit` clean.

**Fixed:** re-seating a player kept their stale confirmed cash-out. Reachable
entirely through the UI — stand up → admin confirms → ask to sit in again →
admin approves — leaving the player simultaneously seated *and* holding a
confirmed cash-out from their earlier stint. Two effects: the Stand Up button
vanished (the UI thought they'd already cashed out) so they could never cash
out again, and at settle `lockedCashOut` treats a confirmed cash-out as the
authority *over the admin's settle form*, so the stale figure would have
silently overridden a fresh count.

Ruled by the user: **a re-seated player's cash-out is discarded — they carry
those chips straight back into play, and may take another bank later.** That is
also the accounting-correct reading: the money never left the table, so banks
stay untouched and settlement still nets them against whatever they finally
leave with. Implemented as `clearCashOutFor()` in `offlineSessions.service.ts`,
applied on both seating paths (`decideSitIn` when approving, and `joinSession`).

Verified by replaying the whole sequence against the API: after re-seat
`cashOuts` is empty and the player is seated; Stand Up returns in the browser;
banks accumulate correctly across the break (3,000 + a later 2,000 = 5,000);
and the settlement invariant still holds for that player (banks 5,000 vs final
6,000 → +1,000 gross, 10% cut, net +900; `sum(nets) + pot == 0`, with the
discarded 4,500 appearing nowhere).

**Fixed (two bugs, both in `openCashoutModal` in `ClubDetailView.tsx`).** Found
by driving the *owner* in a browser. The modal seeded its two input maps from
`activeSession.activePlayerUids` instead of `settlementUids`, so a player who
had stood up was mishandled twice over:

1. **Their buy-in was left blank, and submits as 0.** `settleSession` takes the
   form's buy-in at face value (`buyIn: Number(entry?.buyIn || 0)`) and never
   recomputes it from `BuyInRequest`, so the player's entire bank would vanish
   and they would be credited the profit of someone who bought in for nothing.
   In the observed case a real 8,000/8,000 balanced night rendered as 5,000 in
   vs 8,000 out — a phantom 3,000 excess mismatch. **Note the pot invariant
   does not catch this**: the engine stays internally consistent with the bad
   input, so `sum(nets) + pot == 0` still holds. Garbage in, balanced garbage
   out. Do not treat that invariant as a guard against wrong *inputs*.
2. **"Calculate" was permanently disabled on any night where someone stood up.**
   The modal reset `cashOutInputs` to `{}`, dropping the locked confirmed
   cash-out; the effect that injects it only reruns when the cash-outs
   themselves change, so it never came back. The locked row still *displayed*
   the right number (it renders straight from `confirmedCashOutByUid`) while
   the `allCashOutsEntered` gate — which checks `cashOutInputs` — stayed false.
   Bug 2 masked bug 1: you could not reach a settle to be harmed by it.

Fixed by seeding both maps from `settlementUids` and pre-filling the confirmed
cash-outs. Verified in the browser: the stood-up player's buy-in now populates,
Calculate enables, and the preview reads 8,000 in / 8,000 out with no mismatch,
nets of −2,000 / +450 / +1,350 and a 200 pot.

Both apps typecheck clean after all four fixes.

---

## Features added after the walkthrough

**Requests auto-reject after 5 minutes.** `REQUEST_TTL_MS` in
`offlineSessions.service.ts`. Scoped deliberately to the three at-the-table
request types — buy-in, sit-in and cash-out. Club join requests and
edit-approval requests never expire: nobody is waiting at a table for those, and
an owner offline for five minutes would otherwise auto-reject every one.

Enforced in two places, which is the part to preserve if this is refactored:

- Each `decide*` path re-checks expiry itself and returns `409`. This is what
  makes the deadline exact — without it an admin could approve in the gap
  between expiry and the next sweep.
- `expireStaleRequests()` runs every 15s from `index.ts` and flips dead rows,
  emitting the same socket events a real decision would so open clients update.
  It is for visibility and queue hygiene, not correctness.

Sit-ins had no timestamp (`pendingSitInUids` is a bare `string[]`), so a
parallel `sitInRequestedAt` map was added to `engineState` rather than changing
the array's shape — the serialized payload the client reads is unchanged.
Expiry events carry `expired: true` and a `userId`, and the client toasts the
affected player so a vanishing request isn't silent.

Verified: unit-level (6-min-old expires, fresh survives, missing timestamp never
expires); sweep selectivity across all three types simultaneously; and all three
`decide*` guards returning 409 on a freshly-expired request. Note the sweep
assumes a single API process — with more than one, each would emit duplicates.

**Back-dated nights now calculate, review and confirm.** The past-night modal
previously showed a raw buy-in/cash-out tally and saved straight to the server,
where the engine ran unseen. It now runs the same mirrored engine the live
Cashout modal uses: Calculate → per-player nets with winner tags, totals, house
take, the engine's own rule-by-rule breakdown and the projected club pot →
a confirm step restating the figures → record. `clubSettlementSettings` is now
one shared object feeding both previews so live and back-dated can't drift.

This also fixed a real dead end: the old modal never sent
`mismatchAcknowledged`, so a club with `mismatchStrategy = 'MANUAL'` could not
record a back-dated night with a mismatch at all — the server returned 409 and
the UI offered no way to acknowledge. The acknowledgement checkbox is now in
the preview.

**Careful with the confirm button.** The first implementation submitted the
form on the *click that was meant to open the confirmation*, recording a night
with no confirm step. React reconciles the review/confirm ternary by patching
the same `<button>` node, so `setPastConfirming(true)` flipped its `type` to
`submit` before the browser evaluated the click's default action. Pressing
Enter in any field had the same effect. The gate is therefore enforced inside
`handleCreatePastSession` (`if (!pastConfirming) { setPastConfirming(true);
return; }`) rather than by which button happens to be rendered, with distinct
`key`s as a second line of defence. Don't "simplify" that back.

**Chips/₹ toggle on History and Leaderboard.** Shown only when the club sets
N chips = ₹1 (`enableDevaluation` with `devaluationFactor > 1`); otherwise
there is nothing to convert and no toggle appears. Defaults to Chips, is shared
by both tabs so they can never disagree, and is available to players, admins and
owners alike. Display-only — `formatUnit`/`formatSignedUnit` wrap the existing
formatters and nothing stored or sent is ever converted.

Verified at 5 chips = ₹1: 1,350 → +₹270, −1,500 → −₹300, 2,000 → ₹400 across
history rows and all four leaderboard columns, signs preserved, toggling clean
in both directions, and identical for a non-admin. The club pot log and the
live-table figures are deliberately left in chips.

**Owner session edits now re-settle, and the pot follows.** Owners could
already edit or delete a recorded night (pencil/bin on a History row; owners
apply directly, a non-owner admin needs another admin's approval). Two things
were badly wrong with it:

1. **Editing erased the club's settlement rules.** The client computed
   `profit: cashOut - buyIn` with `winnersCutDeduction: 0` and sent that
   verbatim, and the server stored it. Any night that had been settled with a
   rake or winners' cut came back out of an edit as raw gross profit, silently
   rewriting history and the leaderboard.
2. **Nothing ever decremented the pot.** `clubPotBalance` was increment-only, so
   a deleted session's rake stayed in the balance forever with no record of
   which session it belonged to. That is exactly how the three orphaned pots
   happened.

`applySessionChange` now runs in one transaction and:

- **re-settles an edit through the engine** using the club's current rules, and
  writes the engine's output rather than the client's placeholders — the client
  now only supplies buy-in/cash-out pairs;
- **moves the pot** to match: delete reverses the session's contribution, edit
  adjusts it to the recomputed figure, restore puts back exactly what deletion
  removed (including any adjustment an edit made first).

`ClubPotLog` is the ledger of record and stays append-only — every correction
is a new row, never a rewrite, so the balance is always the sum of its rows.
Rows are keyed by the *live session* id (`CashOutSettlement.sessionId`), and
back-dated nights now log their record id too, which they previously did not —
without that key a contribution cannot be reversed.

Verified end to end against the running API: record → pot 150; edit to balanced
figures → profit came back **900, not 1,000**, so the 10% cut survived, and the
pot moved to 100 with a `-50 manual_adjustment` row; delete → pot 0 via a
`-100 session_reversal`; restore → pot back to **100, not the original 150**.

One deliberate restriction: if a club uses `mismatchStrategy = 'MANUAL'` and an
edit produces a mismatch, the edit is refused with a 409 rather than guessing.
Same posture as recording and settling.

**Club rules are immutable after creation.** `IMMUTABLE_CLUB_RULES` in
`clubs.service.ts` freezes buy-in mode, min/max buy-in, devaluation, and every
settlement field (rake, winners' cut, pot, mismatch strategy, rake order,
winner definition, rounding). `updateClub` now accepts only `name`,
`description` and `leaderboardVisibleToPlayers`; anything else that *differs
from the stored value* is rejected with a 400 naming the fields. Echoing
unchanged values back is allowed, so a form that posts the whole object still
works. The settings modal shows the rules inside a `disabled` fieldset with a
lock notice — the leaderboard toggle and admin management sit outside it and
stay editable.

**This closes the open design question** about back-dated nights being settled
with today's rules: if the rules can't change, "today's rules" and "the rules
that night was played under" are the same thing. It also makes re-settling on
edit safe, which is what made the question urgent.

Verified: changing `winnersCutPercent` → 400 with the field named; re-posting
the same values → 200; changing name + leaderboard toggle → 200; the stored
rule unchanged throughout.

**Session edit modal fixes.**

- **The date field was blank and demanded re-entry.** `listHistory` returned
  `sessionDate` as a full ISO timestamp for historical records, and
  `<input type="date">` silently blanks on anything that isn't exactly
  `YYYY-MM-DD`. The settlement branch already sliced it correctly; historical
  was missed. Fixed server-side, with a defensive slice in the client too.
- **Added a Calculate step.** An edit re-settles the night, so the recomputed
  per-player results, house take, rule breakdown and the night's pot share are
  shown before saving. "Update Session & Recalculate" stays disabled until
  Calculate has been run, and refuses when the club needs manual mismatch
  resolution. Any input change invalidates the preview.
- The pot panel here deliberately shows **this night's pot share**, not a
  projected balance: saving reverses the session's previous share before
  applying the new one, and the client doesn't know the old figure — adding it
  to the current balance would double-count.
- **Removed "Delete Session" from the edit modal.** Deleting still lives on the
  History row's bin icon; editing and destroying shouldn't be a mis-tap apart.
- Fixed hardcoded `₹` on chip figures in this modal (row profit, the buy-in and
  cash-out labels, and the session totals) — they now use the Chips/₹ formatter
  like everywhere else.
- **Failures are no longer silent.** The catch showed a bare "Failed to edit
  session." alert, so a rejected edit and an unreachable API looked identical —
  and both looked like the button doing nothing. It now raises a toast carrying
  the server's actual reason, with a specific message when the API can't be
  reached at all. Worth knowing while developing: the API runs under
  `tsx watch`, and if that process dies every request fails as
  `TypeError: Failed to fetch`. That is what "Update Session & Recalculate
  isn't working" turned out to be — the button and endpoint were fine.

**The three settle flows now share one UI.** Settling a live night, recording a
back-dated one, and editing a recorded one all end in the same question — "here
is what the club's rules say everyone owes, commit it?" — but each had grown its
own layout, so they read as three unrelated features.

`SettlementPreview.tsx` is now the single place a settlement is shown. All three
render it, driven purely by a `SettlementResult`, and all three follow the same
shape:

> player inputs → running tally → **Calculate** → shared preview → confirm → commit

The preview covers per-player nets with the mismatch share and winners' cut
spelled out beneath each name, totals, house take split by source, the engine's
rule-by-rule steps, the manual-mismatch acknowledgement, and the club pot.
`SettlementConfirm` is the shared last-look panel. What legitimately differs
stays local to each modal: a live table has locked cash-outs, a back-dated night
needs a date and member picker, an edit needs account links.

Worth knowing:
- The live Cashout modal no longer repeats each player's breakdown under their
  inputs — it duplicated the shared preview directly below it.
- The edit flow gained the confirm step the other two had. It moves money and
  rewrites standings, so it should never have been a single tap.
- Amounts in all three are **always Chips**. The Chips/₹ switch belongs to
  History and the Leaderboard, where you read past results; these screens are
  where you enter and commit chip counts, and showing rupees would invite
  entering them.
- Amounts sit in one right-aligned `tabular-nums` column so digits line up
  instead of drifting with each name's length.

Verified in a browser across all three, including committing an edit end to end
(pot moved 150 → 100 with a `-50` adjustment row, cut correctly re-applied).

**Leaderboard is rank and profit/loss only.** Sessions, Total Buy-ins, Total
Cash-Outs and Biggest Win/Loss have all been removed from both the desktop
table and the mobile cards (the leaderboard renders twice — change both or they
drift). It's a standings board, not a disclosure of what everyone else puts on
the table. The API still returns those aggregates: `AccountSettingsModal` shows
biggest win/loss on a player's *own* record, which is a different surface.

**A player can't have a zero buy-in.** Someone who never bought in didn't play,
and a zero also distorts the settlement — they'd count as a "winner" on any
cash-out at all, while the mismatch and pot are computed against buy-ins that
never happened. Enforced in the zod schemas for settling, recording a
back-dated night, and editing one (`buyIn`/`totalBuyIn` are now `.positive()`
with a plain-English message); cash-out stays `nonnegative` because busting out
with nothing is normal. Buy-in *requests* already required a positive amount.
The three forms also block Calculate and explain why, rather than letting the
save fail. Verified: zero buy-in → 400 naming the reason; a real buy-in → 201.

**Money-creation bug found and fixed (engine).** With `rakeOrder = RAKE_FIRST`
and a large winners' cut, the rake could consume a winner's entire profit
*before* the mismatch step ran. The mismatch then found no remaining profit to
deduct from and charged the phantom chips to nobody — while the rake still
credited the pot. Demonstrated at 100% cut: a table with 9,000 of buy-ins paid
out 12,000 (players 9,000 + pot 3,000), banking 3,000 chips that never existed.
Fixed by falling back to *gross* profit as the proportional basis when nothing
remains; the existing refund pass then unwinds rake charged on profit the
mismatch reversed. Regression-tested. No club was ever in this configuration.

**A club that charges a rake must enable the Club Pot.** With the pot off, the
engine still deducted the cut from winners but banked nothing: the money left
the players and the app had no record of it, and `sum(nets) + pot == 0` quietly
stopped holding. `createClub` now rejects that combination — this matters more
since rules became immutable, as such a club could never be corrected. No
existing club is affected (all clubs with a rake already have the pot on).
Note the related, documented behaviour that remains: with the pot disabled and
no rake, an unclaimed **shortfall** is recorded as untracked.

**Why a winners' cut can look "too small".** The most common confusion, and
not a bug: with the default `rakeOrder = MISMATCH_FIRST`, the cut is charged on
profit *after* the mismatch adjustment. A winner grossing 3,000 on a table
over-declared by 2,500 is cut 10% of the surviving 500 (= 50), not of 3,000.
`RAKE_FIRST` charges the 300 on gross profit first and then applies the
mismatch. Both are covered by named tests. On a table that balances, the cut is
simply 10% of gross — 300 — as expected.

**Mismatch steps now name who paid.** The rule summary used to say only
"deducted from winners proportional to their profit share", which left the
obvious question unanswered. All three excess branches now enumerate the
players and amounts, e.g. *"deducted from winners in proportion to profit:
Bala -600 (40% of winning profit), Chetan -900 (60% of winning profit)"*. The
edit and past-night previews additionally show per-player "Mismatch share" and
"Winners' cut" lines under each name. Changed in **both** engine copies —
they remain comment-only divergent.

**History rows lead with your own result.** A collapsed session card shows the
viewer's net for that night, signed and colour-coded, and nothing at all if
they sat that one out. Expanding swaps it for the per-player breakdown and
reveals the edit/delete controls, which are no longer visible on collapsed
rows. Both figures respect the Chips/₹ toggle.

**Leaderboard is now private by default.** Migration
`20260803021555_leaderboard_private_by_default` flips the column default to
false *and backfills every existing club*. The backfill is deliberate: a
default-only change would have left all seven existing clubs exposed, which was
the opposite of the intent. No owner had ever opted in — they were all just
sitting on the old default. Any owner can turn it back on per club from Club
Settings → "Show Leaderboard to Players".

The client fallbacks were flipped too (`?? true` → `?? false` in
`canSeeLeaderboard` and the settings form) so a payload missing the flag fails
closed rather than open. `createClub` now states it explicitly rather than
leaning on the column default.

Verified end to end: all 7 clubs false and the column default false with data
intact (7 clubs / 34 users / 16 sessions); as a plain member the RANKS tab
disappears entirely and `GET /leaderboard` returns 403; as owner it still
returns 200; and the owner's checkbox round-trips both ways — ticking it in the
UI persisted `true` and the player's request immediately returned 200 again.

---

## Known bugs / open items

**A full settle has still never been *committed*.** The settle form is now
verified all the way to a correct preview (see the owner pass below), but the
final "Settle Session" button has deliberately never been pressed: this club has
`winnersCutPercent = 10`, so settling credits the club pot, and there is still
no reversal path for pot balances (see orphaned pots below). Resolve that first.

**Leaderboard visibility — resolved.** A plain member could previously read
every other member's lifetime net profit, buy-ins and biggest win/loss, because
`leaderboardVisibleToPlayers` defaulted to **true**. Ruled by the user: keep it
as a club toggle, but default it to **false**. See the features section below.

**Orphaned pots — resolved.** All three (Cashout QA Club 6,100, AniCr7 2,000,
Texas Holdem Club 1,025) were zeroed at the user's direction, each with a
`manual_adjustment` row in `clubPotLog` recording the amount and why it could
not be attributed to a surviving session. Every club pot is now 0. The
underlying cause — deletions never reversing their contribution — is fixed; see
"Owner session edits" below.

**Phase 0a shipped: settlement is now audited.** `settleSession` and
`createPastSession` write an `AuditLog` row — previously every operation that
*created* money was untraceable while every operation that *modified* it was
recorded. Additions only; no settlement calculation, contract, controller or UI
was touched.

- Keyed on `settlement.id` / `created.id` — the same id `applySessionChange`
  audits against — so a record's whole life (`settle_session` → `edit_session`
  → `delete_session` → `restore_session`) shares one `sessionId`.
- Each row carries provenance in `changes.meta`: `settlementEngineVersion`
  (from `SETTLEMENT_ENGINE_VERSION` in the engine), `auditSchemaVersion` (from
  `clubRecords/auditMeta.ts`) and `createdFrom`. Bump the engine constant
  whenever a change there can alter the numbers.
- **Placement matters:** both writes sit immediately after their record is
  created and *before* the pot movement, so any later failure in the same
  transaction rolls the record and its audit back together. Moving them later
  silently breaks that — the pot step would fail before the audit was ever
  attempted. There is a test for this; don't reorder without reading it.
- Retroactive from deploy only. Nights settled earlier have no creation record.

**Before changing anything that touches money, read
`MONEY-CHANGE-CHECKLIST.md`** — settlements, balances, pot, rake, approvals,
audit. Four properties every such change must strengthen or preserve:
correctness, traceability, recoverability, observability.

**Rule for tests and cleanup: never delete data you did not create.** Create a
dedicated club, its users and its records, and remove only those. The atomicity
test already works this way. This is written down because it was broken once —
an ad-hoc cleanup sweep removed two pre-existing `edit_session` audit rows
belonging to the "No Rake" club that predated the session and were not
recoverable.

**Integration tests** — `npm run test:integration --prefix apps/api`. Requires a
database, so it is excluded from `npm test`, which stays fast and DB-free.
`settleSession.atomicity.integration.test.ts` forces a real failure (pot
overflowing Postgres `INTEGER`, raising `22003`) after the settlement row is
inserted, and asserts neither settlement nor audit survives, the session stays
`active`, and the pot is untouched — plus a positive control and a
double-settle check. Verified by mutation: switching the audit write from `tx`
to `prisma` makes it fail with an orphaned row.

**There is now a test suite** — `npm test --prefix apps/api` (vitest).
`settlementEngine.test.ts` runs **1,097 tests**. It asserts two properties on
every case, and the second is the one that matters most:

- `sum(nets) + potContribution === 0` — internally balanced.
- **the table reconciles**: what players physically carry away
  (`cashOut − mismatch − rake`) plus the pot equals the chips bought onto the
  table. This is what someone counting the cash box would check, and unlike the
  first it can fail on rounding alone.

Coverage: a matrix of 9 awkward tables (all-lose, one player sweeping, excess
larger than total profit, fractional splits, break-even) × 6 rake setups × 5
mismatch strategies × 2 rake orders × 2 rounding rules, plus named cases for
rake ordering, rounding residuals, and the money-creation regression.

It also **enforces the two engine copies stay identical** by comparing their
source with comments stripped — drift now fails a test instead of relying on
someone remembering to run `diff`. That guard was verified to actually fail
when the copies diverge.

Add to it before touching the engine; it is the only thing standing between a
refactor and silently wrong money. Nothing else in the app has tests yet — and
note that three of the four bugs found in the browser walkthrough were *inputs
and wiring*, which this suite does not cover.

**Game-engine views are untouched and untested** — `VirtualTableView`,
`LazyDealerConsole`, `LobbyView`, `PlayerView`. They also have zero `InfoHint`
usage while the main views have 5–6 each.

**Email has never sent through the app.** A direct Resend call succeeded
(`200`), proving key + delivery, but `notifySessionSettled` firing on settle is
untested. Sending is currently blocked anyway: `MESSAGING_FROM_EMAIL` points at
`scores@thehousekeepsscore.com` and the domain is **not yet verified** in
Resend. Work is parked by user request.

**Open design question — resolved.** A back-dated night is settled with today's
club rules, which used to mean historical nights could be restated if the rules
changed. Club rules are now immutable after creation, so there is only ever one
set of rules for a club and the question no longer arises.

**Untested flows:** Google OAuth (`oAuthAccount` table is empty), the
edit-approval flow (`pendingChangeRequest` empty), session auto-renumbering
(verified manually earlier, not covered by any script).

---

## Deployment status

**Not deployed. Not production ready.** The migration blocker is now cleared,
but the following remain:

Domain purchased: **thehousekeepsscore.com** (note the double-s where "keeps"
meets "score"). Not yet pointed anywhere.

Needed:
1. Managed Postgres (Neon / Supabase / Railway), then `prisma migrate deploy`
2. API on a host with **persistent processes** — Socket.IO needs WebSockets, so
   Vercel/Netlify functions will not work. Railway, Render, or Fly.
3. Web as static files on Vercel/Netlify/Cloudflare
4. **Single origin** — put the web app on the domain and rewrite `/api/*` to the
   API host. This avoids CORS entirely and, importantly, avoids cross-site
   cookie problems: the refresh call uses `credentials: 'include'`, which on a
   separate subdomain would need `SameSite=None; Secure`.

```json
// vercel.json
{ "rewrites": [{ "source": "/api/:path*", "destination": "https://YOUR-API-HOST/api/:path*" }] }
```

5. `WEB_ORIGIN` must exactly match the production domain or CORS blocks
   everything — classic first-deploy failure.
6. Update `GOOGLE_CALLBACK_URL` and add the redirect URI in Google Cloud Console.
7. Consider code-splitting; the bundle warns on chunk size.

---

## Database contents (as of handoff)

32 users (most orphaned test accounts), 7 clubs, 16 poker sessions, 12
cash-out settlements (**all soft-deleted**), 2 historical records, 14 pot-log
rows, 327 refresh tokens (no cleanup job exists — this table only grows).

Five of seven clubs have both rake settings at 0. Only "ANiCr17" has a flat rake
(200) configured.

---

## Recommended next steps, in order

1. **Run a real settle through the UI.** Now unblocked — pot reversal exists, so
   a settle is no longer a one-way door. This is the last unexercised part of
   the core loop.
2. **Browser-verify the owner edit/delete/restore flow.** The pot and re-settle
   behaviour above was verified against the API, not through the edit modal
   itself; that modal is still unproven in a browser.
3. Add a vitest suite. Cover the settlement engine invariant — but also, and
   more importantly, cover *what gets fed into it*: three of the four bugs
   found so far were wrong inputs or wrong wiring, which the invariant cannot
   see.
5. Rotate the Resend key.
6. Deployment, in the order in the Deployment section.

**Walkthrough fixture** (restored to its original state; reusable as-is): club
"Friday Night Poker", sign in as `rohan1785697864301@demo.com` / `Passw0rd!` at
`http://localhost:5180`. Rohan is a member but not seated. Owner is
`owner1785697864301@demo.com`, same password. Approvals need a second identity:
drive Rohan in the browser, do the owner's approvals via API.

Two corrections to earlier notes on this fixture: the ceiling shows **5,000**,
not 8,000 — `getBuyInCeiling` counts only *approved* banks, and Meera's 8,000 is
still pending, so the owner's approved 5,000 is the highest. That is correct
behavior, not a bug. Also, Rohan's profile is now filled in; the first login
originally hit a mandatory "Complete your profile" gate (first name, last name,
username and **mobile number** are all required) because the seed leaves those
empty. The owner's profile is filled in too (as "Arjun Kapoor") for the same
reason. Any other seeded user will still hit that gate.

One quirk of the fixture: Meera's seeded 8,000 buy-in request can no longer be
approved — approval re-checks the ceiling, which is now 5,000, so it returns
`400`. That is correct behavior, but it means the fixture has a permanently
un-approvable pending request sitting in the Approvals list.

---

## Working style notes

The user prefers info icons (`InfoHint`) over verbose on-screen text, wants
role-scoped data (players must not see other players' aggregate standings —
this leaked twice and was only caught by testing as a non-admin), and has been
clear that per-player emails must contain only that player's own figures.

They correct course quickly and expect the same. Report failures plainly with
the actual output; don't claim verification that didn't happen.
