import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../../lib/prisma.js';

/**
 * Nobody gives themselves money.
 *
 * Every movement in a night — joining, topping up, an admin handing someone
 * chips, and standing up with a stack — is a request that somebody else agrees
 * to. The one exception is structural rather than a loophole: the last admin in
 * the room may approve their own, because the alternative is a game that cannot
 * continue.
 *
 * These live on the server because that is where the rule is. A frontend test
 * could only prove that a button was hidden, and a hidden button is not a rule.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

vi.mock('../../realtime/socket.js', () => ({ emitToClub: () => {} }));

const { requestBuyIn, decideBuyInRequest, requestCashOut, decideCashOut, startPlaying, startSession } =
  await import('./offlineSessions.service.js');

let clubId = '';
let sessionId = '';
let ownerId = '';
let adminId = '';
let playerId = '';
let createdUsers: string[] = [];

async function seed() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mk = (role: string, name: string) =>
    prisma.user.create({
      data: { email: `money-${role}-${stamp}@test.local`, passwordHash: 'x', displayName: name },
    });

  const [owner, admin, player] = await Promise.all([
    mk('owner', 'Money Owner'),
    mk('admin', 'Money Admin'),
    mk('player', 'Money Player'),
  ]);
  ownerId = owner.id;
  adminId = admin.id;
  playerId = player.id;
  createdUsers = [owner.id, admin.id, player.id];

  const club = await prisma.club.create({
    data: {
      name: `Money Test ${stamp}`,
      code: `MN${stamp}`.slice(0, 20),
      ownerId: owner.id,
      buyInMode: 'UNCAPPED', // keep the ceiling out of these assertions
      members: {
        create: [{ userId: owner.id }, { userId: admin.id }, { userId: player.id }],
      },
      // The owner is an admin by virtue of owning it; this is the *other* one,
      // which is what makes the second-pair-of-eyes rule bite.
      admins: { create: [{ userId: admin.id }] },
    },
  });
  clubId = club.id;

  const session = await prisma.pokerSession.create({
    data: {
      clubId: club.id,
      sessionName: 'Money Night',
      sessionType: 'OFFLINE',
      startedById: owner.id,
      engineState: {
        // Already under way, so the money tests are not also lobby tests.
        startedPlayingAt: new Date().toISOString(),
        activePlayerUids: [ownerId, adminId, playerId],
        pendingSitInUids: [],
        cashOuts: [],
      },
    },
  });
  sessionId = session.id;
}

async function cleanup() {
  if (!clubId) return;
  await prisma.auditLog.deleteMany({ where: { clubId } });
  await prisma.buyInRequest.deleteMany({ where: { clubId } });
  await prisma.pokerSession.deleteMany({ where: { clubId } });
  await prisma.clubAdmin.deleteMany({ where: { clubId } });
  await prisma.clubMember.deleteMany({ where: { clubId } });
  await prisma.club.deleteMany({ where: { id: clubId } });
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  clubId = '';
}

/** Leaves the owner as the only admin, so the "last admin" branch is reachable. */
async function demoteTheOtherAdmin() {
  await prisma.clubAdmin.deleteMany({ where: { clubId, userId: adminId } });
}

beforeEach(seed);
afterEach(cleanup);

describe('a buy-in records who wrote it, not who receives it', () => {
  it('attributes an admin handing out chips to the admin', async () => {
    // This used to be stored as the recipient, which quietly defeated the rule
    // below: the request looked like the player's own, so the admin who
    // created it was free to approve it.
    const req = await requestBuyIn(sessionId, clubId, playerId, 5_000, adminId);
    expect(req.userId).toBe(playerId);
    expect(req.requestedBy).toBe(adminId);
  });

  it('attributes a player banking themselves to that player', async () => {
    const req = await requestBuyIn(sessionId, clubId, playerId, 5_000);
    expect(req.requestedBy).toBe(playerId);
  });

  it('never lands approved, whoever created it', async () => {
    const byAdmin = await requestBuyIn(sessionId, clubId, playerId, 5_000, adminId);
    expect(byAdmin.status).toBe('pending');
  });
});

describe('the second pair of eyes', () => {
  it('refuses an admin approving chips they handed out themselves', async () => {
    const req = await requestBuyIn(sessionId, clubId, playerId, 5_000, adminId);
    await expect(
      decideBuyInRequest(sessionId, adminId, false, req.id, true)
    ).rejects.toMatchObject({ status: 403 });
  });

  it('lets a different admin approve it', async () => {
    const req = await requestBuyIn(sessionId, clubId, playerId, 5_000, adminId);
    const decided = await decideBuyInRequest(sessionId, ownerId, false, req.id, true);
    expect(decided).toBeTruthy();
    const row = await prisma.buyInRequest.findUnique({ where: { id: req.id } });
    expect(row?.status).toBe('approved');
  });

  it('lets the last admin in the room approve their own, so a game cannot deadlock', async () => {
    await demoteTheOtherAdmin();
    const req = await requestBuyIn(sessionId, clubId, playerId, 5_000, ownerId);
    await decideBuyInRequest(sessionId, ownerId, false, req.id, true);
    const row = await prisma.buyInRequest.findUnique({ where: { id: req.id } });
    expect(row?.status).toBe('approved');
  });
});

describe('a cash-out is money too', () => {
  it('stays pending until somebody confirms it', async () => {
    await requestCashOut(sessionId, clubId, playerId, 7_200);
    const row = await prisma.pokerSession.findUnique({ where: { id: sessionId } });
    const state = row!.engineState as any;
    expect(state.cashOuts).toHaveLength(1);
    expect(state.cashOuts[0]).toMatchObject({ userId: playerId, amount: 7_200, status: 'pending' });
    // Still seated: the seat is only given up when the count is agreed.
    expect(state.activePlayerUids).toContain(playerId);
  });

  it('confirms the submitted figure when the admin simply agrees', async () => {
    await requestCashOut(sessionId, clubId, playerId, 7_200);
    await decideCashOut(sessionId, clubId, ownerId, false, playerId, true);

    const state = (await prisma.pokerSession.findUnique({ where: { id: sessionId } }))!
      .engineState as any;
    expect(state.cashOuts[0]).toMatchObject({ amount: 7_200, status: 'confirmed' });
    expect(state.activePlayerUids).not.toContain(playerId);
  });

  it('lets the admin correct a miscount on the way through', async () => {
    // Both people are standing over the same stack. Rejecting would ask the
    // player to re-count something the admin has already counted.
    await requestCashOut(sessionId, clubId, playerId, 7_200);
    await decideCashOut(sessionId, clubId, ownerId, false, playerId, true, 7_500);

    const state = (await prisma.pokerSession.findUnique({ where: { id: sessionId } }))!
      .engineState as any;
    expect(state.cashOuts[0]).toMatchObject({ amount: 7_500, status: 'confirmed' });
  });

  it('refuses an admin confirming their own stack while another admin is here', async () => {
    await requestCashOut(sessionId, clubId, adminId, 9_000);
    await expect(
      decideCashOut(sessionId, clubId, adminId, false, adminId, true)
    ).rejects.toMatchObject({ status: 403 });
  });

  it('lets the last admin confirm their own, for the same reason as a buy-in', async () => {
    await demoteTheOtherAdmin();
    await requestCashOut(sessionId, clubId, ownerId, 9_000);
    await decideCashOut(sessionId, clubId, ownerId, false, ownerId, true);

    const state = (await prisma.pokerSession.findUnique({ where: { id: sessionId } }))!
      .engineState as any;
    expect(state.cashOuts[0]).toMatchObject({ userId: ownerId, status: 'confirmed' });
  });
});

/**
 * Opening a table is not starting the game.
 *
 * A poker night begins when everyone is seated, has chips, and the first hand
 * is dealt — not when somebody creates a row in a database. The one moment the
 * app cannot infer is therefore written down explicitly, and these guard both
 * the gate on it and the migration that keeps every night already in progress
 * from snapping back to a lobby.
 */
describe('the night begins when the host says so', () => {
  async function openTable(over: Record<string, unknown> = {}) {
    // One admin, so the host can approve the buy-ins that make people ready
    // without the second-pair-of-eyes rule (correctly) getting in the way.
    await demoteTheOtherAdmin();
    await prisma.pokerSession.deleteMany({ where: { clubId } });
    return startSession(clubId, ownerId, false, {
      sessionType: 'OFFLINE', sessionName: 'Lobby Night', ...over,
    } as any);
  }

  it('opens a table that is not yet being played', async () => {
    const s: any = await openTable();
    expect(s.startedPlayingAt).toBeNull();
  });

  it('carries the length the host set, and whether to mention it', async () => {
    const s: any = await openTable({ durationMinutes: 120, remindAtEnd: true });
    expect(s.durationMinutes).toBe(120);
    expect(s.remindAtEnd).toBe(true);
  });

  it('refuses to start a night on fewer than two players with chips', async () => {
    const s: any = await openTable();
    await prisma.pokerSession.update({
      where: { id: s.id },
      data: { engineState: { ...(s as any), startedPlayingAt: null, activePlayerUids: [ownerId, playerId] } as any },
    });
    const req = await requestBuyIn(s.id, clubId, ownerId, 5_000);
    await decideBuyInRequest(s.id, ownerId, false, req.id, true);

    await expect(startPlaying(s.id, clubId, ownerId, false)).rejects.toMatchObject({ status: 409 });
  });

  it('starts on two, not on everybody — somebody is always still parking', async () => {
    const s: any = await openTable();
    await prisma.pokerSession.update({
      where: { id: s.id },
      data: { engineState: { startedPlayingAt: null, activePlayerUids: [ownerId, playerId, adminId], pendingSitInUids: [], cashOuts: [] } as any },
    });
    for (const uid of [ownerId, playerId]) {
      const req = await requestBuyIn(s.id, clubId, uid, 5_000);
      await decideBuyInRequest(s.id, ownerId, false, req.id, true);
    }

    const started: any = await startPlaying(s.id, clubId, ownerId, false);
    expect(started.startedPlayingAt).toBeTruthy();
  });

  it('cannot be started twice', async () => {
    const s: any = await openTable();
    await prisma.pokerSession.update({
      where: { id: s.id },
      data: { engineState: { startedPlayingAt: null, activePlayerUids: [ownerId, playerId], pendingSitInUids: [], cashOuts: [] } as any },
    });
    for (const uid of [ownerId, playerId]) {
      const req = await requestBuyIn(s.id, clubId, uid, 5_000);
      await decideBuyInRequest(s.id, ownerId, false, req.id, true);
    }
    await startPlaying(s.id, clubId, ownerId, false);
    await expect(startPlaying(s.id, clubId, ownerId, false)).rejects.toMatchObject({ status: 409 });
  });

  it('is not a thing a player can do', async () => {
    const s: any = await openTable();
    await expect(startPlaying(s.id, clubId, playerId, false)).rejects.toMatchObject({ status: 403 });
  });
});
