-- Buy-in history: when a decision was taken, and what was corrected.
--
-- Every column is nullable and nothing is backfilled, deliberately. These
-- record facts about events, and the events that already happened did not
-- record them — inventing an approvedAt for a row decided last Friday would
-- put a timestamp in the audit trail that nobody can vouch for. The history
-- shows "Approved by Rahul" with no time for those, which is true, rather
-- than a time that is false.
--
-- Safe on a live table: adding nullable columns takes no rewrite and no
-- long lock in Postgres, so a night in progress is unaffected.

-- AlterTable
ALTER TABLE "BuyInRequest"
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "amount_previous" INTEGER,
  ADD COLUMN "editedBy" TEXT,
  ADD COLUMN "editedAt" TIMESTAMP(3),
  ADD COLUMN "deletedBy" TEXT,
  ADD COLUMN "deletedAt" TIMESTAMP(3);
