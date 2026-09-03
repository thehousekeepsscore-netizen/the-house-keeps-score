import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../realtime/socket.js', () => ({ emitToClub: vi.fn() }));

import { prisma } from '../../lib/prisma.js';
import { settleSession, voidBuyInRequest } from '../offlineSessions/offlineSessions.service.js';
import { listHistory, requestSessionChange } from './clubRecords.service.js';
import { BUY_IN_SOURCE_APPROVED_BANKS } from '../offlineSessions/canonicalSettlement.js';

/**
 * Provenance is established when a night is settled, and an edit honours it.
 *
 * #90 made settleSession derive every buy-in from approved banks and ignore
 * the form. The edit path did not follow, so the guarantee held at settle time
 * and evaporated on the first correction. Closing that could not be done by
 * deriving on every cashout edit: a production audit found one night, settled
 * before #90, whose stored buy-ins deliberately exceed its banks — typed under
 * the workflow that was supported at the time — and eight more that already
 * carry `canonicalInputs` and `capturedFrom: 'settleSession'` while their
 * buy-ins were still the form's. Neither existing field could tell the two
 * populations apart.
 *
 * So settleSession now says on the record that it derived the figures
 * (`canonicalInputs.buyInSource = 'approved-banks'`), and the edit path derives
 * again only where that stamp is present. These tests pin both sides: a
 * stamped night is held to the banks on every edit, and an unstamped one keeps
 * the behaviour it was created under. Above all, an edit never ADDS the stamp
 * — that would promote a legacy night into the derived population one edit
 * late, which is the same silent rewrite one step removed.
 *
 * Driven through requestSessionChange, the real door, with the owner as the
 * requester so the change applies rather than staging.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

let clubId = '';
let sessionId = '';
let ownerId = '';
let playerId = '';
let createdUsers: string[] = [];
const settlementIds: string[] = [];

const rulesSnapshot = () => ({
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
});

async function seed() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mk = (tag: string, name: string) =>
    prisma.user.create({
      data: { email: `prov-${tag}-${stamp}@test.local`, passwordHash: 'x', displayName: name },
    });
  const owner = await mk('owner', 'Prov Owner');
  const player = await mk('player', 'Prov Player');
  ownerId = owner.id; playerId = player.id;
  createdUsers = [owner.id, player.id];

  const club = await prisma.club.create({
    data: {
      name: `Prov ${stamp}`,
      code: `PV${stamp}`.slice(0, 20),
      ownerId: owner.id,
      buyInMode: 'UNCAPPED',
      potEnabled: false,
      sessionRakeAmount: 0,
      winnersCutPercent: 0,
      mismatchStrategy: 'PROPORTIONAL_WINNERS',
      members: { create: [{ userId: owner.id }, { userId: player.id }] },
    },
  });
  clubId = club.id;

  const session = await prisma.pokerSession.create({
    data: {
      clubId: club.id,
      sessionName: 'Prov Night',
      sessionType: 'OFFLINE',
      startedById: owner.id,
      status: 'active',
      engineState: {
        activePlayerUids: [owner.id, player.id],
        pendingSitInUids: [],
        cashOuts: [],
        startedPlayingAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        settlementRules: rulesSnapshot(),
      } as never,
    },
  });
  sessionId = session.id;
}

afterEach(async () => {
  vi.clearAllMocks();
  if (!clubId) return;
  await prisma.settlementRevision.deleteMany({ where: { recordId: { in: settlementIds.splice(0) } } });
  await prisma.auditLog.deleteMany({ where: { clubId } });
  await prisma.clubPotLog.deleteMany({ where: { clubId } });
  await prisma.pendingChangeRequest.deleteMany({ where: { clubId } });
  await prisma.historicalSessionRecord.deleteMany({ where: { clubId } });
  await prisma.cashOutSettlement.deleteMany({ where: { clubId } });
  await prisma.buyInRequest.deleteMany({ where: { clubId } });
  await prisma.pokerSession.deleteMany({ where: { clubId } });
  await prisma.clubMember.deleteMany({ where: { clubId } });
  await prisma.club.deleteMany({ where: { id: clubId } });
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  clubId = '';
});

const bank = (userId: string, amount: number) =>
  prisma.buyInRequest.create({
    data: { sessionId, clubId, userId, amount, status: 'approved', requestedBy: userId },
  });

const enterSettling = async () => {
  const row = await prisma.pokerSession.findUniqueOrThrow({ where: { id: sessionId } });
  await prisma.pokerSession.update({
    where: { id: sessionId },
    data: { engineState: { ...(row.engineState as object), settlingAt: new Date().toISOString() } as never },
  });
};

/** Settles the seeded night through the real path and returns the record id. */
async function settle(): Promise<string> {
  await enterSettling();
  await settleSession(sessionId, ownerId, false, {
    entries: [
      { userId: ownerId, buyIn: 0, cashOut: 6000 },
      { userId: playerId, buyIn: 0, cashOut: 4000 },
    ],
  });
  const row = await prisma.cashOutSettlement.findFirstOrThrow({ where: { sessionId } });
  settlementIds.push(row.id);
  return row.id;
}

type Summary = { userId: string; totalBuyIn: number; cashOut: number };

const record = (id: string) => prisma.cashOutSettlement.findUniqueOrThrow({ where: { id } });

const summariesOf = async (id: string) => (await record(id)).playerSummaries as unknown as Summary[];

const storedBuyIn = async (id: string, userId: string) =>
  (await summariesOf(id)).find((p) => p.userId === userId)!.totalBuyIn;

const markerOf = async (id: string) =>
  ((await record(id)).canonicalInputs as { buyInSource?: unknown } | null)?.buyInSource;

/**
 * Submits an edit of the record with the given buy-in for every player, and
 * one cash-out nudged so the edit is not a no-op. The buy-in is what these
 * tests are about: it is either honoured or ignored, depending on provenance.
 */
async function editWithBuyIns(id: string, buyIns: Record<string, number>) {
  const current = await summariesOf(id);
  const updated = current.map((p) => ({
    ...p,
    totalBuyIn: buyIns[p.userId] ?? p.totalBuyIn,
    cashOut: p.userId === playerId ? p.cashOut + 100 : p.cashOut,
  }));
  return requestSessionChange(clubId, ownerId, 'Host', false, {
    sessionId: id,
    sourceType: 'cashout',
    sessionTitle: 'Prov Night',
    requestType: 'edit_session',
    changes: [],
    updatedPlayerSummaries: updated as never,
  });
}

/**
 * Turns a freshly settled record into a legacy one, the two ways production
 * holds them: no canonical record at all (settled before the contract), or a
 * canonical record with no provenance stamp (settled between the contract and
 * the derivation — eight production nights). Only the stamp is removed; the
 * figures and everything else stay exactly as settled.
 */
async function makeLegacy(id: string, shape: 'null' | 'unstamped') {
  if (shape === 'null') {
    await prisma.cashOutSettlement.update({
      where: { id }, data: { canonicalInputs: null as never, canonicalOutputs: null as never, engineVersion: null },
    });
    return;
  }
  const row = await record(id);
  const { buyInSource: _dropped, ...rest } = row.canonicalInputs as Record<string, unknown>;
  void _dropped;
  await prisma.cashOutSettlement.update({ where: { id }, data: { canonicalInputs: rest as never } });
}

describe('settleSession stamps where the buy-ins came from', () => {
  it('writes buyInSource = approved-banks on the record it creates', async () => {
    await seed();
    await bank(ownerId, 5000);
    await bank(playerId, 5000);
    const id = await settle();

    expect(await markerOf(id)).toBe(BUY_IN_SOURCE_APPROVED_BANKS);
    expect(await markerOf(id)).toBe('approved-banks');
  });
});

describe('the history list tells the edit form which nights are locked', () => {
  /*
   * The form branches on this flag, and the server branches on the record's
   * marker when the edit lands. They must be the same test, so the list
   * exposes the marker rather than something a screen could misread.
   */
  it('carries buyInSource for a stamped night and nothing for a legacy one', async () => {
    await seed();
    await bank(ownerId, 5000);
    await bank(playerId, 5000);
    const id = await settle();

    const stamped = (await listHistory(clubId, ownerId, false)).find((h) => h.id === id);
    expect(stamped).toMatchObject({ sourceType: 'cashout', buyInSource: 'approved-banks' });

    await makeLegacy(id, 'unstamped');
    const legacy = (await listHistory(clubId, ownerId, false)).find((h) => h.id === id);
    expect(legacy).toBeDefined();
    expect(legacy).not.toHaveProperty('buyInSource');
  });
});

describe('editing a stamped night derives the buy-in again', () => {
  it('ignores a deliberately wrong submitted buy-in', async () => {
    await seed();
    await bank(ownerId, 5000);
    await bank(playerId, 5000);
    const id = await settle();

    // The old workaround, attempted after the fact: type 2,000 over a 5,000 bank.
    const outcome = await editWithBuyIns(id, { [ownerId]: 2000 });
    expect(outcome, 'the owner applies directly — an edit that only staged would prove nothing')
      .toMatchObject({ status: 'applied' });

    expect(await storedBuyIn(id, ownerId), 'the approved bank wins, not the typed figure').toBe(5000);
    expect(await storedBuyIn(id, ownerId)).not.toBe(2000);
  });

  it('ignores a larger submitted buy-in just the same', async () => {
    await seed();
    await bank(ownerId, 2000);
    await bank(playerId, 5000);
    const id = await settle();

    await editWithBuyIns(id, { [ownerId]: 300000 });

    expect(await storedBuyIn(id, ownerId)).toBe(2000);
  });

  it('sums several approved banks', async () => {
    await seed();
    await bank(ownerId, 2000);
    await bank(ownerId, 5000);
    await bank(ownerId, 1000);
    await bank(playerId, 3000);
    const id = await settle();

    await editWithBuyIns(id, { [ownerId]: 1 });

    expect(await storedBuyIn(id, ownerId)).toBe(8000);
  });

  it('leaves a voided bank out of the sum', async () => {
    await seed();
    await bank(ownerId, 4000);
    await bank(playerId, 2000);
    const voided = await bank(playerId, 5000);
    await bank(playerId, 1000);
    // Voided on the live table, before settling — the supported correction.
    await voidBuyInRequest(sessionId, ownerId, false, voided.id, 'wrong amount');
    const id = await settle();

    await editWithBuyIns(id, { [playerId]: 8000 });

    expect(await storedBuyIn(id, playerId), '2,000 + 1,000 — the voided 5,000 stays gone').toBe(3000);
  });

  it('keeps the stamp, so the next edit derives too', async () => {
    /*
     * The edit path rebuilds canonicalInputs. If it dropped the stamp while
     * doing so, a stamped night would demote itself to legacy after one
     * correction and the second correction would honour the form again —
     * the mirror image of the promotion this change forbids.
     */
    await seed();
    await bank(ownerId, 5000);
    await bank(playerId, 5000);
    const id = await settle();

    await editWithBuyIns(id, { [ownerId]: 2000 });
    expect(await markerOf(id), 'carried forward by the first edit').toBe('approved-banks');

    await editWithBuyIns(id, { [ownerId]: 2000 });
    expect(await storedBuyIn(id, ownerId), 'still derived on the second edit').toBe(5000);
  });

  it('refuses with 409 when a stamped night has no approved banks to derive from', async () => {
    await seed();
    await bank(ownerId, 5000);
    await bank(playerId, 5000);
    const id = await settle();
    const before = await record(id);

    // A contradiction manufactured for the test: the stamp says derived, the
    // banks are gone. Production has no such row; the point is what the code
    // does if one ever appears — and "settle everyone at zero" is not it.
    await prisma.buyInRequest.deleteMany({ where: { sessionId } });

    await expect(editWithBuyIns(id, { [ownerId]: 5000 })).rejects.toMatchObject({ status: 409 });

    const after = await record(id);
    expect(after.playerSummaries, 'nothing was rewritten').toEqual(before.playerSummaries);
    expect(after.totalBuyIns).toBe(before.totalBuyIns);
    expect(after.totalBuyIns).not.toBe(0);
  });
});

describe('editing a legacy night keeps the behaviour it was settled under', () => {
  for (const shape of ['null', 'unstamped'] as const) {
    describe(`with canonicalInputs ${shape}`, () => {
      it('honours the submitted buy-in', async () => {
        await seed();
        await bank(ownerId, 5000);
        await bank(playerId, 5000);
        const id = await settle();
        await makeLegacy(id, shape);

        // The 9 Aug shape: a figure the banks cannot reproduce, typed on purpose.
        await editWithBuyIns(id, { [ownerId]: 7000 });

        expect(await storedBuyIn(id, ownerId), 'the form is authoritative for a legacy night').toBe(7000);
      });

      it('does not gain the stamp from being edited', async () => {
        await seed();
        await bank(ownerId, 5000);
        await bank(playerId, 5000);
        const id = await settle();
        await makeLegacy(id, shape);
        expect(await markerOf(id), 'precondition: legacy').toBeUndefined();

        await editWithBuyIns(id, { [ownerId]: 7000 });

        const inputs = (await record(id)).canonicalInputs as Record<string, unknown> | null;
        expect(inputs, 'the edit records its inputs as it always did').not.toBeNull();
        expect(inputs).not.toHaveProperty('buyInSource');
        // The key must be absent, not present-and-undefined: a JSON column
        // cannot tell those apart, and a later reader must not either.
        expect(Object.keys(inputs!)).not.toContain('buyInSource');
      });

      it('is not blocked by the 409 even with no approved banks at all', async () => {
        await seed();
        await bank(ownerId, 5000);
        await bank(playerId, 5000);
        const id = await settle();
        await makeLegacy(id, shape);
        await prisma.buyInRequest.deleteMany({ where: { sessionId } });

        await expect(editWithBuyIns(id, { [ownerId]: 5000 })).resolves.toMatchObject({ status: 'applied' });
      });
    });
  }
});

describe('a back-dated night is untouched', () => {
  it('still honours the submitted buy-in on edit', async () => {
    await seed();
    const rec = await prisma.historicalSessionRecord.create({
      data: {
        clubId,
        sessionDate: '2026-01-10',
        sessionTitle: 'Notebook Night',
        importedBy: ownerId,
        playerStats: [
          { userName: 'Prov Owner', userId: ownerId, totalBuyIn: 1000, cashOut: 1500, profit: 500, timestamp: '2026-01-10' },
          { userName: 'Prov Player', userId: playerId, totalBuyIn: 1000, cashOut: 500, profit: -500, timestamp: '2026-01-10' },
        ] as never,
      },
    });

    await requestSessionChange(clubId, ownerId, 'Host', false, {
      sessionId: rec.id,
      sourceType: 'historical',
      sessionTitle: 'Notebook Night',
      requestType: 'edit_session',
      changes: [],
      updatedPlayerStats: [
        { userName: 'Prov Owner', userId: ownerId, totalBuyIn: 2500, cashOut: 1500, profit: -1000, timestamp: '2026-01-10' },
        { userName: 'Prov Player', userId: playerId, totalBuyIn: 1000, cashOut: 500, profit: -500, timestamp: '2026-01-10' },
      ] as never,
    });

    const after = await prisma.historicalSessionRecord.findUniqueOrThrow({ where: { id: rec.id } });
    const stats = after.playerStats as unknown as { userId?: string; totalBuyIn: number }[];
    expect(stats.find((p) => p.userId === ownerId)!.totalBuyIn).toBe(2500);
    expect((after.canonicalInputs as Record<string, unknown>)).not.toHaveProperty('buyInSource');
  });
});
