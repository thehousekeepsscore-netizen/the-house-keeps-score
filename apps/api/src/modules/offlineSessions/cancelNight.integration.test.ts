import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../../lib/prisma.js';

/**
 * A night opened by mistake can be closed.
 *
 * Until this existed there was no way out: settle refuses fewer than two
 * players, the lobby could not be emptied once play began, and the club could
 * not open another night while this one was active. The only exit was to seat
 * two people, bank them, count them and settle a night nobody played.
 *
 * The rule is one sentence: a night can be cancelled while nothing is banked.
 * Voided banks do not count — nothing happened. A cancelled night is audit-log
 * only: never the active session, never history, never the ranks.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

const emitted: { event: string; payload: Record<string, unknown> }[] = [];
vi.mock('../../realtime/socket.js', () => ({
  emitToClub: (_clubId: string, event: string, payload: Record<string, unknown>) => {
    emitted.push({ event, payload });
  },
}));

const {
  cancelNight, startSession, getActiveOfflineSession, requestBuyIn, decideBuyInRequest,
  voidBuyInRequest, beginSettling, startPlaying, requestSitIn, sessionPhase,
} = await import('./offlineSessions.service.js');

let clubId = '';
let sessionId = '';
let ownerId = '';
let priyaId = '';
let memberId = '';
let createdUsers: string[] = [];

const RULES = {
  sessionRakeAmount: 0, winnersCutPercent: 0, rakeEnabled: false,
  rakeMethod: 'PERCENT_PROFIT', rakeValue: 0, potEnabled: false,
  mismatchStrategy: 'PROPORTIONAL_WINNERS', rakeOrder: 'MISMATCH_FIRST',
  winnerDefinition: 'PROFIT_POSITIVE', winnerTopN: 1, roundingRule: 'NONE',
};

async function seed(phase: 'lobby' | 'playing' = 'lobby') {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mk = (role: string, name: string) =>
    prisma.user.create({
      data: { email: `cancel-${role}-${stamp}@test.local`, passwordHash: 'x', displayName: name },
    });
  const [owner, priya, member] = await Promise.all([
    mk('owner', 'Cancel Owner'), mk('priya', 'Priya'), mk('member', 'Just A Member'),
  ]);
  ownerId = owner.id; priyaId = priya.id; memberId = member.id;
  createdUsers = [owner.id, priya.id, member.id];

  const club = await prisma.club.create({
    data: {
      name: `Cancel Test ${stamp}`,
      code: `CN${stamp}`.slice(0, 20),
      ownerId: owner.id,
      buyInMode: 'UNCAPPED',
      members: { create: [{ userId: owner.id }, { userId: priya.id }, { userId: member.id }] },
    },
  });
  clubId = club.id;

  const session = await prisma.pokerSession.create({
    data: {
      clubId: club.id,
      sessionName: 'Cancel Night',
      sessionType: 'OFFLINE',
      startedById: owner.id,
      engineState: {
        startedPlayingAt: phase === 'playing' ? new Date().toISOString() : null,
        settlementRules: RULES,
        activePlayerUids: [ownerId, priyaId],
        pendingSitInUids: [],
        cashOuts: [],
      },
    },
  });
  sessionId = session.id;
  emitted.length = 0;
}

async function cleanup() {
  if (!clubId) return;
  await prisma.auditLog.deleteMany({ where: { clubId } });
  await prisma.buyInRequest.deleteMany({ where: { clubId } });
  await prisma.pokerSession.deleteMany({ where: { clubId } });
  await prisma.clubMember.deleteMany({ where: { clubId } });
  await prisma.club.deleteMany({ where: { id: clubId } });
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  clubId = '';
}

const row = () => prisma.pokerSession.findUniqueOrThrow({ where: { id: sessionId } });
const auditRows = () => prisma.auditLog.findMany({ where: { clubId, action: 'cancel_night' } });

afterEach(cleanup);

describe('a night with nothing banked', () => {
  beforeEach(() => seed('lobby'));

  it('is cancelled: status, endedAt, an audit row, and the room is told', async () => {
    const before = await row();
    expect(before.status).toBe('active');

    const session = await cancelNight(sessionId, clubId, ownerId, false);
    expect(session.status).toBe('cancelled');

    const after = await row();
    expect(after.status).toBe('cancelled');
    expect(after.endedAt).not.toBeNull();
    expect((after.engineState as { cancelledBy?: string }).cancelledBy).toBe(ownerId);

    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].sessionTitle).toBe('Cancel Night');
    expect(audit[0].changedBy).toBe(ownerId);
    expect(audit[0].details).toMatch(/before anything was banked/);
    expect(audit[0].details).toMatch(/Nothing was recorded/);

    expect(emitted.map((e) => e.event)).toContain('club:session-cancelled');
    const payload = emitted.find((e) => e.event === 'club:session-cancelled')!.payload;
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.cancelledBy).toBe(ownerId);
  });

  it('leaves no active session, so the club can open another night', async () => {
    await cancelNight(sessionId, clubId, ownerId, false);
    expect(await getActiveOfflineSession(clubId)).toBeNull();

    const next = await startSession(clubId, ownerId, false, { sessionType: 'OFFLINE', sessionName: 'Second Try' });
    expect(next.id).not.toBe(sessionId);
    expect(next.status).toBe('active');
  });

  it('writes nothing to history, the ranks or the pot', async () => {
    await cancelNight(sessionId, clubId, ownerId, false);
    expect(await prisma.cashOutSettlement.count({ where: { clubId } })).toBe(0);
    expect(await prisma.clubPotLog.count({ where: { clubId } })).toBe(0);
  });

  it('refuses every pending request on the way out, with no one left to answer them', async () => {
    const asked = await requestBuyIn(sessionId, clubId, priyaId, 3_000);
    await cancelNight(sessionId, clubId, ownerId, false);
    const req = await prisma.buyInRequest.findUniqueOrThrow({ where: { id: asked.id } });
    expect(req.status).toBe('rejected');
    const audit = await auditRows();
    expect(audit[0].details).toMatch(/1 pending request refused/);
  });

  it('is cancellable while being played, and while frozen for settlement', async () => {
    await cleanup();
    await seed('playing');
    await beginSettling(sessionId, clubId, ownerId, false);
    // This is exactly where a host who pressed "Settle night" on an empty
    // table ends up: frozen, with nothing to count.
    const session = await cancelNight(sessionId, clubId, ownerId, false);
    expect(session.status).toBe('cancelled');
  });

  it('is cancellable when the only banks were voided — nothing happened', async () => {
    await cleanup();
    await seed('playing');
    const req = await requestBuyIn(sessionId, clubId, priyaId, 5_000);
    await decideBuyInRequest(sessionId, ownerId, false, req.id, true);
    await voidBuyInRequest(sessionId, ownerId, false, req.id);

    const session = await cancelNight(sessionId, clubId, ownerId, false);
    expect(session.status).toBe('cancelled');
  });

  it('cannot be touched again: every later mutation is refused as cancelled', async () => {
    await cancelNight(sessionId, clubId, ownerId, false);
    await expect(requestSitIn(sessionId, clubId, memberId))
      .rejects.toMatchObject({ status: 409, message: 'This night was cancelled' });
    await expect(cancelNight(sessionId, clubId, ownerId, false))
      .rejects.toMatchObject({ status: 409, message: 'This night was cancelled' });
    await expect(startPlaying(sessionId, clubId, ownerId, false))
      .rejects.toMatchObject({ status: 409 });
  });

  it('is an admin action — a member is refused and nothing changes', async () => {
    await expect(cancelNight(sessionId, clubId, memberId, false)).rejects.toMatchObject({ status: 403 });
    expect((await row()).status).toBe('active');
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('a night with chips on the table', () => {
  beforeEach(() => seed('playing'));

  it('cannot be cancelled — the way to undo money is to void it or settle it', async () => {
    const req = await requestBuyIn(sessionId, clubId, priyaId, 5_000);
    await decideBuyInRequest(sessionId, ownerId, false, req.id, true);

    await expect(cancelNight(sessionId, clubId, ownerId, false))
      .rejects.toMatchObject({ status: 409, message: /chips on the table/ });
    const after = await row();
    expect(after.status).toBe('active');
    expect(after.endedAt).toBeNull();
    expect(await auditRows()).toHaveLength(0);
    expect(emitted.map((e) => e.event)).not.toContain('club:session-cancelled');
  });
});

describe('the phase model', () => {
  it('names a cancelled night as such, not as settled', () => {
    expect(sessionPhase('cancelled', { startedPlayingAt: null } as never)).toBe('cancelled');
    expect(sessionPhase('settled', { startedPlayingAt: null } as never)).toBe('settled');
    expect(sessionPhase('active', { startedPlayingAt: null } as never)).toBe('lobby');
  });
});
