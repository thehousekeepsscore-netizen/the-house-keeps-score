import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { canJoinClub } from './socket.js';

/**
 * Who is allowed into a club's live room.
 *
 * Until this was added, nobody was excluded. `club:join` joined whatever room
 * id the client sent, checking only that it was a string — so any authenticated
 * account on the platform, member or not, could subscribe to any club's stream:
 * every buy-in amount, every cash-out, every settlement, live.
 *
 * The outsider cases below are the ones that matter. The member cases exist so
 * that a future tightening cannot pass by accidentally denying everyone.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

let clubId = '';
let ownerId: string;
let adminId: string;
let memberId: string;
let outsiderId: string;
let removedId: string;
let createdUsers: string[] = [];

const asUser = (userId: string) => ({ userId, isSuperAdmin: false });

async function seed() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mk = (role: string) =>
    prisma.user.create({
      data: { email: `room-${role}-${stamp}@test.local`, passwordHash: 'x', displayName: `Room ${role}` },
    });

  const [owner, admin, member, outsider, removed] = await Promise.all([
    mk('owner'),
    mk('admin'),
    mk('member'),
    mk('outsider'),
    mk('removed'),
  ]);
  ownerId = owner.id;
  adminId = admin.id;
  memberId = member.id;
  outsiderId = outsider.id;
  removedId = removed.id;
  createdUsers = [owner.id, admin.id, member.id, outsider.id, removed.id];

  const club = await prisma.club.create({
    data: {
      name: `Room Test ${stamp}`,
      code: `RM${stamp}`.slice(0, 20),
      ownerId: owner.id,
      admins: { create: [{ userId: admin.id }] },
      members: { create: [{ userId: owner.id }, { userId: admin.id }, { userId: member.id }] },
    },
  });
  clubId = club.id;
}

/** Only ever removes rows this test created. */
async function cleanup() {
  if (!clubId) return;
  await prisma.clubAdmin.deleteMany({ where: { clubId } });
  await prisma.clubMember.deleteMany({ where: { clubId } });
  await prisma.club.deleteMany({ where: { id: clubId } });
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  clubId = '';
}

beforeEach(seed);
afterEach(cleanup);

describe('canJoinClub', () => {
  it('refuses an authenticated user who is not in the club', async () => {
    // The hole this closes: authentication was the only check.
    expect(await canJoinClub(clubId, asUser(outsiderId))).toBe(false);
  });

  it('refuses a user who was never a member of any club', async () => {
    expect(await canJoinClub(clubId, asUser(removedId))).toBe(false);
  });

  it('refuses a club id that does not exist', async () => {
    expect(await canJoinClub('does-not-exist', asUser(memberId))).toBe(false);
  });

  it('admits the owner', async () => {
    expect(await canJoinClub(clubId, asUser(ownerId))).toBe(true);
  });

  it('admits an admin', async () => {
    expect(await canJoinClub(clubId, asUser(adminId))).toBe(true);
  });

  it('admits an ordinary member', async () => {
    expect(await canJoinClub(clubId, asUser(memberId))).toBe(true);
  });

  it('admits a super-admin who is not in the club', async () => {
    expect(await canJoinClub(clubId, { userId: outsiderId, isSuperAdmin: true })).toBe(true);
  });

  it('refuses a member the moment they are removed, without waiting for their token to expire', async () => {
    // The reason this is a query and not a token claim. An access token minted
    // while someone was a member stays valid after they are removed; reading
    // membership off the token would let them keep listening until it expired.
    expect(await canJoinClub(clubId, asUser(memberId))).toBe(true);

    await prisma.clubMember.deleteMany({ where: { clubId, userId: memberId } });

    expect(await canJoinClub(clubId, asUser(memberId))).toBe(false);
  });

  it('still admits a demoted admin who remains a member', async () => {
    await prisma.clubAdmin.deleteMany({ where: { clubId, userId: adminId } });

    // Demotion is not removal — they are still in the club and still watch the
    // table. This is what stops the check being written as "admins only".
    expect(await canJoinClub(clubId, asUser(adminId))).toBe(true);
  });
});
