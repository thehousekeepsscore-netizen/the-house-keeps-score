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
  settleSession, setSessionSettlementRules,
} = await import('./offlineSessions.service.js');

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
    // Owner's 5,000 profit → 5% = 250, plus the flat 1,000 split across two.
    // Asserted on rakeCollected alone: totalWinnersCut is hard-coded to 0 in
    // settleSession, kept only so old history rows keep their shape.
    expect(settled.rakeCollected).toBe(1_250);
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

  it('still settles rather than stranding a live game', async () => {
    await expect(settleSession(sessionId, ownerId, false, entries())).resolves.toBeDefined();
  });

  it('says on the record that it used the club, not its own rules', async () => {
    await changeClubTo(RAKED);
    await settleSession(sessionId, ownerId, false, entries());

    // NOTE: auditLog.sessionId holds the CashOutSettlement id for this action,
    // not the PokerSession id, so it cannot be looked up by the session it
    // settled. Scoped by club and action instead.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { clubId, action: 'settle_session' },
    });
    const meta = (audit.changes as { meta: Record<string, unknown> }).meta;

    // The difference between a fallback and "arbitrary current settings" is
    // that the record says which it was, and what they were.
    expect(meta.settlementRulesSource).toBe('club-at-settlement');
    expect(meta.settlementRules).toMatchObject(RAKED);
  });

  it('stamps a snapshotted night as having carried its own', async () => {
    // Rebuild one that does have a snapshot, to prove the two are told apart.
    await prisma.pokerSession.deleteMany({ where: { id: sessionId } });
    sessionId = await playANight();
    await settleSession(sessionId, ownerId, false, entries());

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { clubId, action: 'settle_session' },
      orderBy: { createdAt: 'desc' },
    });
    expect((audit.changes as { meta: { settlementRulesSource: string } }).meta.settlementRulesSource)
      .toBe('session-snapshot');
  });
});

describe('changing a running night on purpose', () => {
  beforeEach(async () => {
    await seed(NO_RAKE);
    sessionId = await playANight();
  });

  it('sets the two figures a host can actually need to correct', async () => {
    await setSessionSettlementRules(sessionId, clubId, ownerId, false, RAKED);

    expect(await snapshotOf(sessionId)).toMatchObject(RAKED);
  });

  it('settles by them afterwards', async () => {
    await setSessionSettlementRules(sessionId, clubId, ownerId, false, RAKED);
    await settleSession(sessionId, ownerId, false, entries());

    const settled = await prisma.cashOutSettlement.findFirstOrThrow({ where: { sessionId } });
    expect(settled.rakeCollected).toBe(1_250);
  });

  it('leaves how the money is worked out completely alone', async () => {
    const before = await snapshotOf(sessionId);
    await setSessionSettlementRules(sessionId, clubId, ownerId, false, RAKED);
    const after = await snapshotOf(sessionId);

    for (const key of ['mismatchStrategy', 'rakeOrder', 'winnerDefinition', 'winnerTopN', 'roundingRule']) {
      expect(after?.[key]).toEqual(before?.[key]);
    }
  });

  it('records what it was before, and who changed it', async () => {
    await setSessionSettlementRules(sessionId, clubId, ownerId, false, RAKED);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { sessionId, action: 'set_session_settlement_rules' },
    });
    const changes = audit.changes as { before: typeof RAKED; after: typeof RAKED };
    expect(changes.before).toMatchObject(NO_RAKE);
    expect(changes.after).toMatchObject(RAKED);
    expect(audit.changedBy).toBe(ownerId);
  });

  it('is not a thing a player can do', async () => {
    await expect(
      setSessionSettlementRules(sessionId, clubId, priyaId, false, RAKED)
    ).rejects.toThrow(/admin/i);
  });

  it('refuses nonsense figures', async () => {
    await expect(
      setSessionSettlementRules(sessionId, clubId, ownerId, false, { winnersCutPercent: 140 })
    ).rejects.toThrow(/between 0 and 100/i);
    await expect(
      setSessionSettlementRules(sessionId, clubId, ownerId, false, { sessionRakeAmount: -50 })
    ).rejects.toThrow(/cannot be negative/i);
  });

  it('does not touch a single chip on the table', async () => {
    const before = await prisma.buyInRequest.findMany({ where: { sessionId }, orderBy: { id: 'asc' } });
    await setSessionSettlementRules(sessionId, clubId, ownerId, false, RAKED);
    const after = await prisma.buyInRequest.findMany({ where: { sessionId }, orderBy: { id: 'asc' } });

    expect(after).toEqual(before);
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
