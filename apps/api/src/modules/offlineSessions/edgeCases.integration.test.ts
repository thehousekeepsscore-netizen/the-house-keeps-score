import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../../lib/prisma.js';

/**
 * The four questions a poker night asks that a CRUD app does not.
 *
 *   Standing up with nothing — losing every chip is the most ordinary thing
 *   that happens at a table, and an app that rejects zero is an app that has
 *   never been to one.
 *
 *   Correcting a count — the host reads 7,400 off a stack, approves it, and
 *   sees the last 200 chip under a card thirty seconds later.
 *
 *   Freezing for settlement — figures cannot be agreed while they are moving.
 *
 *   Two doors to one seat — an admin adds Priya at the same moment Priya taps
 *   Join, and the queue must not end up asking twice about one person.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

vi.mock('../../realtime/socket.js', () => ({ emitToClub: () => {} }));

const {
  requestBuyIn, decideBuyInRequest, requestCashOut, decideCashOut, requestSitIn,
  amendCashOut, beginSettling, resumeNight, extendSession,
} = await import('./offlineSessions.service.js');

let clubId = '';
let sessionId = '';
let ownerId = '';
let priyaId = '';
let createdUsers: string[] = [];

async function seed() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mk = (role: string, name: string) =>
    prisma.user.create({
      data: { email: `edge-${role}-${stamp}@test.local`, passwordHash: 'x', displayName: name },
    });

  const [owner, priya] = await Promise.all([mk('owner', 'Edge Owner'), mk('priya', 'Priya')]);
  ownerId = owner.id;
  priyaId = priya.id;
  createdUsers = [owner.id, priya.id];

  const club = await prisma.club.create({
    data: {
      name: `Edge Test ${stamp}`,
      code: `EG${stamp}`.slice(0, 20),
      ownerId: owner.id,
      buyInMode: 'UNCAPPED',
      members: { create: [{ userId: owner.id }, { userId: priya.id }] },
    },
  });
  clubId = club.id;

  const session = await prisma.pokerSession.create({
    data: {
      clubId: club.id,
      sessionName: 'Edge Night',
      sessionType: 'OFFLINE',
      startedById: owner.id,
      engineState: {
        startedPlayingAt: new Date().toISOString(),
        activePlayerUids: [ownerId, priyaId],
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

const settle = <T>(p: Promise<T>) =>
  p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));

const stateNow = async () =>
  (await prisma.pokerSession.findUnique({ where: { id: sessionId } }))!.engineState as any;

beforeEach(seed);
afterEach(cleanup);

describe('standing up with nothing', () => {
  it('accepts a count of zero, because losing every chip is normal', async () => {
    // The most ordinary thing that happens at a poker table. An app that
    // rejects it is an app that has never been to one.
    await requestCashOut(sessionId, clubId, priyaId, 0);
    const state = await stateNow();
    expect(state.cashOuts[0]).toMatchObject({ userId: priyaId, amount: 0, status: 'pending' });
  });

  it('confirms a zero count and frees the seat like any other', async () => {
    await requestCashOut(sessionId, clubId, priyaId, 0);
    await decideCashOut(sessionId, clubId, ownerId, false, priyaId, true);

    const state = await stateNow();
    expect(state.cashOuts[0]).toMatchObject({ amount: 0, status: 'confirmed' });
    expect(state.activePlayerUids).not.toContain(priyaId);
  });

  it('lets an admin correct a count down to zero on the way through', async () => {
    await requestCashOut(sessionId, clubId, priyaId, 500);
    await decideCashOut(sessionId, clubId, ownerId, false, priyaId, true, 0);
    expect((await stateNow()).cashOuts[0].amount).toBe(0);
  });

  it('lets somebody who busted out sit back down with nothing to bring', async () => {
    // The going-south floor is their own cash-out, so a player who left with
    // zero has a floor of zero and can rebuy for anything.
    await requestCashOut(sessionId, clubId, priyaId, 0);
    await decideCashOut(sessionId, clubId, ownerId, false, priyaId, true);

    const req = await requestBuyIn(sessionId, clubId, priyaId, 1_000);
    expect(req.amount).toBe(1_000);
  });
});

/**
 * Correcting a count that was already agreed.
 *
 * The host reads 7,400 off a stack, approves it, and finds the last 200 chip
 * under a card thirty seconds later. Nothing used to accept that: there was no
 * pending cash-out left to re-decide, requestCashOut refused a second entry, and
 * settlement treats a confirmed figure as the authority over the form — so a
 * miscount was permanent from the moment it was agreed.
 */
describe('correcting a count after it was agreed', () => {
  async function agreedAt(amount: number) {
    await requestCashOut(sessionId, clubId, priyaId, amount);
    await decideCashOut(sessionId, clubId, ownerId, false, priyaId, true);
  }

  it('lets an admin fix the figure', async () => {
    await agreedAt(7_400);
    await amendCashOut(sessionId, clubId, ownerId, false, priyaId, 7_600);
    expect((await stateNow()).cashOuts[0].amount).toBe(7_600);
  });

  it('records who changed it and when, rather than changing it silently', async () => {
    // A figure that moved after it was agreed is exactly what an audit trail is
    // for.
    await agreedAt(7_400);
    await amendCashOut(sessionId, clubId, ownerId, false, priyaId, 7_600);
    expect((await stateNow()).cashOuts[0]).toMatchObject({ amendedBy: ownerId });
    expect((await stateNow()).cashOuts[0].amendedAt).toBeTruthy();
  });

  it('corrects downward too, including to nothing', async () => {
    await agreedAt(7_400);
    await amendCashOut(sessionId, clubId, ownerId, false, priyaId, 0);
    expect((await stateNow()).cashOuts[0].amount).toBe(0);
  });

  it('has nothing to correct for somebody who never stood up', async () => {
    await expect(
      amendCashOut(sessionId, clubId, ownerId, false, priyaId, 7_600)
    ).rejects.toMatchObject({ status: 404 });
  });

  it('is not a thing a player can do to their own figure', async () => {
    await agreedAt(7_400);
    await expect(
      amendCashOut(sessionId, clubId, priyaId, false, priyaId, 9_999)
    ).rejects.toMatchObject({ status: 403 });
  });

  it('stops being possible once the night is settled', async () => {
    // The natural edge: agreed figures are a receipt, and a receipt that can be
    // edited is not one.
    await agreedAt(7_400);
    await prisma.pokerSession.update({ where: { id: sessionId }, data: { status: 'settled' } });
    await expect(
      amendCashOut(sessionId, clubId, ownerId, false, priyaId, 7_600)
    ).rejects.toMatchObject({ status: 409 });
  });
});

/**
 * Nothing moves while the night is being settled.
 *
 * Settlement agrees a set of figures, and figures cannot be agreed while they
 * are still changing underneath. A buy-in approved between the host opening the
 * settle screen and pressing confirm is money nobody accounted for.
 */
describe('freezing the table to settle', () => {
  it('refuses every money movement while settling', async () => {
    await beginSettling(sessionId, clubId, ownerId, false);
    expect((await stateNow()).settlingAt).toBeTruthy();

    await expect(requestBuyIn(sessionId, clubId, priyaId, 1_000)).rejects.toMatchObject({
      status: 409,
    });
    await expect(requestCashOut(sessionId, clubId, priyaId, 500)).rejects.toMatchObject({
      status: 409,
    });
    await expect(requestSitIn(sessionId, clubId, priyaId)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses approvals too, not just requests', async () => {
    // The dangerous half. A request that cannot be created is obvious; one
    // already in the queue being waved through mid-settlement is not.
    const req = await requestBuyIn(sessionId, clubId, priyaId, 1_000);
    await beginSettling(sessionId, clubId, ownerId, false);

    await expect(
      decideBuyInRequest(sessionId, ownerId, false, req.id, true)
    ).rejects.toMatchObject({ status: 409 });
  });

  it('freezes the clock controls as well', async () => {
    await prisma.pokerSession.update({
      where: { id: sessionId },
      data: {
        engineState: {
          startedPlayingAt: new Date().toISOString(),
          durationMinutes: 120,
          activePlayerUids: [ownerId, priyaId],
          settlingAt: new Date().toISOString(),
        } as any,
      },
    });
    await expect(extendSession(sessionId, clubId, ownerId, false, 30)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('gives the table back, because a mis-tap must not end an evening', async () => {
    await beginSettling(sessionId, clubId, ownerId, false);
    await resumeNight(sessionId, clubId, ownerId, false);

    expect((await stateNow()).settlingAt).toBeNull();
    const req = await requestBuyIn(sessionId, clubId, priyaId, 1_000);
    expect(req.amount).toBe(1_000);
  });

  it('is idempotent, so two hosts tapping together stamp one time', async () => {
    const first: any = await beginSettling(sessionId, clubId, ownerId, false);
    const second: any = await beginSettling(sessionId, clubId, ownerId, false);
    expect(second.settlingAt).toBe(first.settlingAt);
  });

  it('is not a thing a player can start or stop', async () => {
    await expect(beginSettling(sessionId, clubId, priyaId, false)).rejects.toMatchObject({
      status: 403,
    });
    await beginSettling(sessionId, clubId, ownerId, false);
    await expect(resumeNight(sessionId, clubId, priyaId, false)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('two doors to one seat', () => {
  it('refuses a second pending buy-in for the same player', async () => {
    // An admin adds Priya at the same moment Priya taps Join. One seat, one
    // question in the queue.
    await requestBuyIn(sessionId, clubId, priyaId, 5_000, ownerId);
    await expect(requestBuyIn(sessionId, clubId, priyaId, 3_000)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses it even when both arrive in the same instant', async () => {
    // The check is read-then-write, so without a guarantee underneath it two
    // simultaneous calls can both find nothing pending and both insert.
    const [a, b] = await Promise.all([
      settle(requestBuyIn(sessionId, clubId, priyaId, 5_000, ownerId)),
      settle(requestBuyIn(sessionId, clubId, priyaId, 3_000)),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const pending = await prisma.buyInRequest.count({
      where: { sessionId, userId: priyaId, status: 'pending' },
    });
    expect(pending).toBe(1);
  });

  it('asks once when one door is a sit-in and the other a buy-in', async () => {
    /*
     * Different tables in the database and one person in the room.
     *
     * Approving a buy-in seats them anyway, so a sit-in left standing beside it
     * asks the host to make two decisions about one chair — and answering only
     * one of them leaves a half-arrived player on the felt. The buy-in is the
     * more complete request, so it supersedes.
     */
    await prisma.pokerSession.update({
      where: { id: sessionId },
      data: {
        engineState: {
          startedPlayingAt: new Date().toISOString(),
          activePlayerUids: [ownerId],
          pendingSitInUids: [],
          cashOuts: [],
        } as any,
      },
    });

    await requestSitIn(sessionId, clubId, priyaId);
    await requestBuyIn(sessionId, clubId, priyaId, 5_000, ownerId);

    const state = await stateNow();
    expect(state.pendingSitInUids).not.toContain(priyaId);
    expect(state.sitInRequestedAt?.[priyaId]).toBeUndefined();
    expect(
      await prisma.buyInRequest.count({ where: { sessionId, userId: priyaId, status: 'pending' } })
    ).toBe(1);
  });
});
