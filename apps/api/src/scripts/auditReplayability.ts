/**
 * Step 1: how much of the settlement history can actually be corrected?
 *
 *   DATABASE_URL='postgresql://…' npx tsx src/scripts/auditReplayability.ts
 *
 * READ-ONLY. This script opens no transaction, issues no write, and creates no
 * row. It is safe to point at production, and it is meant to be — the answer it
 * produces about a dev database is not the answer anyone needs.
 *
 * Add `--json <path>` to write the full per-record assessment alongside the
 * summary; the console output is the report, the file is the evidence.
 *
 * Reads and does not interpret:
 *
 *   CashOutSettlement        the settled live nights
 *   HistoricalSessionRecord  the back-dated ones
 *   PokerSession             for engineState.settlementRules (the snapshot)
 *   AuditLog                 for meta.settlementEngineVersion / settlementRules
 *
 * It never reads Club settlement columns. That is not an oversight and not an
 * optimisation — inferring a past night's rules from the club's current ones is
 * the single thing this audit exists to refuse. The connection is used for
 * nothing else, so the rule is enforced by what the query does not select.
 */

import { PrismaClient } from '@prisma/client';
import {
  Assessment,
  AuditRowLike,
  BLOCKER_REASONS,
  BlockerCode,
  RecordUnderAudit,
  StoredPlayer,
  Verdict,
  assess,
  evidenceFrom,
  summarise,
} from '../modules/settlementHistory/replayability.js';
import { writeFileSync } from 'node:fs';

const prisma = new PrismaClient();

/**
 * Nights that exist on one side of the relationship and not the other.
 *
 * Not replayability — completeness. A session marked `settled` with no
 * `CashOutSettlement` is a night the app believes finished and has no record
 * of, and it would never appear in a verdict table because there is no row to
 * assess. Counting them is how the population stays honest.
 */
interface Reconciliation {
  settledSessionsWithoutSettlement: string[];
  settlementsWithoutSession: string[];
  duplicateSessionIds: string[];
}

async function main() {
  const jsonFlag = process.argv.indexOf('--json');
  const jsonPath = jsonFlag > -1 ? process.argv[jsonFlag + 1] : null;

  const [clubs, settlements, historicals, audits, sessions] = await Promise.all([
    prisma.club.findMany({ select: { id: true, name: true } }),
    prisma.cashOutSettlement.findMany({
      select: {
        id: true, clubId: true, sessionId: true, sessionType: true, isDeleted: true,
        totalBuyIns: true, totalCashOuts: true, rakeCollected: true, potAdjustment: true,
        playerSummaries: true, settledAt: true,
      },
      orderBy: { settledAt: 'asc' },
    }),
    prisma.historicalSessionRecord.findMany({
      select: {
        id: true, clubId: true, sessionType: true, isDeleted: true,
        playerStats: true, sessionDate: true, createdAt: true, importedBy: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.auditLog.findMany({
      select: { sessionId: true, action: true, changes: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.pokerSession.findMany({ select: { id: true, engineState: true, status: true } }),
  ]);

  const clubName = new Map(clubs.map((c) => [c.id, c.name]));
  const snapshotBySession = new Map<string, unknown>(
    sessions.map((s) => [s.id, (s.engineState as Record<string, unknown> | null)?.settlementRules])
  );

  /** Audit rows keyed the way the writers key them: by the RECORD's own id. */
  const auditsByRecord = new Map<string, AuditRowLike[]>();
  for (const a of audits) {
    if (!a.sessionId) continue;
    const list = auditsByRecord.get(a.sessionId) ?? [];
    list.push({ action: a.action, changes: a.changes });
    auditsByRecord.set(a.sessionId, list);
  }

  const disagreements: string[] = [];

  const build = (
    id: string,
    clubId: string,
    kind: 'cashout' | 'historical',
    isDeleted: boolean,
    sessionType: string | null,
    occurredAt: string | null,
    players: StoredPlayer[],
    totals: RecordUnderAudit['totals'],
    liveSessionId: string | null,
    importedBy: string | null = null
  ): RecordUnderAudit => {
    const { rulesDisagree, ...evidence } = evidenceFrom({
      auditRows: auditsByRecord.get(id) ?? [],
      sessionSnapshot: liveSessionId ? snapshotBySession.get(liveSessionId) : null,
      sessionType,
      kind,
      importedBy,
    });
    if (rulesDisagree) disagreements.push(id);

    return { id, clubId, kind, isDeleted, sessionType, occurredAt, players, totals, evidence };
  };

  const records: RecordUnderAudit[] = [];

  for (const s of settlements) {
    const raw = Array.isArray(s.playerSummaries) ? (s.playerSummaries as Record<string, unknown>[]) : [];
    records.push(
      build(
        s.id, s.clubId, 'cashout', s.isDeleted, s.sessionType, s.settledAt.toISOString(),
        raw.map((p) => ({
          userId: (p.userId as string) ?? null,
          name: String(p.userDisplayName ?? ''),
          totalBuyIn: p.totalBuyIn,
          cashOut: p.cashOut,
          storedNet: p.netResult,
        })),
        {
          totalBuyIns: s.totalBuyIns,
          totalCashOuts: s.totalCashOuts,
          rakeCollected: s.rakeCollected,
          potAdjustment: s.potAdjustment,
        },
        s.sessionId
      )
    );
  }

  for (const h of historicals) {
    const raw = Array.isArray(h.playerStats) ? (h.playerStats as Record<string, unknown>[]) : [];
    records.push(
      build(
        h.id, h.clubId, 'historical', h.isDeleted, h.sessionType, h.sessionDate,
        raw.map((p) => ({
          userId: (p.userId as string) ?? null,
          name: String(p.userName ?? ''),
          totalBuyIn: p.totalBuyIn,
          cashOut: p.cashOut,
          storedNet: p.profit,
        })),
        // A historical record stores no totals of its own — there is nothing to
        // contradict, so the cross-check simply does not apply to it.
        {},
        null,
        h.importedBy
      )
    );
  }

  const sessionIds = new Set(sessions.map((s) => s.id));
  const settledSessionIds = new Set(sessions.filter((s) => s.status === 'settled').map((s) => s.id));
  const settlementSessionIds = settlements.map((s) => s.sessionId);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of settlementSessionIds) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }

  const reconciliation: Reconciliation = {
    settledSessionsWithoutSettlement: [...settledSessionIds].filter((id) => !seen.has(id)),
    settlementsWithoutSession: settlementSessionIds.filter((id) => !sessionIds.has(id)),
    duplicateSessionIds: [...duplicates],
  };

  const assessments = records.map(assess);
  report(assessments, records, clubName, disagreements, reconciliation);

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), assessments }, null, 2));
    console.log(`\nPer-record evidence written to ${jsonPath}`);
  }
}

const VERDICTS: Verdict[] = [
  'replayable',
  'missing-required-input',
  'never-engine-settled',
  'fundamentally-unrecoverable',
];

const VERDICT_LABEL: Record<Verdict, string> = {
  replayable: 'engine-settled / replayable',
  'missing-required-input': 'engine-settled, input missing',
  'never-engine-settled': 'never engine-settled',
  'fundamentally-unrecoverable': 'fundamentally unrecoverable',
};

/**
 * The whole population, and every row accounted for.
 *
 * Deleted records are a COLUMN, not a filter. An audit that reports only the
 * live rows quietly drops the awkward ones, and an undelete puts them straight
 * back into scope — so they are assessed like everything else and shown
 * alongside.
 */
function report(
  assessments: Assessment[],
  records: RecordUnderAudit[],
  clubName: Map<string, string>,
  disagreements: string[],
  reconciliation: Reconciliation
) {
  const all = summarise(assessments);
  const live = assessments.filter((a) => !a.isDeleted);
  const liveSummary = summarise(live);
  const total = assessments.length;
  const pct = (n: number, of: number) => (of === 0 ? '  — ' : `${String(Math.round((n / of) * 100)).padStart(3)}%`);

  console.log('\n' + '='.repeat(72));
  console.log('SETTLEMENT REPLAYABILITY AUDIT');
  console.log('='.repeat(72));
  console.log(`\nGenerated ${new Date().toISOString()}`);
  console.log(`Clubs: ${clubName.size}`);

  const cashout = assessments.filter((a) => a.kind === 'cashout').length;
  console.log(`\nTOTAL RECORDS                 ${total}`);
  console.log(`  CashOutSettlement           ${cashout}`);
  console.log(`  HistoricalSessionRecord     ${total - cashout}`);

  console.log('\n' + '-'.repeat(72));
  console.log('FULL POPULATION BY VERDICT'.padEnd(38) + 'TOTAL    %   LIVE  DELETED');
  console.log('-'.repeat(72));
  for (const v of VERDICTS) {
    const n = all.byVerdict[v];
    const del = assessments.filter((a) => a.verdict === v && a.isDeleted).length;
    console.log(
      `  ${VERDICT_LABEL[v].padEnd(34)} ${String(n).padStart(5)}  ${pct(n, total)}  ${String(n - del).padStart(5)}  ${String(del).padStart(7)}`
    );
  }
  console.log('-'.repeat(72));
  console.log(
    `  ${'accounted for'.padEnd(34)} ${String(VERDICTS.reduce((s, v) => s + all.byVerdict[v], 0)).padStart(5)}` +
    `   of ${total}`
  );

  console.log('\nEVIDENCE (all records)');
  const ev = (label: string, n: number) => console.log(`  ${label.padEnd(34)} ${String(n).padStart(5)}  ${pct(n, total)}`);
  ev('replay reproduced the record', all.replayMatched);
  ev('replay DISAGREED', all.replayMismatched);
  ev('participant order changes the money', all.orderSensitive);
  ev('order corroborated by a second copy', all.orderCorroborated);

  const blockers = Object.entries(all.byBlocker).sort((a, b) => b[1] - a[1]);
  console.log('\n' + '-'.repeat(72));
  console.log('WHY NON-REPLAYABLE RECORDS CANNOT BE REPLAYED');
  console.log('-'.repeat(72));
  if (blockers.length === 0) {
    console.log('  (no blockers raised)');
  }
  for (const [code, count] of blockers) {
    console.log(`\n  ${code} — ${count} record(s)`);
    console.log(`    ${BLOCKER_REASONS[code as BlockerCode] ?? '(unknown code)'}`);
  }
  // A record can carry several blockers, so these do not sum to the verdict
  // counts. Said explicitly rather than left for someone to trip over.
  if (blockers.length > 1) {
    console.log('\n  (a record may raise more than one blocker — these do not sum to the table above)');
  }

  const neverSettled = assessments.filter((a) => a.verdict === 'never-engine-settled');
  if (neverSettled.length > 0) {
    console.log('\n' + '-'.repeat(72));
    console.log(`LEGACY / NEVER ENGINE-SETTLED — ${neverSettled.length} record(s)`);
    console.log('-'.repeat(72));
    console.log('  Visible in History, leaderboard contribution unchanged, excluded from');
    console.log('  correction and replay. No rules inferred, no settlement reconstructed.');
    const byType = new Map<string, number>();
    for (const a of neverSettled) {
      const r = records.find((x) => x.id === a.id);
      const key = `${a.kind} / ${r?.sessionType ?? 'unknown'}`;
      byType.set(key, (byType.get(key) ?? 0) + 1);
    }
    for (const [k, n] of byType) console.log(`    ${k.padEnd(40)} ${String(n).padStart(4)}`);
  }

  const byClub = new Map<string, Assessment[]>();
  for (const a of assessments) {
    const list = byClub.get(a.clubId) ?? [];
    list.push(a);
    byClub.set(a.clubId, list);
  }
  console.log('\n' + '-'.repeat(72));
  console.log('BY CLUB (all records)');
  console.log('-'.repeat(72));
  for (const [clubId, list] of byClub) {
    const c = summarise(list);
    console.log(
      `  ${(clubName.get(clubId) ?? clubId).slice(0, 26).padEnd(26)} ${String(list.length).padStart(4)}  ` +
      `replayable ${c.byVerdict.replayable}, missing-input ${c.byVerdict['missing-required-input']}, ` +
      `never-settled ${c.byVerdict['never-engine-settled']}, unrecoverable ${c.byVerdict['fundamentally-unrecoverable']}`
    );
  }
  const clubsWithRecords = new Set(assessments.map((a) => a.clubId));
  const empty = [...clubName.keys()].filter((id) => !clubsWithRecords.has(id));
  if (empty.length > 0) console.log(`  (${empty.length} club(s) with no records at all)`);

  console.log('\n' + '-'.repeat(72));
  console.log('RECONCILIATION — rows that exist without their counterpart');
  console.log('-'.repeat(72));
  console.log(`  sessions marked settled with NO settlement row   ${reconciliation.settledSessionsWithoutSettlement.length}`);
  console.log(`  settlements pointing at a missing session        ${reconciliation.settlementsWithoutSession.length}`);
  console.log(`  settlements sharing one session id              ${reconciliation.duplicateSessionIds.length}`);
  for (const id of reconciliation.settledSessionsWithoutSettlement.slice(0, 10)) console.log(`    settled session, no record: ${id}`);
  for (const id of reconciliation.settlementsWithoutSession.slice(0, 10)) console.log(`    settlement, no session:     ${id}`);
  for (const id of reconciliation.duplicateSessionIds.slice(0, 10)) console.log(`    duplicate session id:       ${id}`);

  if (disagreements.length > 0) {
    console.log(`\n!! ${disagreements.length} record(s) whose session snapshot disagrees with their audit copy of the rules.`);
    console.log('   Both were written in the same transaction from the same object, so this should be impossible.');
    disagreements.forEach((id) => console.log(`   ${id}`));
  }

  const mismatched = assessments.filter((a) => a.replay === 'mismatched');
  if (mismatched.length > 0) {
    console.log('\n!! REPLAY DISAGREEMENTS (every input present, figures still differ)');
    mismatched.forEach((a) => {
      const r = records.find((x) => x.id === a.id);
      console.log(`   ${a.id}  ${clubName.get(a.clubId) ?? ''}  v${a.engineVersion}  worst Δ ${a.worstDelta?.toFixed(2)}  ${r?.sessionType ?? ''}`);
    });
    console.log('   Each hides an input we have not identified. Resolve before step 4.');
  }

  console.log('\nNOTES RAISED');
  const noted = assessments.filter((a) => a.notes.length > 0);
  if (noted.length === 0) console.log('  (none)');
  noted.slice(0, 25).forEach((a) => {
    console.log(`  ${a.id} [${a.verdict}]${a.isDeleted ? ' (deleted)' : ''}`);
    a.notes.forEach((n) => console.log(`      ${n}`));
  });
  if (noted.length > 25) console.log(`  … and ${noted.length - 25} more (see --json output)`);

  console.log('\n' + '='.repeat(72));
  console.log(`CORRECTABLE TODAY: ${all.byVerdict.replayable} of ${total} record(s) — ${liveSummary.byVerdict.replayable} of ${live.length} not deleted`);
  console.log('='.repeat(72) + '\n');
}

main()
  .catch((err) => {
    console.error('Audit failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
