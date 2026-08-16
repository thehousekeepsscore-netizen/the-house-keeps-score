/**
 * Who gets into a club, and the record of who let them in.
 *
 * The test that earns this file is the concurrent one. Everything else here
 * describes behaviour that a careful reading of the service would also tell
 * you; two admins tapping accept at the same instant is the case that reading
 * cannot settle, because the answer depends on what Postgres does with two
 * overlapping statements rather than on what the code appears to say.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../../lib/prisma.js';

vi.mock('../../realtime/socket.js', () => ({ emitToClub: vi.fn(), emitToSession: vi.fn() }));

const notified: { userId: string; accepted: boolean }[] = [];
vi.mock('../notifications/notifications.service.js', () => ({
  notifyJoinRequestDecided: vi.fn(async (p: { userId: string; accepted: boolean }) => {
    notified.push({ userId: p.userId, accepted: p.accepted });
  }),
  notifyBuyInApproved: vi.fn(),
  notifySessionSettled: vi.fn(),
}));

const { decideJoinRequest, requestToJoin } = await import('./clubs.service.js');
const { emitToClub } = await import('../../realtime/socket.js');

let clubId = '';
let ownerId = '';
let adminId = '';
let otherAdminId = '';
let outsiderId = '';
let hopefulId = '';
const created: string[] = [];

async function user(tag: string, stamp: string) {
  const u = await prisma.user.create({
    data: { email: `jr-${tag}-${stamp}@test.local`, passwordHash: 'x', displayName: `${tag} person` },
  });
  created.push(u.id);
  return u.id;
}

async function seed(maxCapacity = 50) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ownerId = await user('owner', stamp);
  adminId = await user('admin', stamp);
  otherAdminId = await user('admin2', stamp);
  outsiderId = await user('outsider', stamp);
  hopefulId = await user('hopeful', stamp);

  const club = await prisma.club.create({
    data: {
      name: `Join ${stamp}`,
      code: `JR${stamp}`.slice(0, 20),
      ownerId,
      maxCapacity,
      members: { create: [{ userId: ownerId }, { userId: adminId }, { userId: otherAdminId }] },
      admins: { create: [{ userId: adminId }, { userId: otherAdminId }] },
    },
  });
  clubId = club.id;
  notified.length = 0;
  vi.mocked(emitToClub).mockClear();
}

const pendingRequest = async (userId = hopefulId) =>
  (await requestToJoin(clubId, userId)) as { id: string };

const memberships = (userId: string) =>
  prisma.clubMember.count({ where: { clubId, userId } });

const auditRows = () =>
  prisma.auditLog.findMany({ where: { clubId }, orderBy: { createdAt: 'asc' } });

afterEach(async () => {
  if (clubId) {
    await prisma.auditLog.deleteMany({ where: { clubId } });
    await prisma.clubJoinRequest.deleteMany({ where: { clubId } });
    await prisma.clubAdmin.deleteMany({ where: { clubId } });
    await prisma.clubMember.deleteMany({ where: { clubId } });
    await prisma.club.deleteMany({ where: { id: clubId } });
  }
  await prisma.user.deleteMany({ where: { id: { in: created.splice(0) } } });
  clubId = '';
});

describe('who may decide', () => {
  beforeEach(() => seed());

  it('the owner accepts', async () => {
    const req = await pendingRequest();
    const out = await decideJoinRequest(clubId, req.id, ownerId, false, true);
    expect(out.status).toBe('accepted');
    expect(await memberships(hopefulId)).toBe(1);
  });

  it('an admin accepts — the change this feature exists for', async () => {
    const req = await pendingRequest();
    const out = await decideJoinRequest(clubId, req.id, adminId, false, true);
    expect(out.status).toBe('accepted');
    expect(await memberships(hopefulId)).toBe(1);
  });

  it('the owner rejects', async () => {
    const req = await pendingRequest();
    const out = await decideJoinRequest(clubId, req.id, ownerId, false, false);
    expect(out.status).toBe('rejected');
    expect(await memberships(hopefulId)).toBe(0);
  });

  it('an admin rejects', async () => {
    const req = await pendingRequest();
    const out = await decideJoinRequest(clubId, req.id, adminId, false, false);
    expect(out.status).toBe('rejected');
    expect(await memberships(hopefulId)).toBe(0);
  });

  it('a plain member or stranger cannot decide, and nothing moves', async () => {
    const req = await pendingRequest();
    await expect(decideJoinRequest(clubId, req.id, outsiderId, false, true)).rejects.toThrow(
      /Only a Club Admin or Owner/
    );
    const after = await prisma.clubJoinRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe('pending');
    expect(await memberships(hopefulId)).toBe(0);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('the requester is told', () => {
  beforeEach(() => seed());

  it('on acceptance', async () => {
    const req = await pendingRequest();
    await decideJoinRequest(clubId, req.id, adminId, false, true);
    expect(notified).toEqual([{ userId: hopefulId, accepted: true }]);
  });

  it('on rejection — the outcome nobody wants to be left guessing about', async () => {
    const req = await pendingRequest();
    await decideJoinRequest(clubId, req.id, adminId, false, false);
    expect(notified).toEqual([{ userId: hopefulId, accepted: false }]);
  });

  it('and the admin queue is told to refresh', async () => {
    const req = await pendingRequest();
    await decideJoinRequest(clubId, req.id, adminId, false, true);
    expect(emitToClub).toHaveBeenCalledWith(clubId, 'club:join-request-decided', {
      requestId: req.id,
      accepted: true,
    });
  });
});

describe('the audit records who let them in', () => {
  beforeEach(() => seed());

  it('writes one row naming the decider, the requester and the decision', async () => {
    const req = await pendingRequest();
    await decideJoinRequest(clubId, req.id, adminId, false, true);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('accept_join_request');
    expect(rows[0].changedBy).toBe(adminId);
    const changes = rows[0].changes as Record<string, unknown>;
    expect(changes.requesterId).toBe(hopefulId);
    expect(changes.decision).toBe('accepted');
    expect(changes.decidedByRole).toBe('admin');
  });

  it('distinguishes an owner decision from an admin one', async () => {
    const req = await pendingRequest();
    await decideJoinRequest(clubId, req.id, ownerId, false, true);
    const rows = await auditRows();
    expect((rows[0].changes as Record<string, unknown>).decidedByRole).toBe('owner');
  });

  it('records a rejection too', async () => {
    const req = await pendingRequest();
    await decideJoinRequest(clubId, req.id, adminId, false, false);
    const rows = await auditRows();
    expect(rows[0].action).toBe('reject_join_request');
  });
});

describe('a request is decided exactly once', () => {
  beforeEach(() => seed());

  it('refuses a second decision on an already-decided request', async () => {
    const req = await pendingRequest();
    await decideJoinRequest(clubId, req.id, adminId, false, true);
    await expect(decideJoinRequest(clubId, req.id, ownerId, false, false)).rejects.toThrow(
      /already been decided/
    );
    expect(await memberships(hopefulId)).toBe(1);
    expect(await auditRows()).toHaveLength(1);
  });

  it('TWO ADMINS AT ONCE — exactly one succeeds', async () => {
    /*
     * The reason this file exists. Both callers are fired without awaiting the
     * first, so both reach the conditional UPDATE with the row still pending.
     * Postgres matches it for one of them; the other sees count 0 and is told
     * the request was already decided.
     *
     * Run repeatedly, because a race that only sometimes happens is a race
     * that passes on the first attempt.
     */
    for (let round = 0; round < 8; round += 1) {
      const req = await pendingRequest();

      const results = await Promise.allSettled([
        decideJoinRequest(clubId, req.id, adminId, false, true),
        decideJoinRequest(clubId, req.id, otherAdminId, false, true),
      ]);

      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      expect(won, `round ${round}: winners`).toHaveLength(1);
      expect(lost, `round ${round}: losers`).toHaveLength(1);
      expect((lost[0] as PromiseRejectedResult).reason.message).toMatch(/already been decided/);

      // One membership, and one audit row — not two of either.
      expect(await memberships(hopefulId), `round ${round}: memberships`).toBe(1);
      expect(await auditRows(), `round ${round}: audit rows`).toHaveLength(1);

      await prisma.clubMember.deleteMany({ where: { clubId, userId: hopefulId } });
      await prisma.auditLog.deleteMany({ where: { clubId } });
      await prisma.clubJoinRequest.deleteMany({ where: { clubId } });
    }
  });

  it('opposite decisions at once still leave one outcome', async () => {
    const req = await pendingRequest();
    const results = await Promise.allSettled([
      decideJoinRequest(clubId, req.id, adminId, false, true),
      decideJoinRequest(clubId, req.id, otherAdminId, false, false),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const row = await prisma.clubJoinRequest.findUniqueOrThrow({ where: { id: req.id } });
    const membership = await memberships(hopefulId);
    // Whichever won, the membership must agree with the recorded status.
    expect(membership).toBe(row.status === 'accepted' ? 1 : 0);
    expect(await auditRows()).toHaveLength(1);
  });
});

describe('capacity', () => {
  it('refuses acceptance at the ceiling, and changes nothing', async () => {
    await seed(3); // owner + 2 admins already fill it
    const req = await pendingRequest();

    await expect(decideJoinRequest(clubId, req.id, adminId, false, true)).rejects.toThrow(
      /maximum of 3 players/
    );

    const after = await prisma.clubJoinRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe('pending');
    expect(await memberships(hopefulId)).toBe(0);
    expect(await auditRows()).toHaveLength(0);
    expect(notified).toHaveLength(0);
  });

  it('still allows rejection at the ceiling', async () => {
    await seed(3);
    const req = await pendingRequest();
    const out = await decideJoinRequest(clubId, req.id, adminId, false, false);
    expect(out.status).toBe('rejected');
  });
});

describe('a failed decision leaves nothing behind', () => {
  beforeEach(() => seed());

  it('rolls back the membership and the audit row together', async () => {
    const req = await pendingRequest();

    /*
     * Fail INSIDE the real transaction, after every write has run.
     *
     * Spying on `prisma.clubJoinRequest` does not work: the service writes
     * through `tx`, which is a different client, so the spy never fires and the
     * call simply succeeds. Wrapping `$transaction` instead lets all three real
     * writes happen against the real transaction and then throws, so Postgres
     * does the rollback rather than the test simulating one.
     *
     * What this protects: if the three writes were not one unit, the club could
     * gain a member with no audit row — precisely the state the audit exists to
     * make impossible.
     */
    const realTransaction = prisma.$transaction.bind(prisma);
    const spy = vi
      .spyOn(prisma, '$transaction')
      .mockImplementationOnce(((callback: (tx: unknown) => Promise<unknown>) =>
        realTransaction(async (tx: unknown) => {
          await callback(tx);
          throw new Error('boom');
        })) as never);

    await expect(decideJoinRequest(clubId, req.id, adminId, false, true)).rejects.toThrow('boom');
    spy.mockRestore();

    const after = await prisma.clubJoinRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe('pending');
    expect(await memberships(hopefulId)).toBe(0);
    expect(await auditRows()).toHaveLength(0);
    expect(notified).toHaveLength(0);
  });
});
