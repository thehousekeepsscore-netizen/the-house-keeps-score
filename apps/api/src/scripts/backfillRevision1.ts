/**
 * Revision 1 for every record that already exists.
 *
 *   DATABASE_URL='postgresql://…' npx tsx src/scripts/backfillRevision1.ts
 *
 * THIS SCRIPT CANNOT WRITE. It plans the backfill, prints exactly what it
 * would insert, and stops — see `EXECUTION_ENABLED` below. That is deliberate
 * and it is the point of shipping it now: the plan is reviewable one step
 * before the table it writes into exists.
 *
 * ---
 *
 * WHY THIS EXISTS
 *
 * The design overwrites settled nights, and the only thing that makes that
 * survivable is a copy of what the night said before. Revision 1 is that copy.
 * From step 4 onward it is written at settle time, so new nights get one for
 * free. Every night settled BEFORE that has none — and the first correction of
 * one of those would overwrite it with nothing behind it.
 *
 * Hence the precondition the design states, which this script exists to
 * satisfy: **no revision 1, no correction.** Enforced in code at the top of the
 * overwrite path, not by whether this script happened to run.
 *
 * WHY IT IS INERT
 *
 * `SettlementRevision` does not exist yet. It arrives in step 4, and the
 * sequence the design settled on puts the audit (step 1) before the schema
 * (step 4) precisely so the migration can be reviewed against real data before
 * anything is created. Running this today would need a table that is not there.
 *
 * When step 4 lands: add the Prisma model, replace the `plan()` body's TODO
 * with the insert, flip EXECUTION_ENABLED behind an explicit `--execute` flag,
 * and run `auditReplayability.ts` first — the plan below is only as good as the
 * verdicts it is built on.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not invent rules. A record whose settlement rules cannot be read out
 * of its own data gets `ruleSnapshot = null` and `engineVersion = null`, and
 * keeps them. The club's current settings are never consulted — not as a
 * fallback, not as a default, not "just for the unreplayable ones". Such a
 * revision still does its job: it preserves the OUTPUTS, so the night is
 * recoverable even though it is not correctable. Those two facts are
 * consistent, and both have to reach the screen.
 */

import { PrismaClient } from '@prisma/client';
import {
  Assessment,
  AuditRowLike,
  RecordUnderAudit,
  StoredPlayer,
  assess,
  evidenceFrom,
} from '../modules/settlementHistory/replayability.js';
import { SettlementSettings } from '../modules/offlineSessions/settlementEngine.js';

/**
 * The safety catch. Step 1 is investigation and preparation; nothing about it
 * writes. Turning this on is a step 4 decision, made with the table in place
 * and an approved plan in hand.
 */
const EXECUTION_ENABLED = false;

/**
 * One connection, and only one.
 *
 * The audit is a handful of sequential reads, so it needs exactly one slot —
 * and production sits behind a pooler with fifteen client slots in total,
 * shared by every running instance. `new PrismaClient()` would ask for
 * `num_cpus * 2 + 1` of them, decided by whichever laptop runs the script, and
 * a script that takes a third of production's connection budget to count rows
 * is a script that can cause the outage it was written to prevent.
 */
function readOnlyClient(): PrismaClient {
  const raw = process.env.DATABASE_URL;
  if (!raw) return new PrismaClient();
  try {
    const url = new URL(raw);
    url.searchParams.set('connection_limit', '1');
    url.searchParams.set('pool_timeout', '30');
    return new PrismaClient({ datasources: { db: { url: url.toString() } } });
  } catch {
    return new PrismaClient();
  }
}

const prisma = readOnlyClient();

/**
 * A row of `SettlementRevision` as SETTLEMENT-HISTORY-DESIGN.md §8 defines it.
 *
 * Written here as a plain interface rather than a Prisma type because the model
 * does not exist yet. When step 4 adds it, this interface should be deleted and
 * the generated type used instead — if the two ever disagree, the schema wins
 * and this script is the thing that is wrong.
 */
interface PlannedRevision {
  recordId: string;
  recordType: 'cashout' | 'historical';
  revision: 1;
  isLive: true;
  supersedesRevision: null;

  /** Null where it cannot be read from data. Never guessed. */
  engineVersion: number | null;
  ruleVersionId: null;
  ruleSnapshot: SettlementSettings | null;

  /**
   * The replay basis, lifted out of `playerSummaries` / `playerStats` and kept
   * separately from here on — §13.1. Order is preserved verbatim: for a v1
   * night with an indivisible seat fee, and for any TOP_N tie, it is
   * arithmetic rather than presentation.
   */
  inputs: { userId: string | null; name: string; totalBuyIn: number; cashOut: number }[];

  /**
   * What the record currently says, exactly as it says it. This is the copy the
   * first overwrite falls back to, so it is transcribed rather than recomputed —
   * recomputing it here would defeat the purpose of having it.
   *
   * `seatFee` and `winnersCut` are null for every backfilled row: the stored
   * figure fuses them (finding 11), and step 3 splits them for records written
   * from then on. A historical row cannot be un-fused after the fact.
   */
  outputs: {
    userId: string | null;
    netResult: number;
    rakeDeduction: number | null;
    seatFee: null;
    winnersCut: null;
    mismatchDeduction: number | null;
  }[];

  /**
   * WHY seatFee and winnersCut are null, recorded on the row rather than left
   * to be rediscovered.
   *
   * A screen that shows a blank seat fee has to be able to say whether that
   * means "zero" or "never stored". This says which, in the row itself, so no
   * reader ever has to date the record against a release to find out.
   */
  splitUnavailableReason: string;

  totals: {
    totalBuyIns: number | null;
    totalCashOuts: number | null;
    rakeCollected: number | null;
    potContribution: number | null;
  };

  causedBy: 'settle';
  causeId: null;
  reason: string;
  requestedBy: string | null;
  approvedBy: null;
  createdAt: Date;

  /** Carried from the audit so the UI can say why a night cannot be corrected. */
  replayable: boolean;
}

async function main() {
  const [settlements, historicals, audits, sessions] = await Promise.all([
    prisma.cashOutSettlement.findMany({
      select: {
        id: true, clubId: true, sessionId: true, sessionType: true, isDeleted: true,
        totalBuyIns: true, totalCashOuts: true, rakeCollected: true, potAdjustment: true,
        playerSummaries: true, settledAt: true, settledBy: true,
      },
    }),
    prisma.historicalSessionRecord.findMany({
      select: {
        id: true, clubId: true, sessionType: true, isDeleted: true,
        playerStats: true, sessionDate: true, createdAt: true, importedBy: true,
      },
    }),
    prisma.auditLog.findMany({ select: { sessionId: true, action: true, changes: true } }),
    prisma.pokerSession.findMany({ select: { id: true, engineState: true } }),
  ]);

  const snapshotBySession = new Map<string, unknown>(
    sessions.map((s) => [s.id, (s.engineState as Record<string, unknown> | null)?.settlementRules])
  );
  const auditsByRecord = new Map<string, AuditRowLike[]>();
  for (const a of audits) {
    if (!a.sessionId) continue;
    const list = auditsByRecord.get(a.sessionId) ?? [];
    list.push({ action: a.action, changes: a.changes });
    auditsByRecord.set(a.sessionId, list);
  }

  const planned: PlannedRevision[] = [];

  for (const s of settlements) {
    const rows = Array.isArray(s.playerSummaries) ? (s.playerSummaries as Record<string, unknown>[]) : [];
    const players: StoredPlayer[] = rows.map((p) => ({
      userId: (p.userId as string) ?? null,
      name: String(p.userDisplayName ?? ''),
      totalBuyIn: p.totalBuyIn,
      cashOut: p.cashOut,
      storedNet: p.netResult,
    }));
    const record: RecordUnderAudit = {
      id: s.id, clubId: s.clubId, kind: 'cashout', isDeleted: s.isDeleted,
      sessionType: s.sessionType, occurredAt: s.settledAt.toISOString(), players,
      totals: {
        totalBuyIns: s.totalBuyIns, totalCashOuts: s.totalCashOuts,
        rakeCollected: s.rakeCollected, potAdjustment: s.potAdjustment,
      },
      evidence: stripDisagreement(evidenceFrom({
        auditRows: auditsByRecord.get(s.id) ?? [],
        sessionSnapshot: snapshotBySession.get(s.sessionId),
        sessionType: s.sessionType,
        kind: 'cashout',
      })),
    };

    planned.push(plan(record, assess(record), rows, s.settledAt, s.settledBy));
  }

  for (const h of historicals) {
    const rows = Array.isArray(h.playerStats) ? (h.playerStats as Record<string, unknown>[]) : [];
    const players: StoredPlayer[] = rows.map((p) => ({
      userId: (p.userId as string) ?? null,
      name: String(p.userName ?? ''),
      totalBuyIn: p.totalBuyIn,
      cashOut: p.cashOut,
      storedNet: p.profit,
    }));
    const record: RecordUnderAudit = {
      id: h.id, clubId: h.clubId, kind: 'historical', isDeleted: h.isDeleted,
      sessionType: h.sessionType, occurredAt: h.sessionDate, players, totals: {},
      evidence: stripDisagreement(evidenceFrom({
        auditRows: auditsByRecord.get(h.id) ?? [],
        sessionSnapshot: null,
        sessionType: h.sessionType,
        kind: 'historical',
        importedBy: h.importedBy,
      })),
    };

    planned.push(plan(record, assess(record), rows, h.createdAt, h.importedBy));
  }

  print(planned);

  if (!EXECUTION_ENABLED) {
    console.log('\nDRY RUN — nothing was written.');
    console.log('SettlementRevision does not exist until step 4. This script plans; it does not execute.\n');
    return;
  }

  // TODO(step 4): with the model in place —
  //   await prisma.$transaction(planned.map((r) => prisma.settlementRevision.create({ data: r })));
  // One transaction, and the partial unique index on (recordId, recordType)
  // WHERE isLive makes a second run fail loudly rather than duplicate silently.
  throw new Error('Execution path is not implemented until SettlementRevision exists (step 4).');
}

function stripDisagreement<T extends { rulesDisagree: boolean }>(e: T): Omit<T, 'rulesDisagree'> {
  const { rulesDisagree, ...rest } = e;
  return rest;
}

function plan(
  record: RecordUnderAudit,
  verdict: Assessment,
  raw: Record<string, unknown>[],
  createdAt: Date,
  actor: string | null
): PlannedRevision {
  const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  return {
    recordId: record.id,
    recordType: record.kind,
    revision: 1,
    isLive: true,
    supersedesRevision: null,

    engineVersion: verdict.engineVersion,
    ruleVersionId: null,
    ruleSnapshot: record.evidence.rules,

    inputs: record.players.map((p) => ({
      userId: p.userId ?? null,
      name: p.name,
      totalBuyIn: Number(p.totalBuyIn ?? 0),
      cashOut: Number(p.cashOut ?? 0),
    })),

    outputs: raw.map((p) => ({
      userId: (p.userId as string) ?? null,
      // `netResult` on a settlement, `profit` on a back-dated record. Same
      // quantity, two column names, and the revision normalises it once here.
      netResult: numOrNull(p.netResult ?? p.profit) ?? 0,
      // `winnersCutDeduction` is misnamed: settleSession writes the FUSED
      // rakeDeduction into it. Transcribed under its true meaning, and left
      // un-split because the parts were never stored.
      rakeDeduction: numOrNull(p.winnersCutDeduction),
      seatFee: null,
      winnersCut: null,
      mismatchDeduction: numOrNull(p.excessDeduction),
    })),

    totals: {
      totalBuyIns: record.totals.totalBuyIns ?? null,
      totalCashOuts: record.totals.totalCashOuts ?? null,
      rakeCollected: record.totals.rakeCollected ?? null,
      potContribution: record.totals.potAdjustment ?? null,
    },

    splitUnavailableReason:
      'rakeDeduction was stored as a single fused figure (seat fee + winners cut) in ' +
      'playerSummaries.winnersCutDeduction. The parts were never persisted separately and ' +
      'cannot be derived from the total. Records written from step 3 onward store both.',

    causedBy: 'settle',
    causeId: null,
    reason: `Backfilled revision 1 from the stored record (verdict: ${verdict.verdict}).`,
    requestedBy: actor,
    approvedBy: null,
    createdAt,

    replayable: verdict.verdict === 'replayable',
  };
}

function print(planned: PlannedRevision[]) {
  const withRules = planned.filter((p) => p.ruleSnapshot !== null).length;
  const withVersion = planned.filter((p) => p.engineVersion !== null).length;
  const replayable = planned.filter((p) => p.replayable).length;

  console.log('\n' + '='.repeat(64));
  console.log('REVISION 1 BACKFILL — PLAN');
  console.log('='.repeat(64));
  console.log(`\n  rows to insert              ${planned.length}`);
  console.log(`  with a rule snapshot        ${withRules}`);
  console.log(`  with an engine version      ${withVersion}`);
  console.log(`  marked replayable           ${replayable}`);
  console.log(`  preserved but locked        ${planned.length - replayable}`);
  console.log('\n  Every row preserves its outputs. Only the replayable ones can');
  console.log('  ever be corrected — the rest exist so nothing is lost, not so');
  console.log('  something can be rewritten.\n');

  const sample = planned[0];
  if (sample) {
    console.log('SAMPLE ROW');
    console.log(JSON.stringify(sample, null, 2).split('\n').map((l) => '  ' + l).join('\n'));
  }
}

main()
  .catch((err) => {
    console.error('Backfill planning failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
