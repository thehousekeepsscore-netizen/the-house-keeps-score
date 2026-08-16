## What and why

<!-- What changes, and what problem it solves. -->

---

## Schema changes

<!-- Delete this section if the PR adds no migration. -->

Migrations run as a **pre-deploy command** (`railway.json`), which means they are
applied **while the previous version is still serving traffic**. The old code
meets the new schema on every deploy.

- [ ] **This migration is backward-compatible with the version currently in
      production.** It adds; it does not remove, rename, tighten or re-type
      anything the running code reads or writes.

If it is not backward-compatible, it needs **expand → migrate → contract across
separate releases**:

1. **expand** — add the new shape alongside the old; deploy
2. **migrate** — backfill and start writing both; deploy
3. **contract** — stop reading the old shape; deploy; *then* drop it

A destructive migration in a single release will break the running version for
the length of the deploy, and the release model cannot catch it. A reviewer is
the only thing that can.

- [ ] Applying this migration to production **before** merging is safe (it must
      be — that is the order the pre-deploy command enforces).
- [ ] Rollback is understood: reverting the app must not require reverting the
      schema.

---

## Money

<!-- Delete if the PR cannot change a financial figure. -->

- [ ] No existing settlement figure changes, or the change is explicit,
      approved, and recoverable (`SettlementRevision`).
- [ ] Verified against real data, not only fixtures.
