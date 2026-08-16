/**
 * The step 4 acceptance criterion, against a real database.
 *
 *     before backfill:  current settlement = X
 *     after  backfill:  current settlement = X
 *                       revision 1          = X
 *                       canonical inputs    = the original inputs
 *
 * No financial number changes. The unit tests prove the planner in isolation;
 * this proves it against rows the real writers produced, and — the part that
 * matters most — proves the settlement is byte-identical afterwards.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { assess, evidenceFrom, RecordUnderAudit, StoredPlayer } from './replayability.js';
import { planRevisionOne, PlannedRevisionOne } from './revisionOne.js';
import { CanonicalSettlementInputs, replayCanonical } from '../offlineSessions/canonicalSettlement.js';

vi.mock('../../realtime/socket.js', () => ({ emitToClub: () => {} }));

const { requestBuyIn, decideBuyInRequest, startPlaying, startSession, settleSession } =
  await import('../offlineSessions/offlineSessions.service.js');

let clubId = '';
let ownerId = '';
let priyaId = '';
const created: string[] = [];

async function seed() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const owner = await prisma.user.create({
    data: { email: `rev-o-${stamp}@test.local`, passwordHash: 'x', displayName: 'Host' },
  });
  const priya = await prisma.user.create({
    data: { email: `rev-p-${stamp}@test.local`, passwordHash: 'x', displayName: 'Priya' },
  });
  ownerId = owner.id;
  priyaId = priya.id;
  created.push(owner.id, priya.id);

  const club = await prisma.club.create({
    data: {
      name: `Rev ${stamp}`,
      code: `RV${stamp}`.slice(0, 20),
      ownerId: owner.id,
      buyInMode: 'UNCAPPED',
      potEnabled: true,
      sessionRakeAmount: 1_000,
      winnersCutPercent: 5,
      members: { create: [{ userId: owner.id }, { userId: priya.id }] },
    },
  });
  clubId = club.id;
}

async function settleANight() {
  const session = await startSession(clubId, ownerId, false, {
    sessionName: 'Revision Night',
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

/** Everything financial about a settlement, hashed. */
const financialDigest = (s: Record<string, unknown>) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        totalBuyIns: s.totalBuyIns,
        totalCashOuts: s.totalCashOuts,
        totalWinnersCut: s.totalWinnersCut,
        rakeCollected: s.rakeCollected,
        potAdjustment: s.potAdjustment,
        playerSummaries: s.playerSummaries,
      })
    )
    .digest('hex');

afterEach(async () => {
  if (clubId) {
    const ids = (await prisma.cashOutSettlement.findMany({ where: { clubId }, select: { id: true } })).map((r) => r.id);
    await prisma.settlementRevision.deleteMany({ where: { recordId: { in: ids } } });
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

describe('a night settled today gets revision 1 as it settles', () => {
  beforeEach(seed);

  it('writes revision 1 in the same transaction as the settlement', async () => {
    const settled = await settleANight();
    const revisions = await prisma.settlementRevision.findMany({ where: { recordId: settled.id } });

    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      recordType: 'cashout',
      revision: 1,
      isLive: true,
      supersedesRevision: null,
      causedBy: 'settle',
      engineVersion: 3,
    });
  });

  it('revision 1 replays to exactly the settlement', async () => {
    const settled = await settleANight();
    const revision = await prisma.settlementRevision.findFirstOrThrow({ where: { recordId: settled.id } });

    const replayed = replayCanonical(revision.canonicalInputs as unknown as CanonicalSettlementInputs);
    const summaries = settled.playerSummaries as unknown as { userId: string; netResult: number }[];
    for (const p of replayed.players) {
      const stored = summaries.find((s) => s.userId === p.userId)!;
      expect(p.netResult).toBeCloseTo(stored.netResult, 2);
    }
    expect(replayed.totals.rake).toBeCloseTo(settled.rakeCollected, 2);
  });

  it('keeps the seat fee and the winners cut apart, with no null reason', async () => {
    const settled = await settleANight();
    const revision = await prisma.settlementRevision.findFirstOrThrow({ where: { recordId: settled.id } });
    const outputs = revision.canonicalOutputs as unknown as { totals: { seatFees: number | null } };

    expect(outputs.totals.seatFees).toBe(2_000);
    expect(revision.splitUnavailableReason).toBeNull();
    expect(revision.inputsIncompleteReason).toBeNull();
  });

  it('refuses a second live revision for the same record', async () => {
    const settled = await settleANight();
    // The partial unique index, exercised rather than assumed. Two current
    // settlements for one night is the state this design exists to make
    // impossible.
    await expect(
      prisma.settlementRevision.create({
        data: {
          recordId: settled.id,
          recordType: 'cashout',
          revision: 2,
          isLive: true,
          canonicalOutputs: {} as never,
          totals: {} as never,
          causedBy: 'bank-edit',
          reason: 'should not be allowed while revision 1 is live',
        },
      })
    ).rejects.toThrow();
  });
});

describe('backfilling a record that predates the contract', () => {
  beforeEach(seed);

  it('leaves the settlement byte-identical, and revision 1 matches it', async () => {
    const settled = await settleANight();

    /*
     * Turn the row back into a pre-contract record: drop the canonical columns
     * and the revision, exactly as a night settled in July looks. The audit's
     * evidence still finds the rules on the session snapshot, so this record is
     * `replayable` and therefore eligible — which is the case the backfill has
     * to get right.
     */
    await prisma.settlementRevision.deleteMany({ where: { recordId: settled.id } });
    await prisma.cashOutSettlement.update({
      where: { id: settled.id },
      data: { canonicalInputs: Prisma_null(), canonicalOutputs: Prisma_null(), engineVersion: null },
    });

    const before = await prisma.cashOutSettlement.findUniqueOrThrow({ where: { id: settled.id } });
    const beforeDigest = financialDigest(before as unknown as Record<string, unknown>);

    // --- plan and write, exactly as the script does ---
    const raw = before.playerSummaries as unknown as Record<string, unknown>[];
    const players: StoredPlayer[] = raw.map((p) => ({
      userId: (p.userId as string) ?? null,
      name: String(p.userDisplayName ?? ''),
      totalBuyIn: p.totalBuyIn,
      cashOut: p.cashOut,
      storedNet: p.netResult,
    }));
    const session = await prisma.pokerSession.findUniqueOrThrow({ where: { id: before.sessionId } });
    const auditRows = (await prisma.auditLog.findMany({ where: { sessionId: before.id } })).map((a) => ({
      action: a.action,
      changes: a.changes,
    }));
    const { rulesDisagree, ...evidence } = evidenceFrom({
      auditRows,
      sessionSnapshot: (session.engineState as Record<string, unknown>).settlementRules,
      sessionType: before.sessionType,
      kind: 'cashout',
    });
    expect(rulesDisagree).toBe(false);

    const record: RecordUnderAudit = {
      id: before.id, clubId: before.clubId, kind: 'cashout', isDeleted: before.isDeleted,
      sessionType: before.sessionType, occurredAt: before.settledAt.toISOString(), players,
      totals: {
        totalBuyIns: before.totalBuyIns, totalCashOuts: before.totalCashOuts,
        rakeCollected: before.rakeCollected, potAdjustment: before.potAdjustment,
      },
      evidence,
    };

    const verdict = assess(record);
    expect(verdict.verdict).toBe('replayable');

    const planned = planRevisionOne(record, verdict, raw, false, null);
    expect(planned.kind).toBe('plan');
    const plan = (planned as { plan: PlannedRevisionOne }).plan;

    await prisma.settlementRevision.create({
      data: {
        recordId: plan.recordId,
        recordType: plan.recordType,
        revision: 1,
        isLive: true,
        engineVersion: plan.engineVersion,
        ruleSnapshot: plan.ruleSnapshot as never,
        canonicalInputs: plan.canonicalInputs as never,
        canonicalOutputs: plan.canonicalOutputs as never,
        totals: plan.totals as never,
        causedBy: plan.causedBy,
        reason: plan.reason,
        splitUnavailableReason: plan.splitUnavailableReason,
      },
    });

    // --- the acceptance criterion ---
    const after = await prisma.cashOutSettlement.findUniqueOrThrow({ where: { id: settled.id } });
    expect(financialDigest(after as unknown as Record<string, unknown>)).toBe(beforeDigest);

    const revision = await prisma.settlementRevision.findFirstOrThrow({ where: { recordId: settled.id } });
    const outputs = revision.canonicalOutputs as unknown as {
      players: { netResult: number; seatFee: number | null }[];
      totals: { rake: number; buyIns: number };
    };
    const summaries = after.playerSummaries as unknown as { netResult: number }[];

    summaries.forEach((s, i) => expect(outputs.players[i].netResult).toBe(s.netResult));
    expect(outputs.totals.buyIns).toBe(after.totalBuyIns);
    expect(outputs.totals.rake).toBe(after.rakeCollected);

    // The inputs are the original inputs.
    const inputs = revision.canonicalInputs as unknown as CanonicalSettlementInputs;
    expect(inputs.participants.map((p) => [p.seatIndex, p.buyIn, p.cashOut])).toEqual([
      [0, 10_000, 15_000],
      [1, 10_000, 5_000],
    ]);

    // And the fused split is preserved as unknown rather than manufactured.
    expect(outputs.players.every((p) => p.seatFee === null)).toBe(true);
    expect(revision.splitUnavailableReason).toMatch(/cannot be derived from the total/);
  });
});

/** Prisma's JSON null, spelled once so the test above stays readable. */
function Prisma_null() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return null as never;
}
