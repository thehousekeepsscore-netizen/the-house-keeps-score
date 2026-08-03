# Money-change checklist

Apply to any change touching **settlements, balances, the club pot, rake,
approvals or the audit trail**. Everything else in the app can be fixed forward;
these can't, because a wrong number is often only noticed after someone has been
paid the wrong amount.

Every change to this surface should strengthen or preserve all four of:

| Property | The question it answers |
|---|---|
| **Correctness** | Are the numbers right, and provably so? |
| **Traceability** | Can every money movement be attributed to a person and a moment? |
| **Recoverability** | Can a mistake be investigated and undone? |
| **Observability** | Can we tell what happened in production without a debugger? |

## Checklist

```
□ Correctness preserved or improved
    □ computeSettlement untouched, or the change is covered by new engine tests
    □ sum(nets) + potContribution === 0 still holds
    □ the table still reconciles: take-home + pot === total buy-ins
    □ both engine copies still in lockstep (a test enforces this)

□ Every money movement is traceable
    □ creation, edit, deletion and restore all write an AuditLog row
    □ the row carries changes.meta provenance (engine + schema version, origin)
    □ lifecycle events share one sessionId so a record's history joins up

□ Failures are recoverable
    □ record write and audit write are in the same transaction
    □ the audit is written as early as its record exists, before any step
      that can still fail — otherwise a later failure rolls back a settlement
      whose audit was never attempted
    □ pot movements go through the append-only ledger, never a direct balance edit
    □ nothing outside the transaction observes intermediate state
      (emit and notify only after commit)

□ It is observable in production
    □ failures surface a real reason to the user, not a generic message
    □ the change is visible in the audit trail or the pot ledger

□ Regression tests exist
    □ a test that fails if the change is reverted
    □ for atomicity claims: prove it by mutation — break the implementation
      and confirm the test goes red, then restore it
    □ integration tests create their own club/users/records and delete only
      those; never clean up data you did not create

□ The database enforces what it can
    □ invariants that must never be violated are constraints, not just checks
      in application code
    □ application logic prevents mistakes; constraints prevent impossible states
```

## Why the mutation step is in here

The first atomicity test written for the settlement audit passed, and was
worthless: the forced failure happened before the audit write was reached, so
"no orphaned audit row" was true trivially. It was only caught by deliberately
breaking the implementation and noticing the test stayed green.

A passing test is evidence of nothing until you have seen it fail for the right
reason.
