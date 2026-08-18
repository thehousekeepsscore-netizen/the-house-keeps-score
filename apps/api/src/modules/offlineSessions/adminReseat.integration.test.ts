import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../../lib/prisma.js';

/**
 * Sitting somebody else back down.
 *
 * A player stands up, is counted out, and then wants back in. The player can
 * ask from their own phone — that always worked. What did not work is the admin
 * doing it for them, which is the normal case at a table: the phone that is out
 * is the host's.
 *
 * The sheet offered it and could not do it. "Sit back down" sent no user id, so
 * the server seated the CALLER, and a host who was already at the table got
 * "You are already seated at this table" for pressing a button about somebody
 * else. The player stayed standing.
 *
 * These tests are about who the request is FOR, and who is allowed to make it —
 * the two things the old signature could not express. The authorization ones
 * matter most: the body now names a person, and a body that can name a person
 * must never be the thing that decides whether naming them is allowed.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

vi.mock('../../realtime/socket.js', () => ({ emitToClub: () => {}, emitToSession: () => {} }));

const { requestSitIn, decideSitIn } = await import('./offlineSessions.service.js');

let clubId = '';
let sessionId = '';
let ownerId = '';
let adminId = '';
let memberId = '';
let rahulId = '';
let bankedId = '';
let strangerId = '';
let createdUsers: string[] = [];

/** The one figure that has to survive the round trip. */
const RAHUL_STACK = 7200;

async function seed() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mk = (role: string, name: string) =>
    prisma.user.create({
      data: { email: `reseat-${role}-${stamp}@test.local`, passwordHash: 'x', displayName: name },
    });

  const [owner, admin, member, rahul, banked, stranger] = await Promise.all([
    mk('owner', 'Reseat Owner'),
    mk('admin', 'Reseat Admin'),
    mk('member', 'Plain Member'),
    mk('rahul', 'Rahul'),
    mk('banked', 'Banked Player'),
    mk('stranger', 'Not Playing Tonight'),
  ]);
  ownerId = owner.id;
  adminId = admin.id;
  memberId = member.id;
  rahulId = rahul.id;
  bankedId = banked.id;
  strangerId = stranger.id;
  createdUsers = [owner.id, admin.id, member.id, rahul.id, banked.id, stranger.id];

  const club = await prisma.club.create({
    data: {
      name: `Reseat Test ${stamp}`,
      code: `RS${stamp}`.slice(0, 20),
      ownerId: owner.id,
      buyInMode: 'UNCAPPED',
      members: {
        create: createdUsers.map((userId) => ({ userId })),
      },
      admins: { create: [{ userId: admin.id }] },
    },
  });
  clubId = club.id;

  const session = await prisma.pokerSession.create({
    data: {
      clubId: club.id,
      sessionName: 'Reseat Night',
      sessionType: 'OFFLINE',
      startedById: owner.id,
      engineState: {
        startedPlayingAt: new Date().toISOString(),
        // The admin IS seated. That is the regression: being at the table used
        // to be what made this fail.
        activePlayerUids: [ownerId, adminId],
        pendingSitInUids: [],
        cashOuts: [
          {
            userId: rahulId,
            amount: RAHUL_STACK,
            status: 'confirmed',
            requestedAt: new Date().toISOString(),
          },
        ],
      },
    },
  });
  sessionId = session.id;

  // Belongs to the night by having money down rather than by having stood up —
  // the other half of the eligibility rule.
  await prisma.buyInRequest.create({
    data: { sessionId, clubId, userId: bankedId, amount: 5000, status: 'approved', requestedBy: bankedId },
  });
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

const stateOf = async () => {
  const row = await prisma.pokerSession.findUniqueOrThrow({ where: { id: sessionId } });
  return row.engineState as {
    activePlayerUids?: string[];
    pendingSitInUids?: string[];
    sitInRequestedAt?: Record<string, string>;
    cashOuts?: { userId: string; amount: number; status: string }[];
  };
};

/** HttpError carries the status the route would have returned. */
const statusOf = (err: unknown) => (err as { status?: number }).status;

beforeEach(seed);
afterEach(cleanup);

describe('asking for your own seat — unchanged', () => {
  it('a member asks for themselves with no target, and is queued', async () => {
    await requestSitIn(sessionId, clubId, strangerId, false);

    const state = await stateOf();
    expect(state.pendingSitInUids).toContain(strangerId);
    expect(state.sitInRequestedAt?.[strangerId]).toBeTruthy();
  });

  it('a self-request needs no connection to the night — that is how people join one', async () => {
    // strangerId has no bank and no cash-out. The eligibility rule applies to
    // the admin path only, and this is the reason why.
    await expect(requestSitIn(sessionId, clubId, strangerId, false)).resolves.toBeTruthy();
  });

  it('passing your own id explicitly is still a self-request, not an admin one', async () => {
    // memberId is not an admin. If naming yourself counted as acting on behalf,
    // this would 403.
    await expect(requestSitIn(sessionId, clubId, memberId, false, memberId)).resolves.toBeTruthy();
  });
});

describe('an admin asks on somebody else s behalf', () => {
  it('THE FIX: a seated admin queues the player who stood up, not themselves', async () => {
    await requestSitIn(sessionId, clubId, adminId, false, rahulId);

    const state = await stateOf();
    expect(state.pendingSitInUids, 'the player is queued').toContain(rahulId);
    expect(state.pendingSitInUids, 'the admin is not').not.toContain(adminId);
    expect(state.sitInRequestedAt?.[rahulId], 'the timestamp belongs to the player').toBeTruthy();
    expect(state.sitInRequestedAt?.[adminId]).toBeUndefined();
  });

  it('the club owner can do it too', async () => {
    await expect(requestSitIn(sessionId, clubId, ownerId, false, rahulId)).resolves.toBeTruthy();
  });

  it('a super admin can do it without being a club admin', async () => {
    await expect(requestSitIn(sessionId, clubId, strangerId, true, rahulId)).resolves.toBeTruthy();
  });

  it('a player who belongs by having banked, rather than by having stood up', async () => {
    await requestSitIn(sessionId, clubId, adminId, false, bankedId);
    expect((await stateOf()).pendingSitInUids).toContain(bankedId);
  });
});

describe('who is allowed is decided from the token, never from the body', () => {
  it('a plain member cannot seat somebody else', async () => {
    const err = await requestSitIn(sessionId, clubId, memberId, false, rahulId).catch((e) => e);
    expect(statusOf(err)).toBe(403);

    const state = await stateOf();
    expect(state.pendingSitInUids, 'and nothing moved').not.toContain(rahulId);
  });

  it('a player cannot seat another player', async () => {
    const err = await requestSitIn(sessionId, clubId, bankedId, false, rahulId).catch((e) => e);
    expect(statusOf(err)).toBe(403);
  });
});

describe('the target has to make sense', () => {
  it('somebody who is not part of tonight cannot be seated by an admin', async () => {
    const err = await requestSitIn(sessionId, clubId, adminId, false, strangerId).catch((e) => e);
    expect(statusOf(err)).toBe(404);
    expect((err as Error).message).toMatch(/not part of this night/);
  });

  it('somebody already seated is refused, and told it is about them', async () => {
    const err = await requestSitIn(sessionId, clubId, adminId, false, ownerId).catch((e) => e);
    expect(statusOf(err)).toBe(409);
    expect((err as Error).message).toMatch(/That player is already seated/);
  });

  it('asking twice for the same player is refused', async () => {
    await requestSitIn(sessionId, clubId, adminId, false, rahulId);

    const err = await requestSitIn(sessionId, clubId, ownerId, false, rahulId).catch((e) => e);
    expect(statusOf(err)).toBe(409);
    expect((err as Error).message).toMatch(/already asked for a seat/);
  });

  it('a settled night refuses the whole thing', async () => {
    await prisma.pokerSession.update({ where: { id: sessionId }, data: { status: 'settled' } });
    const err = await requestSitIn(sessionId, clubId, adminId, false, rahulId).catch((e) => e);
    expect(statusOf(err)).toBe(409);
  });
});

describe('two admins, the same player, the same moment', () => {
  it('exactly one succeeds and the queue holds one entry', async () => {
    /*
     * Both callers are fired without awaiting the first, so both reach the
     * session lock with the queue still empty. The lock serialises them; the
     * second reads the state the first committed and finds the player already
     * waiting.
     *
     * Repeated, because a race that only sometimes loses passes on the first
     * attempt.
     */
    for (let round = 0; round < 6; round += 1) {
      const results = await Promise.allSettled([
        requestSitIn(sessionId, clubId, adminId, false, rahulId),
        requestSitIn(sessionId, clubId, ownerId, false, rahulId),
      ]);

      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      expect(won, `round ${round}: winners`).toHaveLength(1);
      expect(lost, `round ${round}: losers`).toHaveLength(1);
      expect(statusOf((lost[0] as PromiseRejectedResult).reason), `round ${round}`).toBe(409);

      const state = await stateOf();
      const queued = (state.pendingSitInUids ?? []).filter((u) => u === rahulId);
      expect(queued, `round ${round}: one entry, not two`).toHaveLength(1);

      await prisma.pokerSession.update({
        where: { id: sessionId },
        data: {
          engineState: {
            ...(state as object),
            pendingSitInUids: [],
            sitInRequestedAt: {},
          } as never,
        },
      });
    }
  });
});

describe('the whole round trip', () => {
  it('admin asks, admin approves, the player is seated and the cash-out is voided', async () => {
    await requestSitIn(sessionId, clubId, adminId, false, rahulId);

    const queued = await stateOf();
    expect(queued.pendingSitInUids).toContain(rahulId);
    expect(queued.cashOuts?.some((c) => c.userId === rahulId), 'still standing').toBe(true);

    // decideSitIn is untouched by this change, including its guard that it will
    // only ever seat somebody who actually asked.
    await decideSitIn(sessionId, clubId, adminId, false, rahulId, true);

    const seated = await stateOf();
    expect(seated.activePlayerUids, 'back at the table').toContain(rahulId);
    expect(seated.pendingSitInUids, 'out of the queue').not.toContain(rahulId);
    expect(
      seated.cashOuts?.some((c) => c.userId === rahulId),
      'the confirmed cash-out is voided — they carry those chips back'
    ).toBe(false);
  });

  it('decideSitIn still refuses anyone who did not ask', async () => {
    const err = await decideSitIn(sessionId, clubId, adminId, false, rahulId, true).catch((e) => e);
    expect(statusOf(err)).toBe(404);
  });
});
