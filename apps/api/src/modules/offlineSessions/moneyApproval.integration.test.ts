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

const { requestBuyIn, decideBuyInRequest, requestCashOut, decideCashOut, startPlaying, startSession, requestSitIn, decideSitIn, extendSession, liftTimeLimit, beginSettling } =
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
        /*
         * The snapshot startPlaying would have written.
         *
         * These fixtures hand-build a night already under way rather than
         * playing one, which used to be harmless. It is not any more:
         * beginSettling refuses a night with no rules of its own, because
         * freezing one strands it. A hand-built `playing` night therefore has
         * to carry what a real one carries.
         */
        settlementRules: {
          sessionRakeAmount: 0, winnersCutPercent: 0, rakeEnabled: false,
          rakeMethod: 'PERCENT_PROFIT', rakeValue: 0, potEnabled: false,
          mismatchStrategy: 'PROPORTIONAL_WINNERS', rakeOrder: 'MISMATCH_FIRST',
          winnerDefinition: 'PROFIT_POSITIVE', winnerTopN: 1, roundingRule: 'NONE',
        },
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

/**
 * You cannot come back short of what you left with.
 *
 * The table-stakes rule every home game already plays by. A player who stands
 * up with 7,200 and sits back down with 1,000 has taken 6,200 out of the night
 * mid-game: everyone else's money is still on the felt and theirs is in their
 * pocket. Poker calls it going south, and it is the one move that changes the
 * economics of an evening without anybody losing a hand.
 */
describe('going south', () => {
  async function standPlayerUp(amount: number) {
    await requestCashOut(sessionId, clubId, playerId, amount);
    await decideCashOut(sessionId, clubId, ownerId, false, playerId, true);
  }

  it('refuses a buy-in smaller than the stack they stood up with', async () => {
    await standPlayerUp(7_200);
    await expect(requestBuyIn(sessionId, clubId, playerId, 1_000)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('allows exactly what they left with', async () => {
    await standPlayerUp(7_200);
    const req = await requestBuyIn(sessionId, clubId, playerId, 7_200);
    expect(req.amount).toBe(7_200);
  });

  it('allows more than they left with', async () => {
    await standPlayerUp(7_200);
    const req = await requestBuyIn(sessionId, clubId, playerId, 9_000);
    expect(req.amount).toBe(9_000);
  });

  it('does not constrain an ordinary top-up by somebody still sitting', async () => {
    // The floor only exists while a confirmed cash-out is standing.
    const req = await requestBuyIn(sessionId, clubId, playerId, 500);
    expect(req.amount).toBe(500);
  });

  it('does not constrain somebody who has only ASKED to stand up', async () => {
    // A submitted count is a claim nobody has agreed to. They are still sitting
    // and their chips are still on the felt, so nothing has gone south yet —
    // the floor bites on confirmation, not on the request.
    await requestCashOut(sessionId, clubId, playerId, 7_200);
    const req = await requestBuyIn(sessionId, clubId, playerId, 500);
    expect(req.amount).toBe(500);
  });

  /**
   * The normal way back, and the reason the floor is a safety net rather than
   * the mechanism: sitting down again VOIDS the cash-out and creates no buy-in
   * at all, because those chips are already theirs and already counted.
   */
  it('carries the same chips back without counting them as new money', async () => {
    await standPlayerUp(7_200);
    const before = await prisma.buyInRequest.count({ where: { sessionId, userId: playerId } });

    await requestSitIn(sessionId, clubId, playerId);
    await decideSitIn(sessionId, clubId, ownerId, false, playerId, true);

    const state = (await prisma.pokerSession.findUnique({ where: { id: sessionId } }))!
      .engineState as any;
    // Back at the table, and the locked figure is gone rather than left to
    // override whatever they finally leave with.
    expect(state.activePlayerUids).toContain(playerId);
    expect(state.cashOuts).toHaveLength(0);
    // No new buy-in: adding one would count the same chips a second time and
    // settle them that much down.
    expect(await prisma.buyInRequest.count({ where: { sessionId, userId: playerId } })).toBe(before);
  });

  it('frees the floor again once they are sitting, so a top-up is ordinary', async () => {
    await standPlayerUp(7_200);
    await requestSitIn(sessionId, clubId, playerId);
    await decideSitIn(sessionId, clubId, ownerId, false, playerId, true);

    const req = await requestBuyIn(sessionId, clubId, playerId, 1_000);
    expect(req.amount).toBe(1_000);
  });
});

/**
 * The scheduled game is a plan. The poker night is not.
 *
 * The clock reaching zero starts a conversation and ends nothing. Extensions
 * are additive and uncapped, because a limit on them would be the app deciding
 * when somebody else's evening ends. The one irreversible move is the host
 * saying the plan is over — which is what stops a night running three hours
 * long from asking the same question every five minutes.
 */
describe('the clock is a plan, not a deadline', () => {
  /**
   * A timed night that is actually being PLAYED.
   *
   * The fixture used to stop at "table open", and extending it worked — which it
   * should never have: the clock counts from the moment play starts, so a night
   * that has not started has no clock to extend. The state machine caught it.
   */
  async function timedNight(minutes = 120) {
    await demoteTheOtherAdmin();
    await prisma.pokerSession.deleteMany({ where: { clubId } });
    const s: any = await startSession(clubId, ownerId, false, {
      sessionType: 'OFFLINE', sessionName: 'Timed Night', durationMinutes: minutes,
    } as any);
    await prisma.pokerSession.update({
      where: { id: s.id },
      data: {
        engineState: { ...s, startedPlayingAt: null, activePlayerUids: [ownerId, playerId] } as any,
      },
    });
    for (const uid of [ownerId, playerId]) {
      const req = await requestBuyIn(s.id, clubId, uid, 5_000);
      await decideBuyInRequest(s.id, ownerId, false, req.id, true);
    }
    return startPlaying(s.id, clubId, ownerId, false) as any;
  }

  /** Rewinds the start so the scheduled time has already run out. */
  async function overrun(s: any, byMinutes = 1) {
    const state = (await prisma.pokerSession.findUnique({ where: { id: s.id } }))!
      .engineState as any;
    const scheduled =
      state.durationMinutes +
      (state.timeExtensions || []).reduce((sum: number, e: any) => sum + e.minutes, 0);
    await prisma.pokerSession.update({
      where: { id: s.id },
      data: {
        engineState: {
          ...state,
          startedPlayingAt: new Date(Date.now() - (scheduled + byMinutes) * 60_000).toISOString(),
        } as any,
      },
    });
  }

  it('records the length the host planned for', async () => {
    const s = await timedNight(120);
    expect(s.durationMinutes).toBe(120);
    expect(s.timeExtensions ?? []).toEqual([]);
    expect(s.timeLimitLiftedAt ?? null).toBeNull();
  });

  it('adds each extension rather than replacing the plan', async () => {
    const s = await timedNight(120);
    await overrun(s);
    await extendSession(s.id, clubId, ownerId, false, 30);
    // Running again, so it has to run out again before more time is accepted.
    await overrun(s);
    const after: any = await extendSession(s.id, clubId, ownerId, false, 60);

    // The ORIGINAL stays put so the night's story can still say what was
    // planned; the clock reads the sum.
    expect(after.durationMinutes).toBe(120);
    expect(after.timeExtensions.map((e: any) => e.minutes)).toEqual([30, 60]);
  });

  it('never caps how many times a night can be extended', async () => {
    const s = await timedNight(60);
    for (let i = 0; i < 6; i++) {
      await overrun(s);
      await extendSession(s.id, clubId, ownerId, false, 30);
    }
    const after = (await prisma.pokerSession.findUnique({ where: { id: s.id } }))!.engineState as any;
    expect(after.timeExtensions).toHaveLength(6);
  });

  it('lets the host end the plan without ending the night', async () => {
    const s = await timedNight(120);
    const after: any = await liftTimeLimit(s.id, clubId, ownerId, false);
    expect(after.timeLimitLiftedAt).toBeTruthy();
  });

  it('refuses to extend a night that has already stopped counting', async () => {
    // Otherwise a stale screen could put a clock back on a night the host has
    // already decided to run without one.
    const s = await timedNight(120);
    await liftTimeLimit(s.id, clubId, ownerId, false);
    await expect(extendSession(s.id, clubId, ownerId, false, 30)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses to extend a night that never had a limit', async () => {
    const s = await timedNight(120);
    await overrun(s);
    await liftTimeLimit(s.id, clubId, ownerId, false);
    await expect(extendSession(s.id, clubId, ownerId, false, 30)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses to extend a night that has not started', async () => {
    // The clock counts from the moment play begins, so there is nothing to add
    // to before then.
    await demoteTheOtherAdmin();
    await prisma.pokerSession.deleteMany({ where: { clubId } });
    const s: any = await startSession(clubId, ownerId, false, {
      sessionType: 'OFFLINE', sessionName: 'Open Night', durationMinutes: 120,
    } as any);
    await expect(extendSession(s.id, clubId, ownerId, false, 30)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('is not a thing a player can do', async () => {
    const s = await timedNight(120);
    await overrun(s);
    await expect(extendSession(s.id, clubId, playerId, false, 30)).rejects.toMatchObject({
      status: 403,
    });
    await expect(liftTimeLimit(s.id, clubId, playerId, false)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('is idempotent about continuing, so a double tap changes nothing', async () => {
    const s = await timedNight(120);
    const first: any = await liftTimeLimit(s.id, clubId, ownerId, false);
    const second: any = await liftTimeLimit(s.id, clubId, ownerId, false);
    expect(second.timeLimitLiftedAt).toBe(first.timeLimitLiftedAt);
  });
});

/**
 * One extension per grace period.
 *
 * Two admins looking at the same grace banner both tap Extend: one adds thirty
 * minutes, the other an hour, and the night quietly gains an hour and a half
 * nobody chose. The first accepted extension puts the clock back into play, and
 * a clock that is running has nothing to rescue.
 */
describe('the extension race', () => {
  async function overrunNight(minutes = 120) {
    await demoteTheOtherAdmin();
    await prisma.pokerSession.deleteMany({ where: { clubId } });
    const s: any = await startSession(clubId, ownerId, false, {
      sessionType: 'OFFLINE', sessionName: 'Overrun', durationMinutes: minutes,
    } as any);
    await prisma.pokerSession.update({
      where: { id: s.id },
      data: {
        engineState: {
          ...s,
          // Started long enough ago that the scheduled time has run out.
          startedPlayingAt: new Date(Date.now() - (minutes + 1) * 60_000).toISOString(),
          activePlayerUids: [ownerId, playerId],
        } as any,
      },
    });
    return s;
  }

  it('accepts the first extension once the time has run out', async () => {
    const s = await overrunNight(120);
    const after: any = await extendSession(s.id, clubId, ownerId, false, 30);
    expect(after.timeExtensions.map((e: any) => e.minutes)).toEqual([30]);
  });

  it('refuses the second, because the night is running again', async () => {
    const s = await overrunNight(120);
    await extendSession(s.id, clubId, ownerId, false, 30);
    await expect(extendSession(s.id, clubId, ownerId, false, 60)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('gives one winner when two admins tap in the same instant', async () => {
    // The whole point. Without the rule this night gains 90 minutes.
    const s = await overrunNight(120);
    const results = await Promise.all([
      extendSession(s.id, clubId, ownerId, false, 30).then(() => 'ok', () => 'no'),
      extendSession(s.id, clubId, ownerId, false, 60).then(() => 'ok', () => 'no'),
    ]);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);

    const state = (await prisma.pokerSession.findUnique({ where: { id: s.id } }))!
      .engineState as any;
    expect(state.timeExtensions).toHaveLength(1);
  });
});

/**
 * Settlement cannot begin on unresolved money.
 *
 * Freezing the table with a request still in the queue freezes the QUESTION too:
 * the chips are neither in the night nor out of it. Auto-rejecting decides
 * somebody's buy-in for them; auto-approving creates money on the way into the
 * ledger; leaving it pending settles figures with an open question on top.
 */
describe('settling with a queue', () => {
  it('refuses while a buy-in is waiting', async () => {
    await requestBuyIn(sessionId, clubId, playerId, 3_000);
    await expect(beginSettling(sessionId, clubId, ownerId, false)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses while a cash-out is waiting', async () => {
    await requestCashOut(sessionId, clubId, playerId, 7_000);
    await expect(beginSettling(sessionId, clubId, ownerId, false)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses while somebody is waiting for a chair', async () => {
    await prisma.pokerSession.update({
      where: { id: sessionId },
      data: {
        engineState: {
          startedPlayingAt: new Date().toISOString(),
          activePlayerUids: [ownerId, adminId],
          pendingSitInUids: [playerId],
          sitInRequestedAt: { [playerId]: new Date().toISOString() },
          cashOuts: [],
        } as any,
      },
    });
    await expect(beginSettling(sessionId, clubId, ownerId, false)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('counts them, so the host knows how much is left to clear', async () => {
    await requestBuyIn(sessionId, clubId, playerId, 3_000);
    await requestCashOut(sessionId, clubId, adminId, 5_000);
    await expect(beginSettling(sessionId, clubId, ownerId, false)).rejects.toMatchObject({
      message: expect.stringContaining('2 requests'),
    });
  });

  it('begins once the queue is empty', async () => {
    const req = await requestBuyIn(sessionId, clubId, playerId, 3_000);
    await decideBuyInRequest(sessionId, ownerId, false, req.id, true);
    const after: any = await beginSettling(sessionId, clubId, ownerId, false);
    expect(after.settlingAt).toBeTruthy();
  });
});
