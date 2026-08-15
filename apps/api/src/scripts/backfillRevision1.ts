/**
 * Revision 1 for every record that already exists.
 *
 *   DATABASE_URL='…' npx tsx src/scripts/backfillRevision1.ts             # dry run
 *   DATABASE_URL='…' npx tsx src/scripts/backfillRevision1.ts --execute   # writes
 *
 * DRY RUN BY DEFAULT. Without `--execute` it reads, plans, prints and stops.
 *
 * WHAT THIS IS
 *
 * A migration of EVIDENCE, not a recalculation. Revision 1 reproduces and
 * documents what each settlement already says; it does not run the engine and
 * write down the answer. The engine is used once per record, only to *check*
 * the transcription, and a record whose check fails is skipped and reported
 * rather than corrected.
 *
 * The acceptance criterion, which `verify()` below asserts against the database
 * after writing:
 *
 *     before:  settlement = X
 *     after:   settlement = X,  revision 1 = X,  canonical inputs = the original
 *
 * No financial number changes. If one does, the transaction has already rolled
 * back — the write and the verification share it.
 *
 * WHAT IT WILL NOT DO
 *
 *   - infer a night's rules from the Club, ever
 *   - repair the record whose rules were never recorded; it is skipped
 *   - create revisions for legacy / never-engine-settled records
 *   - manufacture the seat fee / winners' cut split; null plus a stated reason
 *   - invent `manualWinner`; records whose rules read it are excluded upstream
 *
 * IDEMPOTENT. A second run finds revision 1 already present and does nothing.
 * The unique index on (recordId, recordType, revision) is the backstop under
 * concurrency, and the partial unique index on `isLive` guarantees one current
 * revision per record however many times this runs.
 */

import { PrismaClient, Prisma } from '@prisma/client';
import {
  AuditRowLike,
  RecordUnderAudit,
  StoredPlayer,
  assess,
  evidenceFrom,
} from '../modules/settlementHistory/replayability.js';
import {
  PlannedRevisionOne,
  SKIP_REASONS,
  SkipCode,
  planRevisionOne,
} from '../modules/settlementHistory/revisionOne.js';

const EXECUTE = process.argv.includes('--execute');

/**
 * One connection, and only one.
 *
 * Production sits behind a pooler with fifteen client slots shared by every
 * running instance. `new PrismaClient()` would ask for `num_cpus * 2 + 1` of
 * them, decided by whichever laptop runs the script — and a script that takes a
 * third of production's connection budget can cause the outage it exists to
 * prevent.
 */
function boundedClient(): PrismaClient {
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

const prisma = boundedClient();

interface Outcome {
  recordId: string;
  club: string;
  kind: 'cashout' | 'historical';
  planned?: PlannedRevisionOne;
  skip?: { code: SkipCode; detail: string };
}

async function main() {
  const [clubs, settlements, historicals, audits, sessions, existing] = await Promise.all([
    prisma.club.findMany({ select: { id: true, name: true } }),
    prisma.cashOutSettlement.findMany({ orderBy: { settledAt: 'asc' } }),
    prisma.historicalSessionRecord.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.auditLog.findMany({ select: { sessionId: true, action: true, changes: true } }),
    prisma.pokerSession.findMany({ select: { id: true, engineState: true } }),
    prisma.settlementRevision.findMany({ where: { revision: 1 }, select: { recordId: true, recordType: true } }),
  ]);

  const clubName = new Map(clubs.map((c) => [c.id, c.name]));
  const alreadyDone = new Set(existing.map((r) => `${r.recordType}:${r.recordId}`));
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

  const outcomes: Outcome[] = [];

  const consider = (
    record: RecordUnderAudit,
    rawPlayers: Record<string, unknown>[],
    canonical: { inputs: unknown; outputs: unknown } | null
  ) => {
    const result = planRevisionOne(
      record,
      assess(record),
      rawPlayers,
      alreadyDone.has(`${record.kind}:${record.id}`),
      canonical
    );
    outcomes.push({
      recordId: record.id,
      club: clubName.get(record.clubId) ?? record.clubId,
      kind: record.kind,
      ...(result.kind === 'plan' ? { planned: result.plan } : { skip: { code: result.code, detail: result.detail } }),
    });
  };

  for (const s of settlements) {
    const raw = Array.isArray(s.playerSummaries) ? (s.playerSummaries as Record<string, unknown>[]) : [];
    const players: StoredPlayer[] = raw.map((p) => ({
      userId: (p.userId as string) ?? null,
      name: String(p.userDisplayName ?? ''),
      totalBuyIn: p.totalBuyIn,
      cashOut: p.cashOut,
      storedNet: p.netResult,
    }));
    const { rulesDisagree, ...evidence } = evidenceFrom({
      auditRows: auditsByRecord.get(s.id) ?? [],
      sessionSnapshot: snapshotBySession.get(s.sessionId),
      sessionType: s.sessionType,
      kind: 'cashout',
    });
    void rulesDisagree;

    consider(
      {
        id: s.id, clubId: s.clubId, kind: 'cashout', isDeleted: s.isDeleted,
        sessionType: s.sessionType, occurredAt: s.settledAt.toISOString(), players,
        totals: {
          totalBuyIns: s.totalBuyIns, totalCashOuts: s.totalCashOuts,
          rakeCollected: s.rakeCollected, potAdjustment: s.potAdjustment,
        },
        evidence,
      },
      raw,
      s.canonicalInputs && s.canonicalOutputs ? { inputs: s.canonicalInputs, outputs: s.canonicalOutputs } : null
    );
  }

  for (const h of historicals) {
    const raw = Array.isArray(h.playerStats) ? (h.playerStats as Record<string, unknown>[]) : [];
    const players: StoredPlayer[] = raw.map((p) => ({
      userId: (p.userId as string) ?? null,
      name: String(p.userName ?? ''),
      totalBuyIn: p.totalBuyIn,
      cashOut: p.cashOut,
      storedNet: p.profit,
    }));
    const { rulesDisagree, ...evidence } = evidenceFrom({
      auditRows: auditsByRecord.get(h.id) ?? [],
      sessionSnapshot: null,
      sessionType: h.sessionType,
      kind: 'historical',
      importedBy: h.importedBy,
    });
    void rulesDisagree;

    consider(
      {
        id: h.id, clubId: h.clubId, kind: 'historical', isDeleted: h.isDeleted,
        sessionType: h.sessionType, occurredAt: h.sessionDate, players, totals: {},
        evidence,
      },
      raw,
      h.canonicalInputs && h.canonicalOutputs ? { inputs: h.canonicalInputs, outputs: h.canonicalOutputs } : null
    );
  }

  report(outcomes);

  const toWrite = outcomes.filter((o) => o.planned).map((o) => o.planned!);
  if (!EXECUTE) {
    console.log(`DRY RUN — nothing written. ${toWrite.length} revision(s) would be created.`);
    console.log('Re-run with --execute to write them.\n');
    return;
  }
  if (toWrite.length === 0) {
    console.log('Nothing to write.\n');
    return;
  }

  /*
   * One transaction. The write and the verification share it, so a record whose
   * figures moved takes the whole backfill down with it rather than leaving a
   * half-migrated history behind.
   */
  await prisma.$transaction(async (tx) => {
    for (const plan of toWrite) {
      await tx.settlementRevision.create({
        data: {
          recordId: plan.recordId,
          recordType: plan.recordType,
          revision: plan.revision,
          isLive: plan.isLive,
          supersedesRevision: plan.supersedesRevision,
          engineVersion: plan.engineVersion,
          ruleSnapshot: plan.ruleSnapshot as Prisma.InputJsonValue,
          canonicalInputs: plan.canonicalInputs as unknown as Prisma.InputJsonValue,
          canonicalOutputs: plan.canonicalOutputs as unknown as Prisma.InputJsonValue,
          totals: plan.totals as unknown as Prisma.InputJsonValue,
          causedBy: plan.causedBy,
          causeId: plan.causeId,
          reason: plan.reason,
          requestedBy: plan.requestedBy,
          approvedBy: plan.approvedBy,
          inputsIncompleteReason: plan.inputsIncompleteReason,
          splitUnavailableReason: plan.splitUnavailableReason,
        },
      });
    }
    await verify(tx, toWrite);
  });

  console.log(`\nWrote ${toWrite.length} revision(s). Every settlement verified unchanged.\n`);
}

/**
 * The acceptance criterion, asserted against the database inside the same
 * transaction that wrote the revisions.
 *
 * Reads the settlement back and compares it to the revision just written. A
 * mismatch throws, which rolls the whole thing back — so the backfill cannot
 * leave behind a revision that disagrees with the night it claims to preserve.
 */
async function verify(tx: Prisma.TransactionClient, plans: PlannedRevisionOne[]) {
  for (const plan of plans) {
    const revision = await tx.settlementRevision.findFirstOrThrow({
      where: { recordId: plan.recordId, recordType: plan.recordType, revision: 1 },
    });
    const outputs = revision.canonicalOutputs as unknown as PlannedRevisionOne['canonicalOutputs'];

    if (plan.recordType === 'cashout') {
      const settled = await tx.cashOutSettlement.findUniqueOrThrow({ where: { id: plan.recordId } });
      const summaries = settled.playerSummaries as unknown as { userId: string; netResult: number }[];

      if (summaries.length !== outputs.players.length) {
        throw new Error(`${plan.recordId}: revision has ${outputs.players.length} players, record has ${summaries.length}`);
      }
      summaries.forEach((s, i) => {
        if (Math.abs(s.netResult - outputs.players[i].netResult) >= 0.005) {
          throw new Error(`${plan.recordId} seat ${i}: record says ${s.netResult}, revision says ${outputs.players[i].netResult}`);
        }
      });
      if (settled.totalBuyIns !== outputs.totals.buyIns || settled.totalCashOuts !== outputs.totals.cashOuts) {
        throw new Error(`${plan.recordId}: totals disagree with the record`);
      }
    } else {
      const record = await tx.historicalSessionRecord.findUniqueOrThrow({ where: { id: plan.recordId } });
      const stats = record.playerStats as unknown as { profit: number }[];
      stats.forEach((s, i) => {
        if (Math.abs(s.profit - outputs.players[i].netResult) >= 0.005) {
          throw new Error(`${plan.recordId} seat ${i}: record says ${s.profit}, revision says ${outputs.players[i].netResult}`);
        }
      });
    }
  }
}

function report(outcomes: Outcome[]) {
  const planned = outcomes.filter((o) => o.planned);
  const skipped = outcomes.filter((o) => o.skip);

  console.log('\n' + '='.repeat(72));
  console.log(`REVISION 1 BACKFILL — ${EXECUTE ? 'EXECUTING' : 'DRY RUN'}`);
  console.log('='.repeat(72));
  console.log(`\n  records examined      ${outcomes.length}`);
  console.log(`  revisions to write    ${planned.length}`);
  console.log(`  skipped               ${skipped.length}`);

  const byCode = new Map<SkipCode, Outcome[]>();
  for (const o of skipped) {
    const list = byCode.get(o.skip!.code) ?? [];
    list.push(o);
    byCode.set(o.skip!.code, list);
  }
  if (byCode.size > 0) {
    console.log('\n' + '-'.repeat(72));
    console.log('SKIPPED, AND WHY');
    console.log('-'.repeat(72));
    for (const [code, list] of byCode) {
      console.log(`\n  ${code} — ${list.length} record(s)`);
      console.log(`    ${SKIP_REASONS[code]}`);
      for (const o of list) console.log(`      ${o.recordId}  ${o.club}  (${o.skip!.detail})`);
    }
  }

  if (planned.length > 0) {
    console.log('\n' + '-'.repeat(72));
    console.log('TO WRITE');
    console.log('-'.repeat(72));
    for (const o of planned) {
      const p = o.planned!;
      const split = p.splitUnavailableReason ? 'fused (null + reason)' : 'split known';
      console.log(
        `  ${p.recordId}  ${o.club.padEnd(18)} v${p.engineVersion}  ` +
        `${p.canonicalInputs.participants.length} player(s)  rake ${p.totals.rake}  ${split}`
      );
    }
  }
  console.log();
}

main()
  .catch((err) => {
    console.error('\nBackfill failed — nothing was written:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
