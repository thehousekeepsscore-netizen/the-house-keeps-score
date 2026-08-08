import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../../lib/prisma.js';
import { settleSession } from './offlineSessions.service.js';

/**
 * Atomicity of settlement + audit.
 *
 * The audit record is written inside the settlement transaction, so the
 * guarantee is meant to be absolute: **either a settlement and its audit row
 * both exist, or neither does.** A settlement with no audit row is an
 * untraceable money event; an audit row with no settlement is a phantom.
 *
 * Reasoning about that from the code is not enough — this drives a real
 * failure through a real transaction and checks what survived.
 *
 * The failure is forced honestly rather than by mocking: `Club.clubPotBalance`
 * is a Postgres INTEGER, so a pot near 2^31-1 makes the pot update at the end
 * of `settleSession` raise `22003 integer out of range`. That step runs *after*
 * the settlement row is inserted, which is precisely the window that matters.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

const INT4_MAX = 2_147_483_647;
const NEAR_OVERFLOW = INT4_MAX - 10; // any rake at all tips this over

let clubId: string;
let sessionId: string;
let ownerId: string;
let playerId: string;
const created: { users: string[] } = { users: [] };

async function seedClub(potBalance: number) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const owner = await prisma.user.create({
    data: { email: `atomicity-owner-${stamp}@test.local`, passwordHash: 'x', displayName: 'Atomicity Owner' },
  });
  const player = await prisma.user.create({
    data: { email: `atomicity-player-${stamp}@test.local`, passwordHash: 'x', displayName: 'Atomicity Player' },
  });
  ownerId = owner.id;
  playerId = player.id;
  created.users = [owner.id, player.id];

  const club = await prisma.club.create({
    data: {
      name: `Atomicity Test ${stamp}`,
      code: `AT${stamp}`.slice(0, 20),
      ownerId: owner.id,
      potEnabled: true,
      winnersCutPercent: 10, // guarantees a non-zero pot movement
      clubPotBalance: potBalance,
      members: { create: [{ userId: owner.id }, { userId: player.id }] },
    },
  });
  clubId = club.id;

  const session = await prisma.pokerSession.create({
    data: {
      clubId: club.id,
      sessionName: 'Atomicity Night',
      sessionType: 'OFFLINE',
      startedById: owner.id,
      engineState: {
        activePlayerUids: [owner.id, player.id],
        pendingSitInUids: [],
        // This club takes a 10% winners' cut, which is what drives the pot
        // movement this file is about — the night's rules have to say so too.
        settlementRules: {
          capturedAt: new Date().toISOString(),
          sessionRakeAmount: 0, winnersCutPercent: 10,
          rakeEnabled: true, rakeMethod: 'PERCENT_PROFIT', rakeValue: 10,
          potEnabled: true, mismatchStrategy: 'PROPORTIONAL_WINNERS',
          rakeOrder: 'MISMATCH_FIRST', winnerDefinition: 'PROFIT_POSITIVE',
          winnerTopN: 1, roundingRule: 'NONE',
        },
      },
    },
  });
  sessionId = session.id;

  for (const uid of [owner.id, player.id]) {
    await prisma.buyInRequest.create({
      data: { sessionId: session.id, clubId: club.id, userId: uid, amount: 2000, status: 'approved', requestedBy: uid },
    });
  }
}

const settleEntries = () => ({
  entries: [
    { userId: ownerId, buyIn: 2000, cashOut: 3000 }, // wins 1000 → 10% cut → pot moves
    { userId: playerId, buyIn: 2000, cashOut: 1000 },
  ],
});

afterEach(async () => {
  if (!clubId) return;
  await prisma.auditLog.deleteMany({ where: { clubId } });
  await prisma.clubPotLog.deleteMany({ where: { clubId } });
  await prisma.cashOutSettlement.deleteMany({ where: { clubId } });
  await prisma.buyInRequest.deleteMany({ where: { clubId } });
  await prisma.pokerSession.deleteMany({ where: { clubId } });
  await prisma.clubMember.deleteMany({ where: { clubId } });
  await prisma.club.deleteMany({ where: { id: clubId } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  clubId = '';
});

describe('settleSession is atomic with its audit record', () => {
  describe('when the transaction fails after the settlement row is inserted', () => {
    beforeEach(() => seedClub(NEAR_OVERFLOW));

    it('leaves neither a settlement nor an audit record', async () => {
      await expect(settleSession(sessionId, ownerId, false, settleEntries())).rejects.toThrow();

      expect(await prisma.cashOutSettlement.count({ where: { clubId } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { clubId } })).toBe(0);
    });

    it('leaves the session open rather than half-settled', async () => {
      await expect(settleSession(sessionId, ownerId, false, settleEntries())).rejects.toThrow();

      const session = await prisma.pokerSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(session.status).toBe('active');
      expect(session.endedAt).toBeNull();
    });

    it('leaves the club pot untouched', async () => {
      await expect(settleSession(sessionId, ownerId, false, settleEntries())).rejects.toThrow();

      const club = await prisma.club.findUniqueOrThrow({ where: { id: clubId } });
      expect(club.clubPotBalance).toBe(NEAR_OVERFLOW);
      expect(await prisma.clubPotLog.count({ where: { clubId } })).toBe(0);
    });
  });

  // Positive control. Without this, the tests above would still pass if
  // settleSession were broken in a way that never wrote anything at all.
  describe('when the transaction succeeds', () => {
    beforeEach(() => seedClub(0));

    it('writes exactly one settlement and one audit record, keyed to each other', async () => {
      const settlement = await settleSession(sessionId, ownerId, false, settleEntries());

      const audits = await prisma.auditLog.findMany({ where: { clubId, action: 'settle_session' } });
      expect(audits).toHaveLength(1);
      expect(audits[0].sessionId).toBe(settlement.id);
      expect(await prisma.cashOutSettlement.count({ where: { clubId } })).toBe(1);
    });

    it('stamps engine and schema provenance onto the audit record', async () => {
      await settleSession(sessionId, ownerId, false, settleEntries());

      const audit = await prisma.auditLog.findFirstOrThrow({ where: { clubId, action: 'settle_session' } });
      const meta = (audit.changes as any).meta;
      expect(meta.createdFrom).toBe('settleSession');
      expect(meta.settlementEngineVersion).toBeTypeOf('number');
      expect(meta.auditSchemaVersion).toBeTypeOf('number');
    });

    it('cannot be settled twice, so a second audit record is impossible', async () => {
      await settleSession(sessionId, ownerId, false, settleEntries());
      await expect(settleSession(sessionId, ownerId, false, settleEntries())).rejects.toThrow(/already settled/i);

      expect(await prisma.auditLog.count({ where: { clubId, action: 'settle_session' } })).toBe(1);
    });
  });
});
