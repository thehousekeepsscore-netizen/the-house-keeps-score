import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../../lib/prisma.js';
import { getBuyInCeiling } from './offlineSessions.service.js';

/**
 * The buy-in ceiling is what players are told they may take, and what the API
 * enforces. Those two must be the same number: if the table shows more than the
 * server allows, a player is promised a buy-in that will be rejected; if it
 * shows less, they are quietly denied money they are entitled to.
 *
 * This pins the rule itself, including the case that used to render "No limit"
 * on the table — a MATCH_HIGHEST club before anyone has bought in, which was
 * previously unbounded no matter what the club had configured.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

const CONFIGURED_MAX = 5_000;

let clubId: string;
let sessionId: string;
let ownerId: string;
let playerId: string;
const created: { users: string[] } = { users: [] };

async function seedClub(buyInMode: 'MATCH_HIGHEST' | 'UNCAPPED') {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const owner = await prisma.user.create({
    data: { email: `ceiling-owner-${stamp}@test.local`, passwordHash: 'x', displayName: 'Ceiling Owner' },
  });
  const player = await prisma.user.create({
    data: { email: `ceiling-player-${stamp}@test.local`, passwordHash: 'x', displayName: 'Ceiling Player' },
  });
  ownerId = owner.id;
  playerId = player.id;
  created.users = [owner.id, player.id];

  const club = await prisma.club.create({
    data: {
      name: `Ceiling Test ${stamp}`,
      code: `CT${stamp}`.slice(0, 20),
      ownerId: owner.id,
      buyInMode,
      maxBuyIn: CONFIGURED_MAX,
      members: { create: [{ userId: owner.id }, { userId: player.id }] },
    },
  });
  clubId = club.id;

  const session = await prisma.pokerSession.create({
    data: {
      clubId: club.id,
      sessionName: 'Ceiling Night',
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
  await prisma.buyInRequest.deleteMany({ where: { clubId } });
  await prisma.pokerSession.deleteMany({ where: { clubId } });
  await prisma.clubMember.deleteMany({ where: { clubId } });
  await prisma.club.deleteMany({ where: { id: clubId } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  clubId = '';
}

async function approveBuyIn(userId: string, amount: number) {
  await prisma.buyInRequest.create({
    data: { sessionId, clubId, userId, amount, status: 'approved', requestedBy: userId },
  });
}

afterEach(cleanup);

describe('getBuyInCeiling', () => {
  describe('a MATCH_HIGHEST club', () => {
    beforeEach(() => seedClub('MATCH_HIGHEST'));

    it('opens at the configured maxBuyIn, not unbounded', async () => {
      // The case that used to display "No limit" while the club had a number.
      expect(await getBuyInCeiling(sessionId, clubId)).toBe(CONFIGURED_MAX);
    });

    it('never returns null, so the table always has a number to show', async () => {
      expect(await getBuyInCeiling(sessionId, clubId)).not.toBeNull();
      await approveBuyIn(ownerId, 5_000);
      expect(await getBuyInCeiling(sessionId, clubId)).not.toBeNull();
    });

    it('switches to the biggest bank once anyone holds one', async () => {
      await approveBuyIn(ownerId, 6_000);
      expect(await getBuyInCeiling(sessionId, clubId)).toBe(6_000);
    });

    it('follows the biggest bank upward as the night goes on', async () => {
      await approveBuyIn(ownerId, 5_000);
      expect(await getBuyInCeiling(sessionId, clubId)).toBe(5_000);

      await approveBuyIn(playerId, 7_500);
      expect(await getBuyInCeiling(sessionId, clubId)).toBe(7_500);

      // A top-up accumulates onto that player's own bank rather than replacing it.
      await approveBuyIn(ownerId, 5_000); // owner now holds 10,000
      expect(await getBuyInCeiling(sessionId, clubId)).toBe(10_000);
    });

    it('sums a player\'s buy-ins into one bank rather than taking the largest single request', async () => {
      await approveBuyIn(ownerId, 3_000);
      await approveBuyIn(ownerId, 3_000);
      expect(await getBuyInCeiling(sessionId, clubId)).toBe(6_000);
    });

    it('ignores requests that are not approved', async () => {
      await prisma.buyInRequest.create({
        data: { sessionId, clubId, userId: ownerId, amount: 99_000, status: 'pending', requestedBy: ownerId },
      });
      expect(await getBuyInCeiling(sessionId, clubId)).toBe(CONFIGURED_MAX);
    });
  });

  describe('an UNCAPPED club', () => {
    beforeEach(() => seedClub('UNCAPPED'));

    it('has no ceiling before any buy-in', async () => {
      expect(await getBuyInCeiling(sessionId, clubId)).toBeNull();
    });

    it('still has no ceiling once players hold banks', async () => {
      await approveBuyIn(ownerId, 12_000);
      expect(await getBuyInCeiling(sessionId, clubId)).toBeNull();
    });
  });
});
