# The House Keeps Score

A poker club scorekeeper. Clubs have members; members play nights; each night
has buy-ins and cash-outs, which settle into per-player results under the club's
own rules (rake, winners' cut, mismatch handling), funding a club pot.

> **This project has stronger evidence than confidence.**
>
> That is deliberate. Where something has been demonstrated, it says so. Where
> it has only been reasoned about, it says that too. Keep the distinction — it
> is the most valuable thing in this repository, and the easiest to lose.

---

## Start here

| Document | Read it when |
|---|---|
| **`handoff.md`** | Picking the project up. Current state, what works, what's unverified, environment gotchas. **Start here.** |
| **`MONEY-CHANGE-CHECKLIST.md`** | Before touching settlements, balances, pot, rake, approvals or audit. Non-negotiable. |
| **`DECISIONS.md`** | Wondering *why* something is the way it is. ADRs with tiered evidence, plus Principles 0 and 1. |
| **`ARCHITECTURE.md`** | Needing to understand how the app is built today — screens, state, data flow, component trees. |
| **`TARGET-ARCHITECTURE.md`** | Planning what to do next. Production-readiness plan and the phased roadmap beyond it. |

## Commands

```bash
npm run dev --prefix apps/api                          # API on :4001 (tsx watch)
npm run dev --prefix apps/web -- --port 5180 --strictPort   # web (5173 is another project)
npm test --prefix apps/api                             # 1,097 engine tests, no database needed
npm run test:integration --prefix apps/api             # database-backed tests
cd apps/api && npx tsc --noEmit                        # typecheck (must run from apps/api)
```

`handoff.md` has the environment traps that cost time — Postgres is on **5433**,
Prisma commands only work from `apps/api`, and port 4000 belongs to something
else.

## The two principles

**Principle 0 — Verify the accepted truth.** Before changing an important
system, check what everyone already believes about it. Every significant find in
this project came from testing a statement that sounded obviously true.

**Principle 1 — Preserve the evidence.** When something unexpected happens,
capture enough to explain it before tidying it away. Both principles, with the
cases that produced them, are at the top of `DECISIONS.md`.

## Keeping these documents alive

They are operational, not historical. When a real session teaches you something:

1. Fix the bug.
2. Add the regression test — one that fails if the fix is reverted.
3. Update the ADR if the *reasoning* changed, not just the code.
4. Update the production checklist if the *process* changed.

A document that never changes after a surprising night is a document nobody
consulted.

## Status

**Not deployed.** The next milestone is production readiness (Phase A in
`TARGET-ARCHITECTURE.md`), then a first real poker night — treated as
observation, not validation.
