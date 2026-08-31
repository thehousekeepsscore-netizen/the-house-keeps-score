import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../realtime/socket.js', () => ({ emitToClub: vi.fn() }));

import { prisma } from '../../lib/prisma.js';
import { settleSession, voidBuyInRequest } from './offlineSessions.service.js';

/**
 * What a player put in is decided by their approved banks, not by the form.
 *
 * The settlement sheet used to be authoritative for buy-ins, and that was the
 * right call while it was the ONLY way to fix a bank approved for the wrong
 * amount — approving is one-way, so a host who approved 5,000 instead of 2,000
 * could do nothing but type 2,000 at settlement. It worked, and it produced
 * settlements whose figures no chip could be traced back to.
 *
 * The void flow replaced that workaround: a wrong bank is voided on the live
 * table and re-taken at the right amount, both audited. These tests pin the
 * consequence — settlement now derives the figure, so every chip it settles
 * can name the request it came from.
 *
 * They deliberately exercise the SERVICE, not the UI. A stale tab or a hand-
 * rolled request can submit any number it likes; the guarantee has to hold
 * there, which is the only place it can be enforced.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

let clubId = '';
let sessionId = '';
let ownerId = '';
let playerId = '';
let thirdId = '';
let createdUsers: string[] = [];

/** The night's own rules, snapshotted as startPlaying would have done. */
const rulesSnapshot = (over: Record<string, unknown> = {}) => ({
  sessionRakeAmount: 0,
  winnersCutPercent: 0,
  rakeEnabled: false,
  rakeMethod: 'PERCENT_PROFIT',
  rakeValue: 0,
  potEnabled: false,
  mismatchStrategy: 'PROPORTIONAL_WINNERS',
  rakeOrder: 'MISMATCH_FIRST',
  winnerDefinition: 'PROFIT_POSITIVE',
  winnerTopN: 1,
  roundingRule: 'NONE',
  ...over,
});

async function seed(clubOver: Record<string, unknown> = {}) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mk = (tag: string, name: string) =>
    prisma.user.create({
      data: { email: `recon-${tag}-${stamp}@test.local`, passwordHash: 'x', displayName: name },
    });

  const owner = await mk('owner', 'Recon Owner');
  const player = await mk('player', 'Recon Player');
  const third = await mk('third', 'Recon Third');
  ownerId = owner.id; playerId = player.id; thirdId = third.id;
  createdUsers = [owner.id, player.id, third.id];

  const club = await prisma.club.create({
    data: {
      name: `Recon ${stamp}`,
      code: `RC${stamp}`.slice(0, 20),
      ownerId: owner.id,
      buyInMode: 'UNCAPPED',
      potEnabled: false,
      sessionRakeAmount: 0,
      winnersCutPercent: 0,
      mismatchStrategy: 'PROPORTIONAL_WINNERS',
      members: { create: [{ userId: owner.id }, { userId: player.id }, { userId: third.id }] },
      ...clubOver,
    },
  });
  clubId = club.id;

  const session = await prisma.pokerSession.create({
    data: {
      clubId: club.id,
      sessionName: 'Recon Night',
      sessionType: 'OFFLINE',
      startedById: owner.id,
      status: 'active',
      engineState: {
        activePlayerUids: [owner.id, player.id],
        pendingSitInUids: [],
        cashOuts: [],
        startedPlayingAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        // The night settles by what it agreed to, not by what the club says
        // today — so the fixture carries the same snapshot startPlaying takes.
        settlementRules: rulesSnapshot({
          potEnabled: clubOver.potEnabled ?? false,
          sessionRakeAmount: clubOver.sessionRakeAmount ?? 0,
          winnersCutPercent: clubOver.winnersCutPercent ?? 0,
          mismatchStrategy: clubOver.mismatchStrategy ?? 'PROPORTIONAL_WINNERS',
        }),
      } as never,
    },
  });
  sessionId = session.id;
}

afterEach(async () => {
  vi.clearAllMocks();
  if (!clubId) return;
  await prisma.auditLog.deleteMany({ where: { clubId } });
  await prisma.cashOutSettlement.deleteMany({ where: { clubId } });
  await prisma.buyInRequest.deleteMany({ where: { clubId } });
  await prisma.pokerSession.deleteMany({ where: { clubId } });
  await prisma.clubMember.deleteMany({ where: { clubId } });
  await prisma.club.deleteMany({ where: { id: clubId } });
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  clubId = '';
});

const bank = (userId: string, amount: number, status = 'approved') =>
  prisma.buyInRequest.create({
    data: { sessionId, clubId, userId, amount, status, requestedBy: userId },
  });

/** Put the night into `settling`, the way the UI always does. */
const enterSettling = async () => {
  const row = await prisma.pokerSession.findUniqueOrThrow({ where: { id: sessionId } });
  await prisma.pokerSession.update({
    where: { id: sessionId },
    data: { engineState: { ...(row.engineState as object), settlingAt: new Date().toISOString() } as never },
  });
};

/** The buy-ins the ENGINE actually settled, read back off the canonical record. */
async function settledBuyIns(): Promise<Record<string, number>> {
  const row = await prisma.cashOutSettlement.findFirstOrThrow({
    where: { sessionId }, orderBy: { settledAt: 'desc' },
  });
  const inputs = row.canonicalInputs as unknown as {
    participants: { userId: string; buyIn: number; cashOut: number }[];
  };
  return Object.fromEntries(inputs.participants.map((p) => [p.userId, p.buyIn]));
}

async function settledCashOuts(): Promise<Record<string, number>> {
  const row = await prisma.cashOutSettlement.findFirstOrThrow({
    where: { sessionId }, orderBy: { settledAt: 'desc' },
  });
  const inputs = row.canonicalInputs as unknown as {
    participants: { userId: string; cashOut: number }[];
  };
  return Object.fromEntries(inputs.participants.map((p) => [p.userId, p.cashOut]));
}

describe('the buy-in that settles is the one the banks say', () => {
  it('agrees with the form when the form is right', async () => {
    await seed();
    await bank(ownerId, 5000);
    await bank(playerId, 5000);
    await enterSettling();

    await settleSession(sessionId, ownerId, false, {
      entries: [
        { userId: ownerId, buyIn: 5000, cashOut: 6000 },
        { userId: playerId, buyIn: 5000, cashOut: 4000 },
      ],
    });

    expect(await settledBuyIns()).toEqual({ [ownerId]: 5000, [playerId]: 5000 });
  });

  it('ignores a smaller submitted figure — the old 5,000 → 2,000 workaround', async () => {
    /*
     * THE REGRESSION THAT RECORDS THE DECISION.
     *
     * This is precisely what a host used to do: a bank was approved for 5,000
     * by mistake, so they typed 2,000 into the settlement sheet. It is now
     * ignored. The supported correction is on the live table — void the 5,000,
     * take a new 2,000 — which the next test exercises end to end.
     */
    await seed();
    await bank(ownerId, 5000);
    await bank(playerId, 5000);
    await enterSettling();

    await settleSession(sessionId, ownerId, false, {
      entries: [
        { userId: ownerId, buyIn: 2000, cashOut: 6000 },
        { userId: playerId, buyIn: 5000, cashOut: 4000 },
      ],
    });

    const settled = await settledBuyIns();
    expect(settled[ownerId], 'the approved bank wins, not the typed figure').toBe(5000);
    expect(settled[ownerId]).not.toBe(2000);
  });

  it('ignores a larger submitted figure just the same', async () => {
    await seed();
    await bank(ownerId, 2000);
    await bank(playerId, 5000);
    await enterSettling();

    await settleSession(sessionId, ownerId, false, {
      entries: [
        { userId: ownerId, buyIn: 5000, cashOut: 3000 },
        { userId: playerId, buyIn: 5000, cashOut: 4000 },
      ],
    });

    expect((await settledBuyIns())[ownerId]).toBe(2000);
  });

  it('the supported correction reaches the same place the workaround aimed at', async () => {
    // void 5,000 → take 2,000 → settle. The end state the old typing produced,
    // now with two audited events explaining it.
    await seed();
    const wrong = await bank(ownerId, 5000);
    await bank(playerId, 5000);

    await voidBuyInRequest(sessionId, ownerId, false, wrong.id, 'approved the wrong amount');
    await bank(ownerId, 2000);
    await enterSettling();

    await settleSession(sessionId, ownerId, false, {
      entries: [
        { userId: ownerId, buyIn: 999999, cashOut: 3000 },
        { userId: playerId, buyIn: 999999, cashOut: 4000 },
      ],
    });

    expect((await settledBuyIns())[ownerId], 'the replacement bank, not the voided one').toBe(2000);
  });

  it('sums several approved banks', async () => {
    await seed();
    await bank(ownerId, 2000);
    await bank(ownerId, 5000);
    await bank(ownerId, 1000);
    await bank(playerId, 3000);
    await enterSettling();

    await settleSession(sessionId, ownerId, false, {
      entries: [
        { userId: ownerId, buyIn: 0, cashOut: 9000 },
        { userId: playerId, buyIn: 0, cashOut: 2000 },
      ],
    });

    expect((await settledBuyIns())[ownerId]).toBe(8000);
  });

  it('leaves a voided bank out of the sum', async () => {
    await seed();
    await bank(ownerId, 2000);
    const voided = await bank(ownerId, 5000);
    await bank(ownerId, 1000);
    await bank(playerId, 3000);
    await voidBuyInRequest(sessionId, ownerId, false, voided.id);
    await enterSettling();

    await settleSession(sessionId, ownerId, false, {
      entries: [
        { userId: ownerId, buyIn: 8000, cashOut: 2000 },
        { userId: playerId, buyIn: 3000, cashOut: 3000 },
      ],
    });

    expect((await settledBuyIns())[ownerId], '2,000 + 1,000 — the voided 5,000 is gone').toBe(3000);
  });

  it('gives a player with no approved banks zero, not the submitted figure', async () => {
    await seed();
    await bank(playerId, 4000);
    await enterSettling();

    await settleSession(sessionId, ownerId, false, {
      entries: [
        { userId: ownerId, buyIn: 7500, cashOut: 1000 },
        { userId: playerId, buyIn: 4000, cashOut: 3000 },
      ],
    });

    expect((await settledBuyIns())[ownerId], 'no banks means nothing was put in').toBe(0);
  });

  it('reconciles each player independently', async () => {
    await seed();
    await bank(ownerId, 5000);
    const gone = await bank(playerId, 5000);
    await bank(playerId, 1000);
    await voidBuyInRequest(sessionId, ownerId, false, gone.id);
    await enterSettling();

    await settleSession(sessionId, ownerId, false, {
      entries: [
        { userId: ownerId, buyIn: 1, cashOut: 4000 },
        { userId: playerId, buyIn: 1, cashOut: 2000 },
      ],
    });

    expect(await settledBuyIns()).toEqual({ [ownerId]: 5000, [playerId]: 1000 });
  });
});

describe('the two server-authoritative mechanisms do not collide', () => {
  it('cash-out still comes from the confirmed count while buy-in comes from the banks', async () => {
    await seed();
    await bank(ownerId, 5000);
    await bank(playerId, 3000);

    // An early, admin-confirmed cash-out: lockedCashOut territory.
    const row = await prisma.pokerSession.findUniqueOrThrow({ where: { id: sessionId } });
    await prisma.pokerSession.update({
      where: { id: sessionId },
      data: {
        engineState: {
          ...(row.engineState as object),
          activePlayerUids: [ownerId],
          cashOuts: [{ userId: playerId, amount: 2500, status: 'confirmed', requestedAt: new Date().toISOString() }],
          settlingAt: new Date().toISOString(),
        } as never,
      },
    });

    await settleSession(sessionId, ownerId, false, {
      entries: [
        { userId: ownerId, buyIn: 111, cashOut: 5500 },
        // Both figures wrong on the form: the cash-out is locked, the buy-in derived.
        { userId: playerId, buyIn: 222, cashOut: 9999 },
      ],
    });

    expect(await settledBuyIns()).toEqual({ [ownerId]: 5000, [playerId]: 3000 });
    const outs = await settledCashOuts();
    expect(outs[playerId], 'the confirmed count still wins').toBe(2500);
    expect(outs[ownerId], 'an unlocked cash-out still comes from the form').toBe(5500);
  });
});

describe('the money rules are untouched by where the buy-in came from', () => {
  it('rake, winners cut and the conservation invariant behave as before', async () => {
    await seed({
      potEnabled: true,
      sessionRakeAmount: 1000,
      winnersCutPercent: 10,
      mismatchStrategy: 'PROPORTIONAL_WINNERS',
    });
    await bank(ownerId, 5000);
    await bank(playerId, 5000);
    await enterSettling();

    await settleSession(sessionId, ownerId, false, {
      entries: [
        // Wildly wrong submissions; the outcome must depend only on the banks.
        { userId: ownerId, buyIn: 40000, cashOut: 7000 },
        { userId: playerId, buyIn: 40000, cashOut: 3000 },
      ],
    });

    const rec = await prisma.cashOutSettlement.findFirstOrThrow({
      where: { sessionId }, orderBy: { settledAt: 'desc' },
    });
    const outputs = rec.canonicalOutputs as unknown as {
      players: { userId: string; netResult: number }[];
      totals: { buyIns: number; cashOuts: number; rake: number; seatFees: number; winnersCut: number };
    };

    expect(await settledBuyIns()).toEqual({ [ownerId]: 5000, [playerId]: 5000 });
    // The engine totalled the DERIVED banks, not the 40,000 the form claimed.
    expect(outputs.totals.buyIns, 'totals follow the derived figures').toBe(10000);
    // 1,000 a seat from two seats, plus 10% of the winner's remaining profit.
    expect(outputs.totals.seatFees).toBe(2000);
    expect(outputs.totals.winnersCut).toBeGreaterThan(0);
    expect(outputs.totals.rake).toBe(outputs.totals.seatFees + outputs.totals.winnersCut);
    // Conservation: what the players net plus what the house took is zero.
    const netSum = outputs.players.reduce((s, p) => s + p.netResult, 0);
    expect(netSum + outputs.totals.rake).toBe(0);
  });
});

describe('the persisted record shows the derived figure, never the submitted one', () => {
  it('canonical inputs carry the approved sum', async () => {
    await seed();
    await bank(ownerId, 5000);
    await bank(playerId, 5000);
    await enterSettling();

    await settleSession(sessionId, ownerId, false, {
      entries: [
        { userId: ownerId, buyIn: 123456, cashOut: 6000 },
        { userId: playerId, buyIn: 654321, cashOut: 4000 },
      ],
    });

    const settled = await settledBuyIns();
    expect(Object.values(settled)).not.toContain(123456);
    expect(Object.values(settled)).not.toContain(654321);
    expect(settled).toEqual({ [ownerId]: 5000, [playerId]: 5000 });
  });
});

describe('both routes into settleSession reconcile', () => {
  it('the UI route, through settling', async () => {
    await seed();
    await bank(ownerId, 5000);
    await bank(playerId, 5000);
    await enterSettling();

    await settleSession(sessionId, ownerId, false, {
      entries: [
        { userId: ownerId, buyIn: 1, cashOut: 6000 },
        { userId: playerId, buyIn: 1, cashOut: 4000 },
      ],
    });
    expect(await settledBuyIns()).toEqual({ [ownerId]: 5000, [playerId]: 5000 });
  });

  it('the direct API route, straight from playing', async () => {
    /*
     * settleSession accepts `playing` as well as `settling`. The UI never uses
     * it — it always freezes through beginSettling first — but the API allows
     * it, and it is the one route where the approved set is NOT frozen. The
     * derivation happens under the same FOR UPDATE lock, so it still reads a
     * consistent set; this pins that the route reconciles too rather than
     * silently keeping the old trust-the-form behaviour.
     */
    await seed();
    await bank(ownerId, 5000);
    await bank(playerId, 5000);
    // NOTE: no enterSettling() — straight from `playing`.

    await settleSession(sessionId, ownerId, false, {
      entries: [
        { userId: ownerId, buyIn: 99, cashOut: 6000 },
        { userId: playerId, buyIn: 99, cashOut: 4000 },
      ],
    });
    expect(await settledBuyIns()).toEqual({ [ownerId]: 5000, [playerId]: 5000 });
  });
});
