/**
 * A settled night, replayed from what was stored about it.
 *
 * This is the property step 3 exists to establish, and the only test that can
 * prove it, because it needs a real row written by the real writer:
 *
 *     stored canonicalInputs  →  engine  →  exactly the stored settlement
 *
 * with nothing read from the Club in between. The unit tests prove the contract
 * in isolation; this proves the writers actually honour it.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../../lib/prisma.js';
import {
  replayCanonical,
  validateCanonicalInputs,
  CanonicalSettlementInputs,
  CanonicalSettlementOutputs,
} from './canonicalSettlement.js';

vi.mock('../../realtime/socket.js', () => ({ emitToClub: () => {} }));

const { requestBuyIn, decideBuyInRequest, startPlaying, startSession, settleSession } =
  await import('./offlineSessions.service.js');
const { createPastSession } = await import('../clubRecords/clubRecords.service.js');

let clubId = '';
let ownerId = '';
let priyaId = '';
const created: string[] = [];

async function seed(rules: Record<string, unknown>) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const owner = await prisma.user.create({
    data: { email: `canon-o-${stamp}@test.local`, passwordHash: 'x', displayName: 'Host' },
  });
  const priya = await prisma.user.create({
    data: { email: `canon-p-${stamp}@test.local`, passwordHash: 'x', displayName: 'Priya' },
  });
  ownerId = owner.id;
  priyaId = priya.id;
  created.push(owner.id, priya.id);

  const club = await prisma.club.create({
    data: {
      name: `Canon ${stamp}`,
      code: `CN${stamp}`.slice(0, 20),
      ownerId: owner.id,
      buyInMode: 'UNCAPPED',
      potEnabled: true,
      ...rules,
      members: { create: [{ userId: owner.id }, { userId: priya.id }] },
    },
  });
  clubId = club.id;
}

async function playAndSettle() {
  const session = await startSession(clubId, ownerId, false, {
    sessionName: 'Canonical Night',
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
  return prisma.cashOutSettlement.findFirstOrThrow({ where: { clubId } });
}

afterEach(async () => {
  if (clubId) {
    await prisma.auditLog.deleteMany({ where: { clubId } });
    await prisma.clubPotLog.deleteMany({ where: { clubId } });
    await prisma.cashOutSettlement.deleteMany({ where: { clubId } });
    await prisma.historicalSessionRecord.deleteMany({ where: { clubId } });
    await prisma.buyInRequest.deleteMany({ where: { clubId } });
    await prisma.pokerSession.deleteMany({ where: { clubId } });
    await prisma.clubMember.deleteMany({ where: { clubId } });
    await prisma.club.deleteMany({ where: { id: clubId } });
  }
  await prisma.user.deleteMany({ where: { id: { in: created.splice(0) } } });
  clubId = '';
});

describe('a live settlement records its own replay contract', () => {
  beforeEach(() => seed({ sessionRakeAmount: 1_000, winnersCutPercent: 5 }));

  it('stores canonical inputs that validate and replay to the stored outputs', async () => {
    const settled = await playAndSettle();

    const inputs = settled.canonicalInputs as unknown as CanonicalSettlementInputs;
    const outputs = settled.canonicalOutputs as unknown as CanonicalSettlementOutputs;
    expect(inputs).toBeTruthy();
    expect(validateCanonicalInputs(inputs)).toEqual([]);

    const replayed = replayCanonical(inputs);
    // computedAt is a timestamp, not a figure.
    expect({ ...replayed, computedAt: '' }).toEqual({ ...outputs, computedAt: '' });
  });

  it('replays to the same money the legacy columns hold', async () => {
    const settled = await playAndSettle();
    const replayed = replayCanonical(settled.canonicalInputs as unknown as CanonicalSettlementInputs);
    const summaries = settled.playerSummaries as unknown as { userId: string; netResult: number }[];

    expect(replayed.totals.buyIns).toBe(settled.totalBuyIns);
    expect(replayed.totals.cashOuts).toBe(settled.totalCashOuts);
    expect(replayed.totals.rake).toBeCloseTo(settled.rakeCollected, 2);
    expect(replayed.totals.potContribution).toBe(settled.potAdjustment);
    for (const p of replayed.players) {
      const stored = summaries.find((s) => s.userId === p.userId)!;
      expect(p.netResult).toBeCloseTo(stored.netResult, 2);
    }
  });

  it('records the engine version on the record itself', async () => {
    const settled = await playAndSettle();
    expect(settled.engineVersion).toBe(3);
  });

  it('records participant order, and the replay refuses if it is disturbed', async () => {
    const settled = await playAndSettle();
    const inputs = settled.canonicalInputs as unknown as CanonicalSettlementInputs;
    expect(inputs.participants.map((p) => p.seatIndex)).toEqual([0, 1]);

    const shuffled = { ...inputs, participants: [inputs.participants[1], inputs.participants[0]] };
    expect(() => replayCanonical(shuffled)).toThrow(/order is not intact/);
  });

  it('is immune to the club changing its rules afterwards', async () => {
    const settled = await playAndSettle();
    const before = replayCanonical(settled.canonicalInputs as unknown as CanonicalSettlementInputs);

    // The exact failure the contract exists to prevent, and the one the club
    // snapshot only half-closed: settings edited after the night is over.
    await prisma.club.update({
      where: { id: clubId },
      data: { sessionRakeAmount: 99_999, winnersCutPercent: 90, potEnabled: false },
    });

    const reread = await prisma.cashOutSettlement.findFirstOrThrow({ where: { clubId } });
    const after = replayCanonical(reread.canonicalInputs as unknown as CanonicalSettlementInputs);
    expect({ ...after, computedAt: '' }).toEqual({ ...before, computedAt: '' });
  });

  it('tells the seat fee and the winners cut apart, and totalWinnersCut means the cut', async () => {
    const settled = await playAndSettle();
    const outputs = settled.canonicalOutputs as unknown as CanonicalSettlementOutputs;

    // 1,000 a seat from two players; 5% of the winner's profit.
    expect(outputs.totals.seatFees).toBe(2_000);
    expect(outputs.totals.winnersCut).toBeGreaterThan(0);
    expect(outputs.totals.seatFees! + outputs.totals.winnersCut!).toBeCloseTo(outputs.totals.rake, 2);

    // The column now holds the cut alone rather than 0 (settleSession) or the
    // whole rake (applySessionChange).
    expect(settled.totalWinnersCut).toBe(Math.round(outputs.totals.winnersCut!));
    expect(settled.totalWinnersCut).not.toBe(settled.rakeCollected);
  });
});

describe('a back-dated night records its rules too', () => {
  beforeEach(() => seed({ sessionRakeAmount: 500, winnersCutPercent: 10 }));

  it('stores canonical inputs that replay to the stored outputs', async () => {
    await createPastSession(clubId, ownerId, false, {
      sessionDate: '2026-07-01',
      entries: [
        { userId: ownerId, userName: 'Host', buyIn: 5_000, cashOut: 8_000 },
        { userId: priyaId, userName: 'Priya', buyIn: 5_000, cashOut: 2_000 },
      ],
    });

    const record = await prisma.historicalSessionRecord.findFirstOrThrow({ where: { clubId } });
    const inputs = record.canonicalInputs as unknown as CanonicalSettlementInputs;
    expect(record.engineVersion).toBe(3);
    expect(validateCanonicalInputs(inputs)).toEqual([]);
    // The gap this closes: record_past_session audits carried the engine
    // version and never the rules, so a back-dated night could not say what it
    // was told.
    expect(inputs.rules.sessionRakeAmount).toBe(500);
    expect(inputs.capturedFrom).toBe('createPastSession');

    const replayed = replayCanonical(inputs);
    const outputs = record.canonicalOutputs as unknown as CanonicalSettlementOutputs;
    expect({ ...replayed, computedAt: '' }).toEqual({ ...outputs, computedAt: '' });
  });
});
