import { describe, it, expect, afterEach, vi } from 'vitest';

// The realtime layer is mocked so the emit can be observed. Nothing else in
// this file depends on a live socket.
vi.mock('../../realtime/socket.js', () => ({ emitToClub: vi.fn() }));

import { prisma } from '../../lib/prisma.js';
import { emitToClub } from '../../realtime/socket.js';
import {
  voidBuyInRequest,
  getBuyInCeiling,
} from './offlineSessions.service.js';

/**
 * Taking back an approved buy-in, without pretending it never had its amount.
 *
 * Approval is one-way: `decideBuyInRequest` refuses anything that is not still
 * pending. So a host who approved 5,000 instead of 2,000 had nothing to press,
 * and those chips kept counting toward the player's bank and toward the
 * MATCH_HIGHEST ceiling every other player may match, all night.
 *
 * The property these tests exist to protect is "no phantom chips": once a
 * buy-in is voided, no calculation anywhere may still see it. That holds by
 * construction — every consumer filters `status === 'approved'` by equality —
 * and these prove it rather than assume it.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

const CONFIGURED_MAX = 5_000;

let clubId = '';
let sessionId = '';
let ownerId = '';
let adminId = '';
let playerId = '';
let createdUsers: string[] = [];

async function seed(opts: { withSecondAdmin?: boolean } = {}) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mk = (tag: string, name: string) =>
    prisma.user.create({
      data: { email: `void-${tag}-${stamp}@test.local`, passwordHash: 'x', displayName: name },
    });

  const owner = await mk('owner', 'Void Owner');
  const admin = await mk('admin', 'Void Admin');
  const player = await mk('player', 'Void Player');
  ownerId = owner.id;
  adminId = admin.id;
  playerId = player.id;
  createdUsers = [owner.id, admin.id, player.id];

  const club = await prisma.club.create({
    data: {
      name: `Void Test ${stamp}`,
      code: `VT${stamp}`.slice(0, 20),
      ownerId: owner.id,
      buyInMode: 'MATCH_HIGHEST',
      maxBuyIn: CONFIGURED_MAX,
      members: { create: [{ userId: owner.id }, { userId: admin.id }, { userId: player.id }] },
      ...(opts.withSecondAdmin ? { admins: { create: [{ userId: admin.id }] } } : {}),
    },
  });
  clubId = club.id;

  const session = await prisma.pokerSession.create({
    data: {
      clubId: club.id,
      sessionName: 'Void Night',
      sessionType: 'OFFLINE',
      startedById: owner.id,
      engineState: {
        activePlayerUids: [owner.id, admin.id, playerId],
        pendingSitInUids: [],
        // `playing` — startedPlayingAt present, settlingAt absent.
        startedPlayingAt: new Date().toISOString(),
      },
    },
  });
  sessionId = session.id;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (!clubId) return;
  await prisma.auditLog.deleteMany({ where: { clubId } });
  await prisma.buyInRequest.deleteMany({ where: { clubId } });
  await prisma.pokerSession.deleteMany({ where: { clubId } });
  await prisma.clubAdmin.deleteMany({ where: { clubId } });
  await prisma.clubMember.deleteMany({ where: { clubId } });
  await prisma.club.deleteMany({ where: { id: clubId } });
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  clubId = '';
});

const bank = (userId: string, amount: number, status = 'approved') =>
  prisma.buyInRequest.create({
    data: { sessionId, clubId, userId, amount, status, requestedBy: userId },
  });

/** What every live consumer computes: the sum of NON-voided approved rows. */
async function approvedTotal(userId: string) {
  const rows = await prisma.buyInRequest.findMany({
    where: { sessionId, userId, status: 'approved' },
  });
  return rows.reduce((s, r) => s + r.amount, 0);
}

async function setPhase(patch: Record<string, unknown>) {
  const row = await prisma.pokerSession.findUniqueOrThrow({ where: { id: sessionId } });
  await prisma.pokerSession.update({
    where: { id: sessionId },
    data: { engineState: { ...(row.engineState as object), ...patch } as never },
  });
}

describe('voiding an approved buy-in', () => {
  it('moves the row to voided and leaves its amount alone', async () => {
    await seed();
    const req = await bank(playerId, 5000);

    await voidBuyInRequest(sessionId, ownerId, false, req.id, 'approved the wrong amount');

    const after = await prisma.buyInRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe('voided');
    // The whole point: the original figure survives.
    expect(after.amount, 'the approved amount is never rewritten').toBe(5000);
    expect(after.voidedBy).toBe(ownerId);
    expect(after.voidedAt).toBeInstanceOf(Date);
    expect(after.voidReason).toBe('approved the wrong amount');
  });

  it('removes the chips from the ceiling', async () => {
    await seed();
    await bank(playerId, 2000);
    const big = await bank(ownerId, 5000);
    expect(await getBuyInCeiling(sessionId, clubId)).toBe(5000);

    await voidBuyInRequest(sessionId, ownerId, false, big.id);

    // Falls back to the next real bank, not to the voided one.
    expect(await getBuyInCeiling(sessionId, clubId)).toBe(2000);
  });

  it('removes the chips from the player bank that every live figure is built on', async () => {
    await seed();
    const first = await bank(playerId, 5000);
    await bank(playerId, 1000);
    expect(await approvedTotal(playerId)).toBe(6000);

    await voidBuyInRequest(sessionId, ownerId, false, first.id);

    expect(await approvedTotal(playerId)).toBe(1000);
  });

  it('drops the player out of readiness when it was their only bank', async () => {
    // `startPlaying` counts a player ready if they hold an approved buy-in.
    await seed();
    const only = await bank(playerId, 3000);
    const readyBefore = await prisma.buyInRequest.findMany({
      where: { sessionId, status: 'approved' }, select: { userId: true },
    });
    expect(readyBefore.map((r) => r.userId)).toContain(playerId);

    await voidBuyInRequest(sessionId, ownerId, false, only.id);

    const readyAfter = await prisma.buyInRequest.findMany({
      where: { sessionId, status: 'approved' }, select: { userId: true },
    });
    expect(readyAfter.map((r) => r.userId)).not.toContain(playerId);
  });

  it('survives a refetch — the state is in the row, not in a cache', async () => {
    await seed();
    const req = await bank(playerId, 5000);
    await voidBuyInRequest(sessionId, ownerId, false, req.id);

    const reread = await prisma.buyInRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(reread.status).toBe('voided');
    expect(await getBuyInCeiling(sessionId, clubId)).toBe(CONFIGURED_MAX);
  });

  it('writes one audit row naming the actor, the player and the amount', async () => {
    await seed();
    const req = await bank(playerId, 5000);

    await voidBuyInRequest(sessionId, ownerId, false, req.id, 'fat finger');

    const logs = await prisma.auditLog.findMany({ where: { clubId, action: 'void_buy_in' } });
    expect(logs).toHaveLength(1);
    expect(logs[0].changedBy).toBe(ownerId);
    expect(logs[0].details).toContain('5000');
    expect(logs[0].details).toContain('fat finger');
    expect((logs[0].changes as Record<string, unknown>).requestId).toBe(req.id);
  });
});

describe('what may not be voided', () => {
  it('refuses a pending request — that is what reject is for', async () => {
    await seed();
    const req = await bank(playerId, 5000, 'pending');
    await expect(voidBuyInRequest(sessionId, ownerId, false, req.id)).rejects.toThrow(
      /only an approved buy-in/i
    );
    const after = await prisma.buyInRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status, 'left untouched').toBe('pending');
  });

  it('refuses a rejected request', async () => {
    await seed();
    const req = await bank(playerId, 5000, 'rejected');
    await expect(voidBuyInRequest(sessionId, ownerId, false, req.id)).rejects.toThrow(
      /only an approved buy-in/i
    );
  });

  it('refuses while the night is settling', async () => {
    // The host is reading a count seeded from these rows; moving one underneath
    // them changes figures they are checking without their asking.
    await seed();
    const req = await bank(playerId, 5000);
    await setPhase({ settlingAt: new Date().toISOString() });

    await expect(voidBuyInRequest(sessionId, ownerId, false, req.id)).rejects.toThrow(
      /settled|resume/i
    );
    const after = await prisma.buyInRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe('approved');
  });

  it('refuses a second void — the state is terminal', async () => {
    await seed();
    const req = await bank(playerId, 5000);
    await voidBuyInRequest(sessionId, ownerId, false, req.id);

    await expect(voidBuyInRequest(sessionId, ownerId, false, req.id)).rejects.toThrow(
      /already been voided/i
    );
  });

  it('lets exactly one of two simultaneous voids win', async () => {
    await seed();
    const req = await bank(playerId, 5000);

    const settled = await Promise.allSettled([
      voidBuyInRequest(sessionId, ownerId, false, req.id),
      voidBuyInRequest(sessionId, adminId, false, req.id),
    ]);
    const ok = settled.filter((r) => r.status === 'fulfilled');
    const failed = settled.filter((r) => r.status === 'rejected');

    expect(ok, 'exactly one winner').toHaveLength(1);
    expect(failed).toHaveLength(1);

    const after = await prisma.buyInRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe('voided');
    const logs = await prisma.auditLog.findMany({ where: { clubId, action: 'void_buy_in' } });
    expect(logs, 'and only one audit row').toHaveLength(1);
  });

  it('stops an admin voiding their own buy-in while another admin is present', async () => {
    // Voiding your own bank shrinks what you are recorded as putting in, which
    // improves your net — the mirror of the self-approval rule.
    await seed({ withSecondAdmin: true });
    const mine = await bank(adminId, 5000);

    await expect(voidBuyInRequest(sessionId, adminId, false, mine.id)).rejects.toThrow(
      /another club admin/i
    );
  });

  it('allows it when nobody else is there to ask', async () => {
    // The escape hatch is being alone, not being senior — same as approval.
    await seed();
    const mine = await bank(ownerId, 5000);

    await expect(voidBuyInRequest(sessionId, ownerId, false, mine.id)).resolves.toBeTruthy();
  });

  it('refuses a non-admin outright', async () => {
    await seed();
    const req = await bank(playerId, 5000);
    await expect(voidBuyInRequest(sessionId, playerId, false, req.id)).rejects.toThrow();
  });
});

describe('the void and its audit row commit together or not at all', () => {
  /*
   * HONEST LIMITATION, stated rather than faked.
   *
   * Both writes happen on the `tx` client inside one `mutateSessionState`
   * transaction. `tx` is a distinct Prisma proxy, so spying on the top-level
   * `prisma.*` does NOT intercept it — a mid-transaction failure cannot be
   * injected through the public API without mocking the client wholesale, at
   * which point the test stops exercising a real database and proves nothing
   * about the real transaction.
   *
   * So atomicity is pinned from the two directions that ARE reachable: a
   * successful void writes both, and a refusal that happens before the writes
   * leaves neither. The claim that the audit write is load-bearing and lives
   * inside the transaction is carried by mutation M4, which removes it and must
   * fail the audit test above.
   */
  it('writes the status change and the audit row together on success', async () => {
    await seed();
    const req = await bank(playerId, 5000);

    await voidBuyInRequest(sessionId, ownerId, false, req.id);

    const after = await prisma.buyInRequest.findUniqueOrThrow({ where: { id: req.id } });
    const logs = await prisma.auditLog.findMany({ where: { clubId, action: 'void_buy_in' } });
    expect(after.status).toBe('voided');
    expect(logs).toHaveLength(1);
  });

  it('writes neither when the call is refused before the transaction does anything', async () => {
    await seed();
    const req = await bank(playerId, 5000);
    await setPhase({ settlingAt: new Date().toISOString() });

    await expect(voidBuyInRequest(sessionId, ownerId, false, req.id)).rejects.toThrow();

    const after = await prisma.buyInRequest.findUniqueOrThrow({ where: { id: req.id } });
    const logs = await prisma.auditLog.findMany({ where: { clubId, action: 'void_buy_in' } });
    expect(after.status, 'nothing changed').toBe('approved');
    expect(logs, 'and nothing was logged').toHaveLength(0);
  });
});

describe('invariant: the ceiling is the largest surviving bank', () => {
  /*
   * The property, rather than an example of it. Any sequence of approvals and
   * voids must leave the ceiling equal to the biggest per-player total of rows
   * that are still approved — which is what "no phantom chips" means when
   * stated arithmetically.
   */
  it('holds across a mixed sequence of approvals and voids', async () => {
    await seed();
    const a1 = await bank(playerId, 1500);
    const a2 = await bank(playerId, 1500);
    const b1 = await bank(adminId, 4000);
    const c1 = await bank(ownerId, 2500);

    const expected = async () => {
      const rows = await prisma.buyInRequest.findMany({ where: { sessionId, status: 'approved' } });
      const per = new Map<string, number>();
      for (const r of rows) per.set(r.userId, (per.get(r.userId) ?? 0) + r.amount);
      const highest = per.size ? Math.max(...per.values()) : 0;
      return highest > 0 ? highest : CONFIGURED_MAX;
    };

    expect(await getBuyInCeiling(sessionId, clubId)).toBe(await expected());

    for (const id of [b1.id, a1.id, c1.id, a2.id]) {
      await voidBuyInRequest(sessionId, ownerId, false, id);
      expect(await getBuyInCeiling(sessionId, clubId)).toBe(await expected());
    }

    // Everything voided: back to the club's configured maximum, not to zero and
    // not to a remembered figure.
    expect(await getBuyInCeiling(sessionId, clubId)).toBe(CONFIGURED_MAX);
  });
});

describe('the realtime event follows the commit, never leads it', () => {
  /*
   * An event emitted before or inside the transaction is a claim about state
   * that may still roll back — every other device would act on a void that
   * never happened. These pin the ordering from the only side that is
   * observable: a call that is REFUSED must announce nothing.
   */
  it('announces the void once it has actually happened', async () => {
    await seed();
    const req = await bank(playerId, 5000);
    vi.mocked(emitToClub).mockClear();

    await voidBuyInRequest(sessionId, ownerId, false, req.id);

    expect(emitToClub).toHaveBeenCalledTimes(1);
    const [, event, payload] = vi.mocked(emitToClub).mock.calls[0];
    expect(event).toBe('club:buyin-voided');
    expect((payload as { requestId: string }).requestId).toBe(req.id);
    // Carries the original amount, so listeners never have to guess what left.
    expect((payload as { amount: number }).amount).toBe(5000);
  });

  it('announces nothing when the void is refused', async () => {
    await seed();
    const req = await bank(playerId, 5000);
    await setPhase({ settlingAt: new Date().toISOString() });
    vi.mocked(emitToClub).mockClear();

    await expect(voidBuyInRequest(sessionId, ownerId, false, req.id)).rejects.toThrow();

    expect(emitToClub, 'nothing happened, so nothing is announced').not.toHaveBeenCalled();
  });

  it('announces nothing on a losing double void', async () => {
    await seed();
    const req = await bank(playerId, 5000);
    await voidBuyInRequest(sessionId, ownerId, false, req.id);
    vi.mocked(emitToClub).mockClear();

    await expect(voidBuyInRequest(sessionId, ownerId, false, req.id)).rejects.toThrow();

    expect(emitToClub).not.toHaveBeenCalled();
  });
});
