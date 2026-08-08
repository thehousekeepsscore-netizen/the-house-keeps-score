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
  amendCashOut, beginSettling, resumeNight, extendSession, removeFromLobby, startPlaying,
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
    /*
     * Defence in depth, and it can only be reached by forcing the state.
     *
     * Settlement now refuses to begin with anything in the queue, so a pending
     * request and a frozen table cannot coexist through any normal path. The
     * guard still has to hold: two rules protecting one invariant is the point,
     * because the first one is a check and the second one is the rule.
     */
    const req = await requestBuyIn(sessionId, clubId, priyaId, 1_000);
    const state = await stateNow();
    await prisma.pokerSession.update({
      where: { id: sessionId },
      data: { engineState: { ...state, settlingAt: new Date().toISOString() } as any },
    });

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

  it('refuses a second attempt rather than silently restamping', async () => {
    // The state machine has no settling → settling transition, and the refusal
    // says what to press instead. Quietly succeeding would have moved the
    // timestamp under a host who thought nothing happened.
    await beginSettling(sessionId, clubId, ownerId, false);
    await expect(beginSettling(sessionId, clubId, ownerId, false)).rejects.toMatchObject({
      status: 409,
    });
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

/**
 * Starting the night never approves anything.
 *
 * Four ready, two still waiting on a buy-in, and the host says go. The two who
 * are waiting do not become spectators and are not waved through: their requests
 * carry on through the queue exactly as they were, and they sit down when
 * somebody approves them. Late arrivals are the normal case, not an exception.
 */
describe('starting with a queue still open', () => {
  async function lobbyWithPending() {
    await prisma.pokerSession.update({
      where: { id: sessionId },
      data: {
        engineState: {
          startedPlayingAt: null,
          activePlayerUids: [ownerId, priyaId],
          pendingSitInUids: [],
          cashOuts: [],
        } as any,
      },
    });
    // Two ready.
    for (const uid of [ownerId, priyaId]) {
      const req = await requestBuyIn(sessionId, clubId, uid, 5_000);
      await decideBuyInRequest(sessionId, ownerId, false, req.id, true);
    }
    // And one still asking.
    return requestBuyIn(sessionId, clubId, priyaId, 3_000);
  }

  it('leaves the pending request exactly as it was', async () => {
    const pending = await lobbyWithPending();
    await startPlaying(sessionId, clubId, ownerId, false);

    const row = await prisma.buyInRequest.findUnique({ where: { id: pending.id } });
    expect(row?.status).toBe('pending');
    expect(row?.approvedBy).toBeNull();
  });

  it('still approves it normally afterwards', async () => {
    const pending = await lobbyWithPending();
    await startPlaying(sessionId, clubId, ownerId, false);
    await decideBuyInRequest(sessionId, ownerId, false, pending.id, true);

    const row = await prisma.buyInRequest.findUnique({ where: { id: pending.id } });
    expect(row?.status).toBe('approved');
  });
});

/**
 * Taking somebody out of the lobby who is not coming.
 *
 * Rahul says he's in, gets marked ready, then goes home without pressing
 * anything. Nothing else removes him, so the ready count describes a room with
 * one more person in it than is actually there.
 */
describe('the lobby ghost', () => {
  async function lobby() {
    await prisma.pokerSession.update({
      where: { id: sessionId },
      data: {
        engineState: {
          startedPlayingAt: null,
          activePlayerUids: [ownerId, priyaId],
          pendingSitInUids: [],
          cashOuts: [],
        } as any,
      },
    });
  }

  it('takes a seated player with no chips out of the count', async () => {
    await lobby();
    await removeFromLobby(sessionId, clubId, ownerId, false, priyaId);
    expect((await stateNow()).activePlayerUids).not.toContain(priyaId);
  });

  it('takes their unanswered request with them', async () => {
    // A question with nobody left to answer for it.
    await lobby();
    const req = await requestBuyIn(sessionId, clubId, priyaId, 3_000);
    await removeFromLobby(sessionId, clubId, ownerId, false, priyaId);
    expect((await prisma.buyInRequest.findUnique({ where: { id: req.id } }))?.status).toBe('rejected');
  });

  it('REFUSES anyone holding chips, because that would delete money', async () => {
    // Somebody with an approved buy-in has money in the night. Making them
    // vanish erases it with no cash-out and no record — that is standing up, and
    // it goes through the count like everybody else's.
    await lobby();
    const req = await requestBuyIn(sessionId, clubId, priyaId, 5_000);
    await decideBuyInRequest(sessionId, ownerId, false, req.id, true);

    await expect(
      removeFromLobby(sessionId, clubId, ownerId, false, priyaId)
    ).rejects.toMatchObject({ status: 409 });
    expect((await stateNow()).activePlayerUids).toContain(priyaId);
  });

  it('is a lobby action only — a running night has cash-outs for this', async () => {
    await expect(
      removeFromLobby(sessionId, clubId, ownerId, false, priyaId)
    ).rejects.toMatchObject({ status: 409 });
  });

  it('is not a thing a player can do', async () => {
    await lobby();
    await expect(
      removeFromLobby(sessionId, clubId, priyaId, false, ownerId)
    ).rejects.toMatchObject({ status: 403 });
  });
});

/**
 * Pending money does not move the visible state of the game.
 *
 * A request is a question, not a bank. Two things fall out of that, and the
 * first is stronger than expected: a request ABOVE the ceiling is refused
 * outright, so it never becomes a pending row at all. The ceiling is checked
 * when somebody asks, not when somebody agrees.
 *
 * The second is the one worth guarding: a request at the ceiling sits there
 * pending without moving it, so one unapproved request can never change what
 * everybody else is allowed to take.
 */
describe('the ceiling ignores what is only asked for', () => {
  it('refuses a request above the current maximum instead of queueing it', async () => {
    const { getBuyInCeiling } = await import('./offlineSessions.service.js');
    await prisma.club.update({
      where: { id: clubId },
      data: { buyInMode: 'MATCH_HIGHEST', maxBuyIn: 10_000 },
    });

    const req = await requestBuyIn(sessionId, clubId, priyaId, 10_000);
    await decideBuyInRequest(sessionId, ownerId, false, req.id, true);
    expect(await getBuyInCeiling(sessionId, clubId)).toBe(10_000);

    await expect(requestBuyIn(sessionId, clubId, ownerId, 15_000)).rejects.toMatchObject({
      status: 400,
    });
    expect(
      await prisma.buyInRequest.count({ where: { sessionId, status: 'pending' } })
    ).toBe(0);
  });

  it('leaves the maximum alone while a request at it is still waiting', async () => {
    const { getBuyInCeiling } = await import('./offlineSessions.service.js');
    await prisma.club.update({
      where: { id: clubId },
      data: { buyInMode: 'MATCH_HIGHEST', maxBuyIn: 10_000 },
    });

    const first = await requestBuyIn(sessionId, clubId, priyaId, 4_000);
    await decideBuyInRequest(sessionId, ownerId, false, first.id, true);
    expect(await getBuyInCeiling(sessionId, clubId)).toBe(4_000);

    // Asked for, not agreed: the table maximum must not move on a question.
    const asked = await requestBuyIn(sessionId, clubId, ownerId, 4_000);
    expect(await getBuyInCeiling(sessionId, clubId)).toBe(4_000);

    await decideBuyInRequest(sessionId, ownerId, false, asked.id, true);
    expect(await getBuyInCeiling(sessionId, clubId)).toBe(4_000);
  });
});

/**
 * Rejoining while a count is still pending.
 *
 * Their intent is already on the table: they asked to stand up with a figure
 * nobody has agreed to. Letting them sit back down at the same time asks the
 * host two contradictory questions about one person.
 */
describe('rejoining mid-cash-out', () => {
  it('is refused, because they have not left yet', async () => {
    await requestCashOut(sessionId, clubId, priyaId, 7_000);
    await expect(requestSitIn(sessionId, clubId, priyaId)).rejects.toMatchObject({ status: 409 });
  });

  it('works once the count is resolved either way', async () => {
    await requestCashOut(sessionId, clubId, priyaId, 7_000);
    // Rejected: they are still seated, so there is nothing to rejoin.
    await decideCashOut(sessionId, clubId, ownerId, false, priyaId, false);
    expect((await stateNow()).activePlayerUids).toContain(priyaId);
  });
});
