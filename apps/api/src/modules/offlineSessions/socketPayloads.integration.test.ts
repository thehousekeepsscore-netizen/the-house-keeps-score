import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../../lib/prisma.js';

/**
 * Socket events must carry the new state, not just an id.
 *
 * This is the contract in SOCKET-EVENT-CONTRACT.md, enforced rather than
 * described. Every event used to say only "something changed", so each one cost
 * every client in the room a round trip to learn a fact the server already had
 * in hand — and in decideBuyInRequest the decided row was literally discarded
 * one line before the emit that told clients to fetch it back.
 *
 * The payloads are asserted here rather than in the frontend because that is
 * where they are produced. A frontend test could only prove that the handlers
 * apply a payload it invented for itself, which would keep passing after the
 * server stopped sending one.
 *
 * `club:session-settled` is deliberately absent: settlement recomputes
 * leaderboard aggregates across the club's whole history and moves the pot
 * ledger, which no client holding one session can derive, and the leaderboard
 * is visibility-gated per recipient — so it is invalidated, never pushed.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

const emitted: { event: string; payload: any }[] = [];

vi.mock('../../realtime/socket.js', () => ({
  emitToClub: (_clubId: string, event: string, payload: any) => {
    emitted.push({ event, payload });
  },
}));

const {
  requestBuyIn,
  decideBuyInRequest,
  requestSitIn,
  decideSitIn,
  requestCashOut,
  decideCashOut,
} = await import('./offlineSessions.service.js');

let clubId = '';
let sessionId: string;
let ownerId: string;
let playerId: string;
let outsiderId: string;
let createdUsers: string[] = [];

/** The single payload for `event`, failing loudly if it was not emitted once. */
function only(event: string) {
  const hits = emitted.filter((e) => e.event === event);
  expect(hits, `expected exactly one ${event}`).toHaveLength(1);
  return hits[0].payload;
}

async function seed() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mk = (role: string, name: string) =>
    prisma.user.create({
      data: { email: `sock-${role}-${stamp}@test.local`, passwordHash: 'x', displayName: name },
    });

  const [owner, player, outsider] = await Promise.all([
    mk('owner', 'Sock Owner'),
    mk('player', 'Sock Player'),
    mk('outsider', 'Sock Outsider'),
  ]);
  ownerId = owner.id;
  playerId = player.id;
  outsiderId = outsider.id;
  createdUsers = [owner.id, player.id, outsider.id];

  const club = await prisma.club.create({
    data: {
      name: `Sock Test ${stamp}`,
      code: `SK${stamp}`.slice(0, 20),
      ownerId: owner.id,
      buyInMode: 'UNCAPPED', // keep the ceiling out of these assertions
      members: { create: [{ userId: owner.id }, { userId: player.id }, { userId: outsider.id }] },
    },
  });
  clubId = club.id;

  const session = await prisma.pokerSession.create({
    data: {
      clubId: club.id,
      sessionName: 'Sock Night',
      sessionType: 'OFFLINE',
      startedById: owner.id,
      engineState: { activePlayerUids: [ownerId, playerId], pendingSitInUids: [] },
    },
  });
  sessionId = session.id;
  emitted.length = 0;
}

/** Only ever removes rows this test created. */
async function cleanup() {
  if (!clubId) return;
  await prisma.auditLog.deleteMany({ where: { clubId } });
  await prisma.buyInRequest.deleteMany({ where: { clubId } });
  await prisma.pokerSession.deleteMany({ where: { clubId } });
  await prisma.clubMember.deleteMany({ where: { clubId } });
  await prisma.club.deleteMany({ where: { id: clubId } });
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  clubId = '';
  emitted.length = 0;
}

beforeEach(seed);
afterEach(cleanup);

describe('buy-in events carry the row', () => {
  it('club:buyin-requested carries the created request', async () => {
    const created = await requestBuyIn(sessionId, clubId, playerId, 5_000);

    const p = only('club:buyin-requested');
    expect(p.request).toMatchObject({
      id: created.id,
      userId: playerId,
      amount: 5_000,
      status: 'pending',
    });
  });

  it('club:buyin-decided carries the approved row, so no GET is needed to see it', async () => {
    const created = await requestBuyIn(sessionId, clubId, playerId, 5_000);
    emitted.length = 0;

    await decideBuyInRequest(sessionId, ownerId, false, created.id, true);

    const p = only('club:buyin-decided');
    expect(p.request).toMatchObject({ id: created.id, status: 'approved', approvedBy: ownerId });
    // userId is what lets a client tell the requester their own request moved.
    expect(p.userId).toBe(playerId);
  });

  it('club:buyin-decided carries the rejected row too', async () => {
    const created = await requestBuyIn(sessionId, clubId, playerId, 5_000);
    emitted.length = 0;

    await decideBuyInRequest(sessionId, ownerId, false, created.id, false);

    expect(only('club:buyin-decided').request).toMatchObject({ id: created.id, status: 'rejected' });
  });

  it('the payload row matches what the REST list would have returned', async () => {
    const created = await requestBuyIn(sessionId, clubId, playerId, 5_000);
    emitted.length = 0;
    await decideBuyInRequest(sessionId, ownerId, false, created.id, true);

    // The whole point of pushing the row is that a client patching from it ends
    // up where a refetch would have put it. If these ever diverge, the cache
    // silently disagrees with the database.
    const fromDb = await prisma.buyInRequest.findUnique({ where: { id: created.id } });
    expect(JSON.parse(JSON.stringify(only('club:buyin-decided').request))).toEqual(
      JSON.parse(JSON.stringify(fromDb))
    );
  });
});

describe('seat events carry the session', () => {
  it('club:sitin-requested carries the session with the pending request in it', async () => {
    await requestSitIn(sessionId, clubId, outsiderId);

    const p = only('club:sitin-requested');
    expect(p.session?.id).toBe(sessionId);
    expect(p.session.pendingSitInUids).toContain(outsiderId);
  });

  it('club:sitin-decided carries the session with the player seated', async () => {
    await requestSitIn(sessionId, clubId, outsiderId);
    emitted.length = 0;

    await decideSitIn(sessionId, clubId, ownerId, false, outsiderId, true);

    const p = only('club:sitin-decided');
    expect(p.session.activePlayerUids).toContain(outsiderId);
    expect(p.session.pendingSitInUids).not.toContain(outsiderId);
  });

  it('club:cashout-requested carries the session with the pending cash-out', async () => {
    await requestCashOut(sessionId, clubId, playerId, 7_500);

    const p = only('club:cashout-requested');
    const entry = p.session.cashOuts.find((c: any) => c.userId === playerId);
    expect(entry).toMatchObject({ amount: 7_500, status: 'pending' });
  });

  it('club:cashout-decided carries the session with the player unseated', async () => {
    await requestCashOut(sessionId, clubId, playerId, 7_500);
    emitted.length = 0;

    await decideCashOut(sessionId, clubId, ownerId, false, playerId, true);

    const p = only('club:cashout-decided');
    expect(p.session.activePlayerUids).not.toContain(playerId);
  });

  it('the session in the payload matches the row left in the database', async () => {
    await requestSitIn(sessionId, clubId, outsiderId);

    // serialize() spreads engineState onto the session rather than nesting it,
    // which is the shape the REST endpoint returns and therefore the shape the
    // client's mapper expects. Asserting it here pins the socket payload to
    // that same contract.
    const fromDb = await prisma.pokerSession.findUnique({ where: { id: sessionId } });
    const state = fromDb!.engineState as Record<string, unknown>;
    const p = only('club:sitin-requested');
    for (const [k, v] of Object.entries(state)) {
      expect(p.session[k], `session.${k}`).toEqual(v);
    }
    expect(p.session.engineState, 'engineState must not be nested as well').toBeUndefined();
  });
});
