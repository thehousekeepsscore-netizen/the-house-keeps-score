import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../../lib/prisma.js';

/**
 * A night keeps the rules it started under.
 *
 * Settlement used to read rake and the winners' cut off the Club at the moment
 * somebody pressed Confirm. So a settings change at 11pm silently restated the
 * economics of a game that had been running since eight: chips bought when the
 * house took nothing, raked at whatever the club said last. Nobody at the table
 * is told, and afterwards nothing in the database shows the rules moved.
 *
 * These tests are about WHERE the configuration comes from and nothing else.
 * Not one calculation changed — settlementEngine.test.ts still owns the maths,
 * on both copies of the engine.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

vi.mock('../../realtime/socket.js', () => ({ emitToClub: () => {} }));

const {
  requestBuyIn, decideBuyInRequest, startPlaying, startSession,
  settleSession, initSettlementRules, beginSettling,
} = await import('./offlineSessions.service.js');

const { requestSessionChange } = await import('../clubRecords/clubRecords.service.js');

let clubId = '';
let sessionId = '';
let ownerId = '';
let priyaId = '';
const created: string[] = [];

const NO_RAKE = { sessionRakeAmount: 0, winnersCutPercent: 0 };
const RAKED = { sessionRakeAmount: 1_000, winnersCutPercent: 5 };

async function seed(rules: { sessionRakeAmount: number; winnersCutPercent: number }) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const owner = await prisma.user.create({
    data: { email: `snap-o-${stamp}@test.local`, passwordHash: 'x', displayName: 'Host' },
  });
  const priya = await prisma.user.create({
    data: { email: `snap-p-${stamp}@test.local`, passwordHash: 'x', displayName: 'Priya' },
  });
  ownerId = owner.id;
  priyaId = priya.id;
  created.push(owner.id, priya.id);

  const club = await prisma.club.create({
    data: {
      name: `Snapshot ${stamp}`,
      code: `SN${stamp}`.slice(0, 20),
      ownerId: owner.id,
      buyInMode: 'UNCAPPED',
      potEnabled: true,
      ...rules,
      members: { create: [{ userId: owner.id }, { userId: priya.id }] },
    },
  });
  clubId = club.id;
}

/** Opens a table, banks two players and starts the night — the snapshot point. */
async function playANight(): Promise<string> {
  const session = await startSession(clubId, ownerId, false, {
    sessionName: 'Snapshot Night',
    sessionType: 'OFFLINE',
  } as never);
  const id = (session as { id: string }).id;

  for (const uid of [ownerId, priyaId]) {
    const req = await requestBuyIn(id, clubId, uid, 10_000);
    await decideBuyInRequest(id, ownerId, false, req.id, true);
  }
  await startPlaying(id, clubId, ownerId, false);
  return id;
}

/** Reads the snapshot back out of the database, not out of memory. */
async function snapshotOf(id: string) {
  const row = await prisma.pokerSession.findUniqueOrThrow({ where: { id } });
  return (row.engineState as { settlementRules?: Record<string, unknown> }).settlementRules;
}

const changeClubTo = (rules: typeof RAKED) =>
  prisma.club.update({ where: { id: clubId }, data: rules });

/** Owner wins 5,000; Priya loses it. Rake and cut both bite on this shape. */
const entries = () => ({
  entries: [
    { userId: ownerId, buyIn: 10_000, cashOut: 15_000 },
    { userId: priyaId, buyIn: 10_000, cashOut: 5_000 },
  ],
});

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
  sessionId = '';
});

describe('a night that started free of rake stays free of it', () => {
  beforeEach(async () => {
    await seed(NO_RAKE);
    sessionId = await playANight();
  });

  it('settles at 0/0 even after the club starts charging', async () => {
    await changeClubTo(RAKED);

    await settleSession(sessionId, ownerId, false, entries());

    const settled = await prisma.cashOutSettlement.findFirstOrThrow({ where: { sessionId } });
    // The exact failure this prevents: chips bought under a house take of
    // nothing, raked 1,000 + 5% because somebody edited the club at 11pm.
    expect(settled.rakeCollected).toBe(0);
    expect(settled.totalWinnersCut).toBe(0);
  });

  it('moves nothing into the club pot either', async () => {
    await changeClubTo(RAKED);
    await settleSession(sessionId, ownerId, false, entries());

    expect(await prisma.clubPotLog.count({ where: { sessionId } })).toBe(0);
  });
});

describe('a night that started raked stays raked', () => {
  beforeEach(async () => {
    await seed(RAKED);
    sessionId = await playANight();
  });

  it('settles at 1,000 + 5% even after the club stops charging', async () => {
    await changeClubTo(NO_RAKE as typeof RAKED);

    await settleSession(sessionId, ownerId, false, entries());

    const settled = await prisma.cashOutSettlement.findFirstOrThrow({ where: { sessionId } });
    // Owner's 5,000 profit → 5% = 250, plus 1,000 EACH from two players.
    // Asserted on rakeCollected, which is the combined take. totalWinnersCut
    // now holds the winners' cut alone (both writers agree on that since the
    // canonical contract landed), so it is a different figure rather than a
    // dead one — see the split assertions in canonicalReplay.integration.test.ts.
    // Historically it was hard-coded to 0 in
    // settleSession, kept only so old history rows keep their shape.
    expect(settled.rakeCollected).toBe(2_250);
  });
});

describe('the snapshot itself', () => {
  beforeEach(async () => {
    await seed(RAKED);
    sessionId = await playANight();
  });

  it('captures every setting settleSession feeds the engine', async () => {
    const snap = await snapshotOf(sessionId);

    // Named explicitly rather than counted: this is the list settleSession
    // passes to computeSettlement, and a setting added there without being
    // added here would settle off the live club forever, silently.
    expect(Object.keys(snap ?? {}).sort()).toEqual(
      [
        'capturedAt', 'mismatchStrategy', 'potEnabled', 'rakeEnabled', 'rakeMethod',
        'rakeOrder', 'rakeValue', 'roundingRule', 'sessionRakeAmount',
        'winnerDefinition', 'winnerTopN', 'winnersCutPercent',
      ].sort()
    );
  });

  it('does NOT capture the club pot balance, which must be read live', async () => {
    // A pot-funded mismatch has to know what the pot holds at settlement, not
    // what it held at kick-off. It is a balance, not a rule.
    expect(snapshotOf(sessionId)).resolves.not.toHaveProperty('clubPotBalance');
  });

  it('survives a restart, because it lives in the row and not in memory', async () => {
    const before = await snapshotOf(sessionId);
    // Nothing in this process holds it: this is a fresh read of the JSON column.
    const row = await prisma.pokerSession.findUniqueOrThrow({ where: { id: sessionId } });
    const after = (row.engineState as { settlementRules?: unknown }).settlementRules;

    expect(after).toEqual(before);
    expect(before).toMatchObject({ sessionRakeAmount: 1_000, winnersCutPercent: 5 });
  });

  it('is not taken until the night actually starts', async () => {
    // A table can sit open for an hour. The rules that matter are the ones in
    // force when the first hand is dealt.
    //
    // The club allows one active session at a time, so the playing one from
    // beforeEach is cleared out before opening a table that stays in the lobby.
    await prisma.buyInRequest.deleteMany({ where: { sessionId } });
    await prisma.pokerSession.delete({ where: { id: sessionId } });

    const lobby = await startSession(clubId, ownerId, false, {
      sessionName: 'Still gathering', sessionType: 'OFFLINE',
    } as never);
    sessionId = (lobby as { id: string }).id;

    expect(await snapshotOf(sessionId)).toBeUndefined();
  });
});

describe('a night that predates snapshots', () => {
  beforeEach(async () => {
    await seed(NO_RAKE);
    sessionId = await playANight();
    // Exactly what an older row looks like: playing, with no rules of its own.
    const row = await prisma.pokerSession.findUniqueOrThrow({ where: { id: sessionId } });
    const state = row.engineState as Record<string, unknown>;
    delete state.settlementRules;
    await prisma.pokerSession.update({ where: { id: sessionId }, data: { engineState: state as never } });
  });

  it('REFUSES to settle rather than quietly using the club', async () => {
    // The original fault wearing a different hat: a night with no rules of its
    // own settling at whatever the club happens to say tonight.
    await changeClubTo(RAKED);

    await expect(settleSession(sessionId, ownerId, false, entries()))
      .rejects.toThrow(/before settlement rules were recorded/i);
  });

  it('books nothing at all when it refuses', async () => {
    await expect(settleSession(sessionId, ownerId, false, entries())).rejects.toThrow();

    expect(await prisma.cashOutSettlement.count({ where: { clubId } })).toBe(0);
    const row = await prisma.pokerSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.status).toBe('active');
  });

  it('settles once it has been told what it is playing for', async () => {
    await changeClubTo(RAKED);
    await initSettlementRules(sessionId, clubId, ownerId, false, RAKED);

    await settleSession(sessionId, ownerId, false, entries());

    const settled = await prisma.cashOutSettlement.findFirstOrThrow({ where: { sessionId } });
    // 1,000 a seat from two players, plus 5% of the winner's 5,000.
    expect(settled.rakeCollected).toBe(2_250);
  });

  it('records the rules that decided it, on the settlement record', async () => {
    await initSettlementRules(sessionId, clubId, ownerId, false, RAKED);
    await settleSession(sessionId, ownerId, false, entries());

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { clubId, action: 'settle_session' },
    });
    const meta = (audit.changes as { meta: { settlementRules: typeof RAKED } }).meta;
    expect(meta.settlementRules).toMatchObject(RAKED);
  });
});

describe('telling a night what it plays for', () => {
  beforeEach(async () => {
    await seed(NO_RAKE);
    sessionId = await playANight();
    const row = await prisma.pokerSession.findUniqueOrThrow({ where: { id: sessionId } });
    const state = row.engineState as Record<string, unknown>;
    delete state.settlementRules;
    await prisma.pokerSession.update({ where: { id: sessionId }, data: { engineState: state as never } });
  });

  it('succeeds once', async () => {
    await initSettlementRules(sessionId, clubId, ownerId, false, RAKED);

    expect(await snapshotOf(sessionId)).toMatchObject(RAKED);
  });

  it('fills the rest of the rules in from the club, not from nothing', async () => {
    await initSettlementRules(sessionId, clubId, ownerId, false, RAKED);
    const snap = await snapshotOf(sessionId);

    const club = await prisma.club.findUniqueOrThrow({ where: { id: clubId } });
    expect(snap?.mismatchStrategy).toBe(club.mismatchStrategy);
    expect(snap?.rakeOrder).toBe(club.rakeOrder);
    expect(snap?.winnerDefinition).toBe(club.winnerDefinition);
    expect(snap?.winnerTopN).toBe(club.winnerTopN);
    expect(snap?.roundingRule).toBe(club.roundingRule);
  });

  it('REFUSES a second attempt, so the economics cannot be walked around', async () => {
    await initSettlementRules(sessionId, clubId, ownerId, false, RAKED);

    // One admin raising the rake and another lowering it mid-game is the
    // loophole this whole mechanism exists to close.
    await expect(
      initSettlementRules(sessionId, clubId, ownerId, false, { sessionRakeAmount: 2_000, winnersCutPercent: 10 })
    ).rejects.toThrow(/already has its rules/i);

    expect(await snapshotOf(sessionId)).toMatchObject(RAKED);
  });

  it('has exactly one winner when two admins try at the same instant', async () => {
    const results = await Promise.allSettled([
      initSettlementRules(sessionId, clubId, ownerId, false, RAKED),
      initSettlementRules(sessionId, clubId, priyaId, true, { sessionRakeAmount: 2_000, winnersCutPercent: 10 }),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);

    // And the stored rules are the winner's, whole — not a blend of both.
    const snap = await snapshotOf(sessionId);
    const pairs = [
      { sessionRakeAmount: 1_000, winnersCutPercent: 5 },
      { sessionRakeAmount: 2_000, winnersCutPercent: 10 },
    ];
    expect(pairs).toContainEqual({
      sessionRakeAmount: snap?.sessionRakeAmount,
      winnersCutPercent: snap?.winnersCutPercent,
    });
  });

  it('cannot be overwritten by a club settings change afterwards', async () => {
    await initSettlementRules(sessionId, clubId, ownerId, false, RAKED);
    await changeClubTo({ sessionRakeAmount: 9_000, winnersCutPercent: 40 });

    expect(await snapshotOf(sessionId)).toMatchObject(RAKED);
  });

  it('records who, what it was, what it became, and the database clock', async () => {
    const before = new Date();
    await initSettlementRules(sessionId, clubId, ownerId, false, RAKED);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { sessionId, action: 'init_settlement_rules' },
    });
    const changes = audit.changes as { before: null; after: typeof RAKED };

    expect(audit.changedBy).toBe(ownerId);
    expect(audit.changedByName).toBe('Host');
    // Null, not the club's values: the night genuinely had no rules, and
    // writing the club's in would claim it had been playing by them.
    expect(changes.before).toBeNull();
    expect(changes.after).toMatchObject(RAKED);
    // Server-generated. The caller never supplies this.
    expect(audit.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1_000);
  });

  it('is not a thing a player can do', async () => {
    await expect(
      initSettlementRules(sessionId, clubId, priyaId, false, RAKED)
    ).rejects.toThrow(/admin/i);
  });

  it('refuses nonsense figures', async () => {
    await expect(
      initSettlementRules(sessionId, clubId, ownerId, false, { sessionRakeAmount: 0, winnersCutPercent: 140 })
    ).rejects.toThrow(/between 0 and 100/i);
    await expect(
      initSettlementRules(sessionId, clubId, ownerId, false, { sessionRakeAmount: -50, winnersCutPercent: 5 })
    ).rejects.toThrow(/cannot be negative/i);
  });

  it('is refused once the table is frozen', async () => {
    await beginSettling(sessionId, clubId, ownerId, false);

    await expect(
      initSettlementRules(sessionId, clubId, ownerId, false, RAKED)
    ).rejects.toThrow(/being settled/i);
  });

  it('changes ONLY engineState.settlementRules — not a chip on the table', async () => {
    const buyInsBefore = await prisma.buyInRequest.findMany({ where: { sessionId }, orderBy: { id: 'asc' } });
    const rowBefore = await prisma.pokerSession.findUniqueOrThrow({ where: { id: sessionId } });
    const stateBefore = { ...(rowBefore.engineState as Record<string, unknown>) };

    await initSettlementRules(sessionId, clubId, ownerId, false, RAKED);

    expect(await prisma.buyInRequest.findMany({ where: { sessionId }, orderBy: { id: 'asc' } }))
      .toEqual(buyInsBefore);

    const rowAfter = await prisma.pokerSession.findUniqueOrThrow({ where: { id: sessionId } });
    const stateAfter = rowAfter.engineState as Record<string, unknown>;
    const { settlementRules, ...restAfter } = stateAfter;
    expect(settlementRules).toBeDefined();
    // Everything else byte for byte: seats, cash-outs, the clock, the lot.
    expect(restAfter).toEqual(stateBefore);
    expect(rowAfter.status).toBe('active');
  });
});

describe('the next night', () => {
  it('picks up whatever the club says when it starts', async () => {
    await seed(NO_RAKE);
    const first = await playANight();
    await settleSession(first, ownerId, false, entries());

    await changeClubTo(RAKED);
    sessionId = await playANight();

    expect(await snapshotOf(sessionId)).toMatchObject(RAKED);
  });
});

/**
 * Correcting a settled night must not restate what it charged.
 *
 * applySessionChange re-runs the engine, so whatever it is handed decides the
 * money all over again. It read the CLUB, which is the other half of the hole
 * the snapshot closed in settleSession: a night settled at 1,000 a seat came
 * back free the moment somebody fixed a typo in a cash-out, because the club
 * charges nothing.
 *
 * Driven through the real request/approve flow rather than by calling the
 * private applier, so the authorisation and staging around it are exercised too.
 */
describe('editing a settled night', () => {
  let settlementId = '';

  beforeEach(async () => {
    await seed(RAKED);
    sessionId = await playANight();
    await settleSession(sessionId, ownerId, false, entries());
    settlementId = (await prisma.cashOutSettlement.findFirstOrThrow({ where: { sessionId } })).id;
    // The club stops charging AFTER the night settled — the exact drift.
    await changeClubTo(NO_RAKE as typeof RAKED);
  });

  /**
   * Corrects one cash-out by 500, leaving everything else as settled.
   *
   * The owner is the requester, so this applies straight away rather than
   * staging a pending change — which is the path a host actually takes.
   */
  async function editCashOutBy500() {
    const record = await prisma.cashOutSettlement.findUniqueOrThrow({ where: { id: settlementId } });
    const summaries = (record.playerSummaries as { userId: string; cashOut: number }[]).map((p) =>
      p.userId === priyaId ? { ...p, cashOut: p.cashOut + 500 } : p
    );
    return requestSessionChange(clubId, ownerId, 'Host', false, {
      sessionId: settlementId,
      sourceType: 'cashout',
      requestType: 'edit_session',
      updatedPlayerSummaries: summaries,
    } as never);
  }

  it('applies immediately for the owner, rather than staging', async () => {
    // Guards the harness: a staged change would leave the record untouched and
    // every assertion below would pass against an edit that never happened.
    expect(await editCashOutBy500()).toMatchObject({ status: 'applied' });
  });

  it('keeps charging what the night charged, not what the club charges now', async () => {
    await editCashOutBy500();

    const after = await prisma.cashOutSettlement.findUniqueOrThrow({ where: { id: settlementId } });
    // Two players at 1,000 a seat. Reading the club would have produced 0 —
    // the night would have become free retroactively.
    expect(after.rakeCollected).toBeGreaterThanOrEqual(2_000);
  });

  it('does not silently zero the rake', async () => {
    const before = await prisma.cashOutSettlement.findUniqueOrThrow({ where: { id: settlementId } });
    await editCashOutBy500();
    const after = await prisma.cashOutSettlement.findUniqueOrThrow({ where: { id: settlementId } });

    expect(before.rakeCollected).toBeGreaterThan(0);
    expect(after.rakeCollected).toBeGreaterThan(0);
  });
});
