import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../../lib/prisma.js';

/**
 * Two admins, one table, and the same 300ms.
 *
 * A host and a co-host are both looking at the same queue on their own phones.
 * Both see "Rahul +3,000". Both press Approve. The taps land a quarter of a
 * second apart, which on a phone is indistinguishable from together.
 *
 * Optimistic UIs hide this completely: both screens animate the row away, both
 * admins believe they did it, and nobody sees an error. So the question has to
 * be asked of the database rather than of the interface.
 *
 * There are two separate hazards here and they are not the same size:
 *
 *   the SAME request approved twice — does the player get 3,000 or 6,000?
 *   DIFFERENT requests approved at once — engineState is a JSON blob written
 *   read-modify-write, so the second write can silently erase the first.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

vi.mock('../../realtime/socket.js', () => ({ emitToClub: () => {} }));

const { requestBuyIn, decideBuyInRequest, requestSitIn, decideSitIn, requestCashOut, decideCashOut, startPlaying } =
  await import('./offlineSessions.service.js');

let clubId = '';
let sessionId = '';
let ownerId = '';
let adminId = '';
let rahulId = '';
let priyaId = '';
let createdUsers: string[] = [];

async function seed() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mk = (role: string, name: string) =>
    prisma.user.create({
      data: { email: `race-${role}-${stamp}@test.local`, passwordHash: 'x', displayName: name },
    });

  const [owner, admin, rahul, priya] = await Promise.all([
    mk('owner', 'Race Owner'),
    mk('admin', 'Race Admin'),
    mk('rahul', 'Rahul'),
    mk('priya', 'Priya'),
  ]);
  ownerId = owner.id;
  adminId = admin.id;
  rahulId = rahul.id;
  priyaId = priya.id;
  createdUsers = [owner.id, admin.id, rahul.id, priya.id];

  const club = await prisma.club.create({
    data: {
      name: `Race Test ${stamp}`,
      code: `RC${stamp}`.slice(0, 20),
      ownerId: owner.id,
      buyInMode: 'UNCAPPED',
      members: {
        create: [{ userId: owner.id }, { userId: admin.id }, { userId: rahul.id }, { userId: priya.id }],
      },
      admins: { create: [{ userId: admin.id }] },
    },
  });
  clubId = club.id;

  const session = await prisma.pokerSession.create({
    data: {
      clubId: club.id,
      sessionName: 'Race Night',
      sessionType: 'OFFLINE',
      startedById: owner.id,
      engineState: {
        startedPlayingAt: new Date().toISOString(),
        activePlayerUids: [ownerId, adminId],
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

beforeEach(seed);
afterEach(cleanup);

/** Both admins press at once. Neither is allowed to take the other's error down with it. */
const settle = <T>(p: Promise<T>) =>
  p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));

async function bankedTotal(userId: string) {
  const rows = await prisma.buyInRequest.findMany({ where: { sessionId, userId, status: 'approved' } });
  return rows.reduce((sum, r) => sum + r.amount, 0);
}

describe('two admins approve the same request', () => {
  it('credits the player once, whatever happens to the second press', async () => {
    // The money question, and the only one that must never be wrong. The amount
    // lives on the request row rather than being added to a running total, so
    // deciding it twice is idempotent by construction.
    const req = await requestBuyIn(sessionId, clubId, rahulId, 3_000);

    await Promise.all([
      settle(decideBuyInRequest(sessionId, ownerId, false, req.id, true)),
      settle(decideBuyInRequest(sessionId, adminId, false, req.id, true)),
    ]);

    expect(await bankedTotal(rahulId)).toBe(3_000);
  });

  it('seats the player exactly once', async () => {
    const req = await requestBuyIn(sessionId, clubId, rahulId, 3_000);

    await Promise.all([
      settle(decideBuyInRequest(sessionId, ownerId, false, req.id, true)),
      settle(decideBuyInRequest(sessionId, adminId, false, req.id, true)),
    ]);

    const state = (await prisma.pokerSession.findUnique({ where: { id: sessionId } }))!
      .engineState as any;
    expect(state.activePlayerUids.filter((u: string) => u === rahulId)).toHaveLength(1);
  });

  it('records exactly one admin as having approved it', async () => {
    // The audit trail question. Two writers with no guard means last-writer-wins
    // on approvedBy, and the ledger then names somebody who lost the race.
    const req = await requestBuyIn(sessionId, clubId, rahulId, 3_000);

    const [a, b] = await Promise.all([
      settle(decideBuyInRequest(sessionId, ownerId, false, req.id, true)),
      settle(decideBuyInRequest(sessionId, adminId, false, req.id, true)),
    ]);

    // Exactly one press should win; the other should be told it was already
    // decided rather than quietly overwriting the record.
    const winners = [a, b].filter((r) => r.ok);
    expect(winners).toHaveLength(1);

    const row = await prisma.buyInRequest.findUnique({ where: { id: req.id } });
    expect(row?.status).toBe('approved');
    expect([ownerId, adminId]).toContain(row?.approvedBy);
  });
});

describe('two admins approve different requests at the same moment', () => {
  it('seats both players — neither write erases the other', async () => {
    /*
     * The bigger hazard, and the one that is invisible from the interface.
     *
     * engineState is a single JSON column written read-modify-write: each call
     * reads the whole blob, adds one uid, and writes the whole blob back. Two
     * calls overlapping means the second write is built from a snapshot taken
     * before the first one landed, so it puts back a list that never had the
     * first player in it. Rahul is approved, told he is approved, charged for
     * his chips — and has no seat.
     */
    const rahul = await requestBuyIn(sessionId, clubId, rahulId, 3_000);
    const priya = await requestBuyIn(sessionId, clubId, priyaId, 5_000);

    await Promise.all([
      settle(decideBuyInRequest(sessionId, ownerId, false, rahul.id, true)),
      settle(decideBuyInRequest(sessionId, adminId, false, priya.id, true)),
    ]);

    const state = (await prisma.pokerSession.findUnique({ where: { id: sessionId } }))!
      .engineState as any;
    expect(state.activePlayerUids).toContain(rahulId);
    expect(state.activePlayerUids).toContain(priyaId);
  });

  it('does not lose the players who were already sitting', async () => {
    const rahul = await requestBuyIn(sessionId, clubId, rahulId, 3_000);
    const priya = await requestBuyIn(sessionId, clubId, priyaId, 5_000);

    await Promise.all([
      settle(decideBuyInRequest(sessionId, ownerId, false, rahul.id, true)),
      settle(decideBuyInRequest(sessionId, adminId, false, priya.id, true)),
    ]);

    const state = (await prisma.pokerSession.findUnique({ where: { id: sessionId } }))!
      .engineState as any;
    expect(state.activePlayerUids).toContain(ownerId);
    expect(state.activePlayerUids).toContain(adminId);
  });
});

/**
 * A lock only works if every writer takes it.
 *
 * The approval path is not the only thing that rewrites engineState — sitting
 * in, standing up and confirming a count all do the same read-modify-write. A
 * buy-in approved at the same moment somebody's cash-out is confirmed is not an
 * unusual Friday; it is what the last twenty minutes of every night look like.
 */
describe('approvals racing everything else that writes the table', () => {
  it('keeps a new player seated while somebody else is being counted out', async () => {
    await requestCashOut(sessionId, clubId, adminId, 4_000);
    const rahul = await requestBuyIn(sessionId, clubId, rahulId, 3_000);

    await Promise.all([
      settle(decideBuyInRequest(sessionId, ownerId, false, rahul.id, true)),
      settle(decideCashOut(sessionId, clubId, ownerId, false, adminId, true)),
    ]);

    const state = (await prisma.pokerSession.findUnique({ where: { id: sessionId } }))!
      .engineState as any;
    // Rahul was approved, so he is seated. The admin's count was confirmed, so
    // they are not. Neither write may erase the other.
    expect(state.activePlayerUids).toContain(rahulId);
    expect(state.activePlayerUids).not.toContain(adminId);
    expect(state.cashOuts.find((c: any) => c.userId === adminId)?.status).toBe('confirmed');
  });

  it('keeps a sit-in approval and a buy-in approval from erasing each other', async () => {
    await requestSitIn(sessionId, clubId, priyaId);
    const rahul = await requestBuyIn(sessionId, clubId, rahulId, 3_000);

    await Promise.all([
      settle(decideBuyInRequest(sessionId, ownerId, false, rahul.id, true)),
      settle(decideSitIn(sessionId, clubId, adminId, false, priyaId, true)),
    ]);

    const state = (await prisma.pokerSession.findUnique({ where: { id: sessionId } }))!
      .engineState as any;
    expect(state.activePlayerUids).toContain(rahulId);
    expect(state.activePlayerUids).toContain(priyaId);
  });
});

/**
 * The owner opens the table and goes home.
 *
 * Nothing about a session is owner-only — starting play, approving, confirming
 * a count and settling are all assertClubAdmin, so the admins who stayed can
 * run the whole night. That part holds.
 *
 * What does not hold is the second-pair-of-eyes rule. It asks whether another
 * ADMIN exists, and the answer is yes: the owner, asleep at home. The one admin
 * still at the table cannot approve their own chips, nobody else is awake to do
 * it, and the request expires in five minutes. The rule written to stop a game
 * being blocked is what blocks it.
 */
describe('the owner opens the table and leaves', () => {
  async function ownerGoesHome() {
    // Stands up, is counted out, and is no longer at the table.
    await requestCashOut(sessionId, clubId, ownerId, 5_000);
    await decideCashOut(sessionId, clubId, adminId, false, ownerId, true);
  }

  it('lets the admins who stayed approve everybody else', async () => {
    await ownerGoesHome();
    const req = await requestBuyIn(sessionId, clubId, rahulId, 3_000);
    await decideBuyInRequest(sessionId, adminId, false, req.id, true);

    const row = await prisma.buyInRequest.findUnique({ where: { id: req.id } });
    expect(row?.status).toBe('approved');
    expect(row?.approvedBy).toBe(adminId);
  });

  it('lets the last admin at the table bank themselves once the owner has gone', async () => {
    // The whole point of the escape hatch: being alone. An admin who is alone
    // AT THE TABLE is alone, whatever the club roster says — the owner is at
    // home and cannot approve anything.
    await ownerGoesHome();
    const req = await requestBuyIn(sessionId, clubId, adminId, 3_000);
    await decideBuyInRequest(sessionId, adminId, false, req.id, true);

    const row = await prisma.buyInRequest.findUnique({ where: { id: req.id } });
    expect(row?.status).toBe('approved');
  });

  it('still refuses self-approval while another admin is actually here', async () => {
    const req = await requestBuyIn(sessionId, clubId, adminId, 3_000);
    await expect(
      decideBuyInRequest(sessionId, adminId, false, req.id, true)
    ).rejects.toMatchObject({ status: 403 });
  });

  it('lets an admin who stayed start the night the owner opened', async () => {
    await prisma.pokerSession.update({
      where: { id: sessionId },
      data: {
        engineState: {
          startedPlayingAt: null,
          activePlayerUids: [adminId, rahulId],
          pendingSitInUids: [],
          cashOuts: [],
        } as any,
      },
    });
    for (const uid of [adminId, rahulId]) {
      const r = await requestBuyIn(sessionId, clubId, uid, 5_000);
      await decideBuyInRequest(sessionId, ownerId, false, r.id, true);
    }

    const started: any = await startPlaying(sessionId, clubId, adminId, false);
    expect(started.startedPlayingAt).toBeTruthy();
  });
});
