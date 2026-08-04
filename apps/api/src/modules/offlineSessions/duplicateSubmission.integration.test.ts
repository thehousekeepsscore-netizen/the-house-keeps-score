import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../../lib/prisma.js';
import { requestBuyIn } from './offlineSessions.service.js';
import { createPastSession } from '../clubRecords/clubRecords.service.js';

/**
 * Duplicate submissions must not create duplicate records.
 *
 * This is not hypothetical. A player whose screen appeared frozen — the UI does
 * not disable the button, and nothing on screen changes for about a second —
 * pressed Request Buy-in around twenty times and created around twenty rows for
 * an admin to triage. A disabled button would have hidden that, but only for a
 * client that behaves; the rule belongs on the server.
 *
 * createPastSession is the same class of bug with worse consequences: nobody
 * approves a back-dated night, so a duplicate lands straight in every player's
 * lifetime profit and in the leaderboard.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

let clubId: string;
let sessionId: string;
let ownerId: string;
let playerId: string;
const created: { users: string[] } = { users: [] };

async function seed() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const owner = await prisma.user.create({
    data: { email: `dup-owner-${stamp}@test.local`, passwordHash: 'x', displayName: 'Dup Owner' },
  });
  const player = await prisma.user.create({
    data: { email: `dup-player-${stamp}@test.local`, passwordHash: 'x', displayName: 'Dup Player' },
  });
  ownerId = owner.id;
  playerId = player.id;
  created.users = [owner.id, player.id];

  const club = await prisma.club.create({
    data: {
      name: `Dup Test ${stamp}`,
      code: `DP${stamp}`.slice(0, 20),
      ownerId: owner.id,
      buyInMode: 'UNCAPPED', // keep the ceiling out of these assertions
      members: { create: [{ userId: owner.id }, { userId: player.id }] },
    },
  });
  clubId = club.id;

  const session = await prisma.pokerSession.create({
    data: {
      clubId: club.id,
      sessionName: 'Dup Night',
      sessionType: 'OFFLINE',
      startedById: owner.id,
      engineState: { activePlayerUids: [owner.id, player.id], pendingSitInUids: [] },
    },
  });
  sessionId = session.id;
}

/** Only ever removes rows this test created. */
async function cleanup() {
  if (!clubId) return;
  await prisma.auditLog.deleteMany({ where: { clubId } });
  await prisma.clubPotLog.deleteMany({ where: { clubId } });
  await prisma.historicalSessionRecord.deleteMany({ where: { clubId } });
  await prisma.buyInRequest.deleteMany({ where: { clubId } });
  await prisma.pokerSession.deleteMany({ where: { clubId } });
  await prisma.clubMember.deleteMany({ where: { clubId } });
  await prisma.club.deleteMany({ where: { id: clubId } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  clubId = '';
}

beforeEach(seed);
afterEach(cleanup);

describe('requestBuyIn', () => {
  it('rejects a second pending request from the same player', async () => {
    await requestBuyIn(sessionId, clubId, playerId, 5_000);
    await expect(requestBuyIn(sessionId, clubId, playerId, 5_000)).rejects.toThrow(/already have a buy-in request/i);

    const rows = await prisma.buyInRequest.count({ where: { sessionId, userId: playerId } });
    expect(rows).toBe(1);
  });

  it('leaves exactly one row after an impatient burst of clicks', async () => {
    await requestBuyIn(sessionId, clubId, playerId, 5_000);
    // The reported incident, in miniature.
    const burst = await Promise.allSettled(
      Array.from({ length: 19 }, () => requestBuyIn(sessionId, clubId, playerId, 5_000))
    );

    expect(burst.every((r) => r.status === 'rejected')).toBe(true);
    expect(await prisma.buyInRequest.count({ where: { sessionId, userId: playerId } })).toBe(1);
  });

  it('does not block a different player at the same table', async () => {
    await requestBuyIn(sessionId, clubId, playerId, 5_000);
    await expect(requestBuyIn(sessionId, clubId, ownerId, 5_000)).resolves.toBeTruthy();
    expect(await prisma.buyInRequest.count({ where: { sessionId } })).toBe(2);
  });

  it('allows a new request once the previous one is no longer pending', async () => {
    const first = await requestBuyIn(sessionId, clubId, playerId, 5_000);
    await prisma.buyInRequest.update({ where: { id: first.id }, data: { status: 'approved' } });

    await expect(requestBuyIn(sessionId, clubId, playerId, 3_000)).resolves.toBeTruthy();
    expect(await prisma.buyInRequest.count({ where: { sessionId, userId: playerId } })).toBe(2);
  });
});

describe('createPastSession', () => {
  const night = (extra?: { cashOut?: number }) => ({
    sessionDate: '2026-07-01',
    title: 'Duplicate Night',
    entries: [
      { userId: ownerId, userName: 'Dup Owner', buyIn: 5_000, cashOut: 7_000 },
      { userId: playerId, userName: 'Dup Player', buyIn: 5_000, cashOut: extra?.cashOut ?? 3_000 },
    ],
  });

  it('rejects an identical night for the same date', async () => {
    await createPastSession(clubId, ownerId, false, night());
    await expect(createPastSession(clubId, ownerId, false, night())).rejects.toThrow(/already been recorded/i);

    expect(await prisma.historicalSessionRecord.count({ where: { clubId } })).toBe(1);
  });

  it('still allows a genuinely different night on the same date', async () => {
    // Two sessions in one evening is plausible; two with identical figures is not.
    await createPastSession(clubId, ownerId, false, night());
    await expect(createPastSession(clubId, ownerId, false, night({ cashOut: 4_000 }))).resolves.toBeTruthy();

    expect(await prisma.historicalSessionRecord.count({ where: { clubId } })).toBe(2);
  });

  it('does not count a deleted record as a duplicate', async () => {
    const first = await createPastSession(clubId, ownerId, false, night());
    await prisma.historicalSessionRecord.update({ where: { id: first.record.id }, data: { isDeleted: true } });

    // Deleting a mistake and re-entering it is a legitimate correction.
    await expect(createPastSession(clubId, ownerId, false, night())).resolves.toBeTruthy();
  });
});
