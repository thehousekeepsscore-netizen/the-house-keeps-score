-- The revision model (SETTLEMENT-HISTORY-DESIGN.md §8, step 4).
--
-- A NEW TABLE ONLY. No existing table is altered, no existing row is touched,
-- and no settlement figure moves. The application running right now neither
-- reads nor writes this table, so applying it early is harmless.

CREATE TABLE "SettlementRevision" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "recordType" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "isLive" BOOLEAN NOT NULL DEFAULT true,
    "supersedesRevision" INTEGER,
    "engineVersion" INTEGER,
    "ruleSnapshot" JSONB,
    "canonicalInputs" JSONB,
    "canonicalOutputs" JSONB NOT NULL,
    "totals" JSONB NOT NULL,
    "causedBy" TEXT NOT NULL,
    "causeId" TEXT,
    "reason" TEXT NOT NULL,
    "requestedBy" TEXT,
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inputsIncompleteReason" TEXT,
    "splitUnavailableReason" TEXT,

    CONSTRAINT "SettlementRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SettlementRevision_recordId_recordType_revision_key"
    ON "SettlementRevision"("recordId", "recordType", "revision");

CREATE INDEX "SettlementRevision_recordId_recordType_idx"
    ON "SettlementRevision"("recordId", "recordType");

-- "There are never two competing current settlements", as a constraint rather
-- than a convention. Partial unique indexes are not expressible in the Prisma
-- schema, so it lives here — and it is the reason this migration is written by
-- hand rather than generated.
CREATE UNIQUE INDEX "SettlementRevision_one_live_per_record"
    ON "SettlementRevision"("recordId", "recordType")
    WHERE "isLive";
