/**
 * Does the audit tell the truth about a record the real app actually wrote?
 *
 * The unit tests build records from fixtures, which proves the classifier's
 * logic and nothing about the database. This settles a night through the
 * genuine `settleSession` — snapshot, engine, audit row, pot ledger and all —
 * then reads the row back out of Postgres and asks the audit what it thinks.
 *
 * It is the only test that can catch the audit reading the wrong column, the
 * wrong audit key, or a shape the writers stopped producing. Everything else
 * agrees with itself.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../../lib/prisma.js';
import { assess, evidenceFrom, AuditRowLike, StoredPlayer } from './replayability.js';

vi.mock('../../realtime/socket.js', () => ({ emitToClub: () => {} }));

const { requestBuyIn, decideBuyInRequest, startPlaying, startSession, settleSession } =
  await import('../offlineSessions/offlineSessions.service.js');

let clubId = '';
let ownerId = '';
let priyaId = '';
const created: string[] = [];

async function seed(rules: Record<string, unknown>) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const owner = await prisma.user.create({
    data: { email: `audit-o-${stamp}@test.local`, passwordHash: 'x', displayName: 'Host' },
  });
  const priya = await prisma.user.create({
    data: { email: `audit-p-${stamp}@test.local`, passwordHash: 'x', displayName: 'Priya' },
  });
  ownerId = owner.id;
  priyaId = priya.id;
  created.push(owner.id, priya.id);

  const club = await prisma.club.create({
    data: {
      name: `Audit ${stamp}`,
      code: `AU${stamp}`.slice(0, 20),
      ownerId: owner.id,
      buyInMode: 'UNCAPPED',
      potEnabled: true,
      ...rules,
      members: { create: [{ userId: owner.id }, { userId: priya.id }] },
    },
  });
  clubId = club.id;
}

async function playAndSettle(): Promise<string> {
  const session = await startSession(clubId, ownerId, false, {
    sessionName: 'Audit Night',
    sessionType: 'OFFLINE',
  } as never);
  const id = (session as { id: string }).id;

  for (const uid of [ownerId, priyaId]) {
    const req = await requestBuyIn(id, clubId, uid, 10_000);
    await decideBuyInRequest(id, ownerId, false, req.id, true);
  }
  await startPlaying(id, clubId, ownerId, false);
  await settleSession(id, ownerId, false, {
    entries: [
      { userId: ownerId, buyIn: 10_000, cashOut: 15_000 },
      { userId: priyaId, buyIn: 10_000, cashOut: 5_000 },
    ],
  } as never);
  return id;
}

/**
 * Rebuilds exactly what `auditReplayability.ts` builds, straight from the
 * database. If the script and this ever diverge, the script is wrong — this is
 * the shape the writers actually produce.
 */
async function auditTheSettlement() {
  const settlement = await prisma.cashOutSettlement.findFirstOrThrow({ where: { clubId } });
  const session = await prisma.pokerSession.findUniqueOrThrow({ where: { id: settlement.sessionId } });
  const auditRows: AuditRowLike[] = (
    await prisma.auditLog.findMany({ where: { sessionId: settlement.id } })
  ).map((a) => ({ action: a.action, changes: a.changes }));

  const rows = settlement.playerSummaries as unknown as Record<string, unknown>[];
  const players: StoredPlayer[] = rows.map((p) => ({
    userId: (p.userId as string) ?? null,
    name: String(p.userDisplayName ?? ''),
    totalBuyIn: p.totalBuyIn,
    cashOut: p.cashOut,
    storedNet: p.netResult,
  }));

  const { rulesDisagree, ...evidence } = evidenceFrom({
    auditRows,
    sessionSnapshot: (session.engineState as Record<string, unknown>).settlementRules,
    sessionType: settlement.sessionType,
    kind: 'cashout',
  });

  return {
    rulesDisagree,
    settlement,
    assessment: assess({
      id: settlement.id,
      clubId: settlement.clubId,
      kind: 'cashout',
      isDeleted: settlement.isDeleted,
      sessionType: settlement.sessionType,
      occurredAt: settlement.settledAt.toISOString(),
      players,
      totals: {
        totalBuyIns: settlement.totalBuyIns,
        totalCashOuts: settlement.totalCashOuts,
        rakeCollected: settlement.rakeCollected,
        potAdjustment: settlement.potAdjustment,
      },
      evidence,
    }),
  };
}

afterEach(async () => {
  if (clubId) {
    await prisma.auditLog.deleteMany({ where: { clubId } });
    await prisma.clubPotLog.deleteMany({ where: { clubId } });
    await prisma.cashOutSettlement.deleteMany({ where: { clubId } });
    await prisma.buyInRequest.deleteMany({ where: { clubId } });
    await prisma.pokerSession.deleteMany({ where: { clubId } });
    await prisma.clubMember.deleteMany({ where: { clubId } });
    await prisma.club.deleteMany({ where: { id: clubId } });
  }
  await prisma.user.deleteMany({ where: { id: { in: created.splice(0) } } });
  clubId = '';
});

describe('a night settled by the real app today', () => {
  beforeEach(() => seed({ sessionRakeAmount: 1_000, winnersCutPercent: 5 }));

  it('is replayable, and the replay reproduces it to the cent', async () => {
    await playAndSettle();
    const { assessment } = await auditTheSettlement();

    expect(assessment.verdict).toBe('replayable');
    expect(assessment.blockers).toEqual([]);
    expect(assessment.replay).toBe('matched');
    expect(assessment.worstDelta).toBe(0);
  });

  it('finds the engine version and the rules where the writers put them', async () => {
    await playAndSettle();
    const { assessment, rulesDisagree } = await auditTheSettlement();

    expect(assessment.engineVersion).toBe(3);
    // The snapshot and the audit copy come from one object in one transaction.
    expect(assessment.rulesSource).toBe('session-snapshot');
    expect(rulesDisagree).toBe(false);
  });

  it('corroborates participant order against the audit copy', async () => {
    await playAndSettle();
    const { assessment } = await auditTheSettlement();
    expect(assessment.orderCorroborated).toBe(true);
  });

  it('reports order as inert for a v3 night with no tie', async () => {
    await playAndSettle();
    const { assessment } = await auditTheSettlement();
    // v3 divides nothing, and these two players do not tie. If this ever flips
    // to true, something reintroduced an order-dependent split.
    expect(assessment.orderSensitive).toBe(false);
  });
});

describe('a night whose rules make it unreplayable', () => {
  it('refuses a MANUAL-winner night, because manualWinner was never stored', async () => {
    await seed({ sessionRakeAmount: 1_000, winnersCutPercent: 5, winnerDefinition: 'MANUAL' });
    await playAndSettle();

    const { assessment } = await auditTheSettlement();
    expect(assessment.blockers).toContain('manual-winners-lost');
    expect(assessment.verdict).toBe('missing-required-input');
  });
});

describe('a Virtual Table night', () => {
  it('is never-engine-settled, and the row proves why', async () => {
    await seed({});
    // The Virtual Table has its own service, its own host check and its own
    // end-of-night path — which is exactly why its records look nothing like a
    // settled one.
    const { createVirtualTableSession, endSession } = await import('../sessions/sessions.service.js');

    const session = await createVirtualTableSession(clubId, ownerId, 'Host', undefined, {
      tableName: 'Virtual Night',
      smallBlind: 50,
      bigBlind: 100,
      // Required by the controller's schema, and the host seat's opening bank.
      // Omit it and the seat is banked `undefined`, which reaches Prisma as NaN.
      minBuyIn: 10_000,
    } as never);
    const id = (session as { id: string }).id;
    await endSession(id, ownerId, false);

    const settlement = await prisma.cashOutSettlement.findFirstOrThrow({ where: { clubId } });
    expect(settlement.sessionType).toBe('Virtual Table Session');
    // The discriminator the audit relies on: this path writes no audit row.
    expect(await prisma.auditLog.count({ where: { sessionId: settlement.id } })).toBe(0);

    const { rulesDisagree, ...evidence } = evidenceFrom({
      auditRows: [],
      sessionSnapshot: null,
      sessionType: settlement.sessionType,
      kind: 'cashout',
    });
    expect(evidence.neverEngineSettled).toBe(true);
  });
});
