-- The canonical replay contract (SETTLEMENT-HISTORY-DESIGN.md step 3).
--
-- ADDITIVE AND NULLABLE, on purpose. Every column that exists keeps its name,
-- its type and its value, so:
--
--   * the API running right now keeps working after this migration
--   * nothing that reads these tables changes behaviour
--   * this can therefore be applied BEFORE the deploy that uses it, which is
--     the safe order — the new client selects these columns, so deploying
--     first would fail every query against these tables
--
-- Nothing is backfilled here. A historical row gets NULL and keeps it: the
-- rules a pre-contract night was settled under are not in the data, and the
-- Club's current settings are not an acceptable substitute. Revision 1 for
-- existing records is step 4's backfill, run deliberately and audited.

ALTER TABLE "CashOutSettlement" ADD COLUMN "engineVersion" INTEGER;
ALTER TABLE "CashOutSettlement" ADD COLUMN "canonicalInputs" JSONB;
ALTER TABLE "CashOutSettlement" ADD COLUMN "canonicalOutputs" JSONB;

ALTER TABLE "HistoricalSessionRecord" ADD COLUMN "engineVersion" INTEGER;
ALTER TABLE "HistoricalSessionRecord" ADD COLUMN "canonicalInputs" JSONB;
ALTER TABLE "HistoricalSessionRecord" ADD COLUMN "canonicalOutputs" JSONB;
