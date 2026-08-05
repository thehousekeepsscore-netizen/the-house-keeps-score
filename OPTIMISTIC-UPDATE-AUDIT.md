# Optimistic update audit

**Date:** 2026-08-05 · **Status:** audit of shipped code, not a proposal
**Follows:** [SOCKET-EVENT-CONTRACT.md](SOCKET-EVENT-CONTRACT.md)

Every mutation that touches the cache, and what happens to the cache when the
server says no.

---

## 1. Three categories, not two

The audit turned up a distinction the question "is it optimistic?" hides:

**Optimistic** — the cache is written *before* the server answers, on a
prediction. If the prediction is wrong the cache is now lying, so a rollback is
mandatory.

**Write-through** — the cache is written *after* the server answers, from the
response. There is nothing to roll back, because nothing was written until the
truth arrived. A failure leaves the cache exactly as it was.

**Refetch** — the cache is invalidated and re-read from the server.

Only the first category needs rollback. Conflating write-through with optimistic
is what makes people ask for rollbacks that cannot exist, and it is the reason
this table separates them.

---

## 2. The table

| Flow | Kind | Rollback | Rollback tested | Server authoritative | Cache repaired on failure |
|---|---|---|---|---|---|
| **Buy-in — request** | Write-through | n/a — nothing written before the reply | n/a | Yes — ceiling and one-pending-per-player enforced server-side | Yes, trivially: nothing was written |
| **Buy-in — approve / reject** | **Optimistic** | **Yes** — restores the entry captured before the write | **No** ⚠️ | Yes — the POST's session reply overwrites the prediction | Yes — `cache.update(key, () => previous)` |
| **Sit-in — request** | Write-through | n/a | n/a | Yes — server owns seat order | Yes |
| **Sit-in — approve / reject** | Write-through | n/a | n/a | Yes | Yes |
| **Cash-out — request** | Write-through | n/a | n/a | Yes — amount validated server-side | Yes |
| **Cash-out — confirm / reject** | Write-through | n/a | n/a | Yes — a confirmed cash-out is locked for settlement | Yes |
| **Join table** | Write-through | n/a | n/a | Yes | Yes |
| **Session — start** | Write-through | n/a | n/a | Yes | Yes |
| **Session — settle** | Refetch | n/a — nothing written optimistically | n/a | Yes, entirely | Yes — five resources invalidated and re-read |
| **Pending changes — approve / reject** | Refetch | n/a | n/a | Yes | Yes |
| **Join request — accept / reject** (dashboard) | **Optimistic** | **Yes** — restores the previous request list | **No** ⚠️ | Yes | Yes — `cache.update(JOIN_REQUESTS_KEY, () => previous)` |
| **Club — rename / settings / promote / demote / remove member** | Write-through | n/a | n/a | Yes — `IMMUTABLE_CLUB_RULES` rejects rule changes | Yes |

---

## 3. Findings

**Only two flows are genuinely optimistic.** Buy-in approve/reject and join
accept/reject. Both capture the previous cache entry before writing and restore
that exact entry on failure, rather than applying a hand-rolled inverse — which
matters because a refusal may mean more changed than the one row, and a
computed inverse would encode an assumption the server just contradicted.

**Neither rollback is tested.** ⚠️ This is the real gap. `apps/web` has no test
runner beyond plain vitest — no jsdom, no React Testing Library — so there is
currently no way to mount a component, fail a request and assert the cache
returned to its prior value. The rollbacks are correct by inspection, which is
exactly the standard this project has repeatedly found insufficient.

**Six flows were neither optimistic nor write-through, merely slow.** Start
session, join table, sit-in request/decide and cash-out request/decide all
received the updated session and threw it away to re-GET it. Fixed in `432f476`.
The audit found these; asking "is it optimistic?" would not have.

**Settlement is deliberately not optimistic and should stay that way.** It
recomputes leaderboard aggregates across the club's entire history and moves the
pot ledger. A client holding one session cannot predict the result, so an
optimistic write would be a guess about money.

**Every failure path shows the server's message.** Verified across the flows
above; the generic-string swallowing fixed in `2d70ded` was the last one.

---

## 4. What would close the gap

To make "rollback tested" answerable with yes:

1. Add `jsdom` + `@testing-library/react` to `apps/web`. This is a dependency
   change, so it is flagged rather than made.
2. Test the two optimistic flows directly: seed the cache, stub the API to
   reject, assert the entry is byte-identical to the pre-write snapshot.
3. Test the one property that matters beyond equality — that a *socket event
   arriving during a failed request* does not get clobbered by the rollback.
   This is the one case inspection is genuinely bad at, because it depends on
   interleaving. It is currently unhandled: the rollback restores a snapshot
   taken before the request, so an unrelated event applied in between would be
   discarded.

Point 3 is a real, if narrow, correctness bug in both optimistic flows. It needs
a decision on the fix — restore-by-id rather than whole-entry snapshot, or
version the entry and refuse a stale restore — and is listed here rather than
fixed silently.
