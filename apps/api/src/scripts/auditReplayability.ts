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
    prisma.pokerSession.findMany({ select: { id: true, engineState: true } }),
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

  const assessments = records.map(assess);
  report(assessments, records, clubName, disagreements);

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), assessments }, null, 2));
    console.log(`\nPer-record evidence written to ${jsonPath}`);
  }
}

function report(
  assessments: Assessment[],
  records: RecordUnderAudit[],
  clubName: Map<string, string>,
  disagreements: string[]
) {
  const s = summarise(assessments);
  const live = assessments.filter((a) => !a.isDeleted);
  const liveSummary = summarise(live);
  const pct = (n: number, of: number) => (of === 0 ? '—' : `${Math.round((n / of) * 100)}%`);

  const line = (label: string, n: number, of: number) =>
    `  ${label.padEnd(26)} ${String(n).padStart(5)}   ${pct(n, of).padStart(4)}`;

  console.log('\n' + '='.repeat(64));
  console.log('SETTLEMENT REPLAYABILITY AUDIT');
  console.log('='.repeat(64));
  console.log(`\nGenerated ${new Date().toISOString()}`);
  console.log(`Clubs: ${clubName.size}`);

  console.log(`\nTOTAL HISTORICAL NIGHTS       ${s.total}`);
  console.log(`  of which deleted            ${s.deleted}`);
  console.log(`  live (correctable scope)    ${live.length}\n`);

  console.log('LIVE RECORDS BY VERDICT');
  (['replayable', 'partially-recoverable', 'unrecoverable', 'never-engine-settled'] as Verdict[])
    .forEach((v) => console.log(line(v, liveSummary.byVerdict[v], live.length)));

  console.log('\nEVIDENCE');
  console.log(line('replay reproduced record', liveSummary.replayMatched, live.length));
  console.log(line('replay disagreed', liveSummary.replayMismatched, live.length));
  console.log(line('order changes the money', liveSummary.orderSensitive, live.length));
  console.log(line('order corroborated by audit', liveSummary.orderCorroborated, live.length));

  const blockers = Object.entries(liveSummary.byBlocker).sort((a, b) => b[1] - a[1]);
  if (blockers.length > 0) {
    console.log('\nWHY RECORDS CANNOT BE REPLAYED');
    for (const [code, count] of blockers) {
      console.log(`\n  ${code} — ${count} record(s)`);
      console.log(`    ${BLOCKER_REASONS[code as BlockerCode] ?? '(unknown code)'}`);
    }
  }

  const byClub = new Map<string, Assessment[]>();
  for (const a of live) {
    const list = byClub.get(a.clubId) ?? [];
    list.push(a);
    byClub.set(a.clubId, list);
  }
  console.log('\nBY CLUB');
  for (const [clubId, list] of byClub) {
    const c = summarise(list);
    console.log(
      `  ${(clubName.get(clubId) ?? clubId).padEnd(28)} ${String(list.length).padStart(4)} night(s)   ` +
      `replayable ${c.byVerdict.replayable}, partial ${c.byVerdict['partially-recoverable']}, ` +
      `unrecoverable ${c.byVerdict.unrecoverable}, never-settled ${c.byVerdict['never-engine-settled']}`
    );
  }

  if (disagreements.length > 0) {
    console.log(`\n!! ${disagreements.length} record(s) whose session snapshot disagrees with their audit copy of the rules.`);
    console.log('   Both were written in the same transaction from the same object, so this should be impossible.');
    disagreements.forEach((id) => console.log(`   ${id}`));
  }

  const mismatched = live.filter((a) => a.replay === 'mismatched');
  if (mismatched.length > 0) {
    console.log('\nREPLAY DISAGREEMENTS (every input present, figures still differ)');
    mismatched.forEach((a) => {
      const r = records.find((x) => x.id === a.id);
      console.log(`  ${a.id}  ${clubName.get(a.clubId) ?? ''}  v${a.engineVersion}  worst Δ ${a.worstDelta?.toFixed(2)}  ${r?.sessionType ?? ''}`);
    });
    console.log('  Each of these hides an input we have not identified. Resolve before step 4.');
  }

  console.log('\nNOTES RAISED');
  const noted = live.filter((a) => a.notes.length > 0);
  if (noted.length === 0) console.log('  (none)');
  noted.slice(0, 40).forEach((a) => {
    console.log(`  ${a.id} [${a.verdict}]`);
    a.notes.forEach((n) => console.log(`      ${n}`));
  });
  if (noted.length > 40) console.log(`  … and ${noted.length - 40} more (see --json output)`);

  console.log('\n' + '='.repeat(64));
  console.log(`CORRECTABLE TODAY: ${liveSummary.byVerdict.replayable} of ${live.length} live night(s)`);
  console.log('='.repeat(64) + '\n');
}

main()
  .catch((err) => {
    console.error('Audit failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
