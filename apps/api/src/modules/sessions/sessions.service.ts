import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { emitToClub, emitToSessionPerUser } from '../../realtime/socket.js';
import * as engine from './engine.js';
import { VTEngineState, VTSeat } from './types.js';
import { EngineMutationResult } from './engine.js';

interface SessionRow {
  id: string;
  clubId: string;
  sessionName: string;
  sessionType: string;
  status: string;
  startedById: string;
  createdAt: Date;
  endedAt: Date | null;
  engineState: VTEngineState;
}

// Every seat's hole cards live in one JSON blob — never let them go out to a
// viewer who isn't that seat's owner. Cards are only ever revealed to
// everyone at a genuine multi-way showdown (contenders.length > 1); a hand
// that ends because everyone else folded never needs anyone to show.
function redactHoleCards(state: VTEngineState, viewerUid: string | undefined): VTEngineState {
  const contenders = (state.playerSeats || []).filter((s) => s.uid && !s.isFolded);
  const revealAll = state.street === 'Showdown' && contenders.length > 1;
  return {
    ...state,
    playerSeats: (state.playerSeats || []).map((seat) =>
      revealAll || seat.uid === viewerUid ? seat : { ...seat, holeCards: [] }
    ),
  };
}

function serialize(row: SessionRow, viewerUid?: string) {
  return {
    id: row.id,
    clubId: row.clubId,
    sessionName: row.sessionName,
    sessionType: row.sessionType,
    status: row.status,
    startedById: row.startedById,
    createdAt: row.createdAt,
    endedAt: row.endedAt,
    ...redactHoleCards(row.engineState, viewerUid)
  };
}

interface TransactionOutcome {
  row: SessionRow;
  // false when the mutator declined the action (wrong turn, already seated,
  // etc.) — the row is still the current (unchanged) state, but callers must
  // check this to tell "nothing happened" apart from "it worked".
  applied: boolean;
}

// Row-locks the session for the duration of the transaction (SELECT ... FOR
// UPDATE), reproducing the same atomic read-modify-write guarantee the
// Firestore version got from runTransaction — this is what makes turn
// ownership checks and idempotent timeouts safe under concurrent requests.
async function runEngineTransaction(
  sessionId: string,
  mutator: (state: VTEngineState) => EngineMutationResult | null
): Promise<TransactionOutcome | null> {
  const outcome = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<SessionRow[]>`
      SELECT id, "clubId", "sessionName", "sessionType", status, "startedById", "createdAt", "endedAt", "engineState"
      FROM "PokerSession" WHERE id = ${sessionId} FOR UPDATE
    `;
    const row = rows[0];
    if (!row) return null;

    const mutation = mutator(row.engineState);
    if (!mutation) return { row, applied: false };

    const updated = await tx.pokerSession.update({
      where: { id: sessionId },
      data: { engineState: mutation.state as any },
    });

    if (mutation.historyRecord) {
      await tx.handHistory.create({
        data: {
          sessionId,
          clubId: row.clubId,
          ...mutation.historyRecord,
          communityCards: mutation.historyRecord.communityCards as any,
        },
      });
    }

    return { row: { ...row, engineState: updated.engineState as unknown as VTEngineState }, applied: true };
  });

  if (outcome?.applied) {
    const finalRow = outcome.row;
    await emitToSessionPerUser(sessionId, 'session:update', (viewerUid) => serialize(finalRow, viewerUid));
  }
  return outcome;
}

export async function getSession(sessionId: string, viewerUid?: string) {
  const row = await prisma.pokerSession.findUnique({ where: { id: sessionId } });
  if (!row) throw new HttpError(404, 'Session not found');
  return serialize(row as unknown as SessionRow, viewerUid);
}

export async function getActiveVirtualTableSession(clubId: string, viewerUid?: string) {
  const row = await prisma.pokerSession.findFirst({
    where: { clubId, sessionType: 'VIRTUAL_TABLE', status: 'active' },
    orderBy: { createdAt: 'desc' },
  });
  return row ? serialize(row as unknown as SessionRow, viewerUid) : null;
}

export interface CreateVirtualTableInput {
  tableName: string;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  maxPlayers: number;
  skipBlindLimit: number;
}

export async function createVirtualTableSession(
  clubId: string,
  hostUid: string,
  hostName: string,
  hostAvatarUrl: string | undefined,
  input: CreateVirtualTableInput
) {
  const existing = await getActiveVirtualTableSession(clubId);
  if (existing) throw new HttpError(409, 'This club already has an active Virtual Table session');

  const hostSeat: VTSeat = {
    seatNumber: 1,
    uid: hostUid,
    name: hostName,
    avatarUrl: hostAvatarUrl,
    chipStack: input.minBuyIn,
    activeBank: input.minBuyIn,
    bankUpdatedAt: new Date().toISOString(),
    isFolded: false,
    isSatOut: false,
    holeCards: [],
    currentBet: 0,
    totalInvestedInHand: 0,
    isAllIn: false,
    statVPIP: 25,
    statPFR: 18,
    statHandsPlayed: 10,
  };

  const engineState: VTEngineState = {
    hostUid,
    hostName,
    tableName: input.tableName,
    smallBlind: input.smallBlind,
    bigBlind: input.bigBlind,
    minBuyIn: input.minBuyIn,
    maxBuyIn: input.maxBuyIn,
    maxPlayers: input.maxPlayers,
    skipBlindLimit: input.skipBlindLimit,
    isGameStarted: false,
    handNumber: 0,
    street: 'Preflop',
    dealerSeat: 1,
    potSize: 0,
    currentHighBet: 0,
    currentTurnSeat: null,
    communityCards: [],
    burnCards: [],
    deck: [],
    playerSeats: [hostSeat],
    winningAnnouncement: null,
    actionLog: [],
  };

  const row = await prisma.pokerSession.create({
    data: {
      clubId,
      sessionName: input.tableName,
      sessionType: 'VIRTUAL_TABLE',
      status: 'active',
      startedById: hostUid,
      engineState: engineState as any,
    },
  });

  const serialized = serialize(row as unknown as SessionRow, hostUid);
  emitToClub(clubId, 'club:session-created', { sessionId: row.id, sessionType: 'VIRTUAL_TABLE' });
  return serialized;
}

function assertHost(state: VTEngineState, userId: string, isSuperAdmin: boolean) {
  if (state.hostUid !== userId && !isSuperAdmin) {
    throw new HttpError(403, 'Only the table host can do this');
  }
}

export async function enterSeat(sessionId: string, uid: string, name: string, avatarUrl: string | undefined) {
  const outcome = await runEngineTransaction(sessionId, (state) => {
    const seats = state.playerSeats || [];
    if (seats.some(s => s.uid === uid)) return null;

    const occ = new Set(seats.map(s => s.seatNumber));
    let seatNum = 1;
    while (occ.has(seatNum) && seatNum <= state.maxPlayers) seatNum++;
    if (seatNum > state.maxPlayers) throw new HttpError(400, 'Table is full');

    const newSeat: VTSeat = {
      seatNumber: seatNum,
      uid,
      name,
      avatarUrl,
      chipStack: state.minBuyIn,
      activeBank: state.minBuyIn,
      bankUpdatedAt: new Date().toISOString(),
      isFolded: false,
      isSatOut: false,
      holeCards: [],
      currentBet: 0,
      totalInvestedInHand: 0,
      isAllIn: false,
    };

    return { state: { ...state, playerSeats: [...seats, newSeat].sort((a, b) => a.seatNumber - b.seatNumber) } };
  });
  if (!outcome) throw new HttpError(404, 'Session not found');
  if (!outcome.applied) throw new HttpError(409, 'You are already seated at this table');
  return serialize(outcome.row, uid);
}

const BOT_NAMES = ['Vikram (AI)', 'Rahul (AI)', 'Karan (AI)', 'Priya (AI)', 'Ananya (AI)'];

export async function addBot(sessionId: string, requesterId: string, isSuperAdmin: boolean) {
  const outcome = await runEngineTransaction(sessionId, (state) => {
    assertHost(state, requesterId, isSuperAdmin);
    const seats = state.playerSeats || [];
    const occ = new Set(seats.map(s => s.seatNumber));
    let seatNum = 1;
    while (occ.has(seatNum) && seatNum <= state.maxPlayers) seatNum++;
    if (seatNum > state.maxPlayers) throw new HttpError(400, 'Table is full');

    const name = BOT_NAMES[seats.length % BOT_NAMES.length];
    const botSeat: VTSeat = {
      seatNumber: seatNum,
      uid: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      chipStack: state.minBuyIn,
      activeBank: state.minBuyIn,
      bankUpdatedAt: new Date().toISOString(),
      isFolded: false,
      isSatOut: false,
      holeCards: [],
      currentBet: 0,
      totalInvestedInHand: 0,
      isAllIn: false,
      statVPIP: 24,
      statPFR: 15,
      statHandsPlayed: 18,
    };

    return { state: { ...state, playerSeats: [...seats, botSeat].sort((a, b) => a.seatNumber - b.seatNumber) } };
  });
  if (!outcome) throw new HttpError(404, 'Session not found');
  if (!outcome.applied) throw new HttpError(400, 'Could not add bot');
  return serialize(outcome.row, requesterId);
}

export async function dealHand(sessionId: string, requesterId: string, isSuperAdmin: boolean) {
  const outcome = await runEngineTransaction(sessionId, (state) => {
    assertHost(state, requesterId, isSuperAdmin);
    if (engine.getActiveSeats(state.playerSeats || []).length < 2) {
      throw new HttpError(400, 'At least 2 active players are required to deal');
    }
    return engine.dealNewHand(state);
  });
  if (!outcome) throw new HttpError(404, 'Session not found');
  if (!outcome.applied) throw new HttpError(400, 'Could not deal hand');
  return serialize(outcome.row, requesterId);
}

function seatNumberForUser(state: VTEngineState, uid: string): number {
  const seat = (state.playerSeats || []).find(s => s.uid === uid);
  if (!seat) throw new HttpError(403, 'You are not seated at this table');
  return seat.seatNumber;
}

export async function fold(sessionId: string, uid: string) {
  const outcome = await runEngineTransaction(sessionId, (state) => engine.foldSeat(state, seatNumberForUser(state, uid)));
  if (!outcome) throw new HttpError(404, 'Session not found');
  if (!outcome.applied) throw new HttpError(409, 'Not your turn');
  return serialize(outcome.row, uid);
}

export async function check(sessionId: string, uid: string) {
  const outcome = await runEngineTransaction(sessionId, (state) => engine.checkSeat(state, seatNumberForUser(state, uid)));
  if (!outcome) throw new HttpError(404, 'Session not found');
  if (!outcome.applied) throw new HttpError(409, 'Cannot check right now');
  return serialize(outcome.row, uid);
}

export async function call(sessionId: string, uid: string) {
  const outcome = await runEngineTransaction(sessionId, (state) => engine.callSeat(state, seatNumberForUser(state, uid)));
  if (!outcome) throw new HttpError(404, 'Session not found');
  if (!outcome.applied) throw new HttpError(409, 'Not your turn');
  return serialize(outcome.row, uid);
}

export async function betRaise(sessionId: string, uid: string, targetBet: number) {
  const outcome = await runEngineTransaction(sessionId, (state) => engine.betRaiseSeat(state, seatNumberForUser(state, uid), targetBet));
  if (!outcome) throw new HttpError(404, 'Session not found');
  if (!outcome.applied) throw new HttpError(409, 'Not your turn');
  return serialize(outcome.row, uid);
}

export async function updateSettings(
  sessionId: string,
  requesterId: string,
  isSuperAdmin: boolean,
  input: { tableName?: string; smallBlind?: number; bigBlind?: number; skipBlindLimit?: number }
) {
  const outcome = await runEngineTransaction(sessionId, (state) => {
    assertHost(state, requesterId, isSuperAdmin);
    return { state: { ...state, ...input } };
  });
  if (!outcome) throw new HttpError(404, 'Session not found');
  if (!outcome.applied) throw new HttpError(400, 'Could not update settings');
  return serialize(outcome.row, requesterId);
}

export async function endSession(sessionId: string, requesterId: string, isSuperAdmin: boolean) {
  // Row-locked so we can never settle against a stack mid-update by a
  // concurrent fold/check/call/raise landing between the read and the write.
  const summary = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<SessionRow[]>`
      SELECT id, "clubId", "sessionName", "sessionType", status, "startedById", "createdAt", "endedAt", "engineState"
      FROM "PokerSession" WHERE id = ${sessionId} FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new HttpError(404, 'Session not found');
    const state = row.engineState;
    assertHost(state, requesterId, isSuperAdmin);

    const seats = (state.playerSeats || []).filter(s => s.uid && !s.uid.startsWith('bot-'));
    const summaries = seats.map(s => {
      const totalBuyIn = s.activeBank;
      const cashOut = s.chipStack;
      const grossProfit = cashOut - totalBuyIn;
      return {
        userId: s.uid,
        userDisplayName: s.name,
        totalBuyIn,
        cashOut,
        grossProfit,
        winnersCutDeduction: 0,
        excessDeduction: 0,
        netResult: grossProfit,
      };
    });

    const totalBuyIns = summaries.reduce((sum, p) => sum + p.totalBuyIn, 0);
    const totalCashOuts = summaries.reduce((sum, p) => sum + p.cashOut, 0);

    await tx.cashOutSettlement.create({
      data: {
        clubId: row.clubId,
        sessionId: row.id,
        sessionType: 'Virtual Table Session',
        settledBy: requesterId,
        totalBuyIns,
        totalCashOuts,
        totalWinnersCut: 0,
        rakeCollected: 0,
        potAdjustment: 0,
        playerSummaries: summaries as any,
      },
    });
    await tx.pokerSession.update({ where: { id: sessionId }, data: { status: 'settled', endedAt: new Date() } });

    return { clubId: row.clubId };
  });

  emitToClub(summary.clubId, 'club:session-ended', { sessionId });
}

export async function listHandHistory(sessionId: string) {
  return prisma.handHistory.findMany({ where: { sessionId }, orderBy: { createdAt: 'desc' }, take: 50 });
}

export async function requestBuyIn(sessionId: string, clubId: string, userId: string, amount: number) {
  return prisma.buyInRequest.create({
    data: { sessionId, clubId, userId, amount, status: 'pending', requestedBy: userId },
  });
}

export async function listBuyInRequests(sessionId: string) {
  return prisma.buyInRequest.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
}

export async function decideBuyInRequest(sessionId: string, requestId: string, requesterId: string, isSuperAdmin: boolean, approve: boolean) {
  const req = await prisma.buyInRequest.findUnique({ where: { id: requestId } });
  if (!req || req.sessionId !== sessionId) throw new HttpError(404, 'Buy-in request not found');
  if (req.status !== 'pending') throw new HttpError(409, 'Already decided');

  await prisma.buyInRequest.update({
    where: { id: requestId },
    data: { status: approve ? 'approved' : 'rejected', approvedBy: requesterId },
  });

  if (approve) {
    const outcome = await runEngineTransaction(sessionId, (state) => {
      assertHost(state, requesterId, isSuperAdmin);
      const seats = state.playerSeats || [];
      const idx = seats.findIndex(s => s.uid === req.userId);
      if (idx === -1) return null;
      const updated = [...seats];
      updated[idx] = {
        ...updated[idx],
        chipStack: updated[idx].chipStack + req.amount,
        activeBank: updated[idx].activeBank + req.amount,
        bankUpdatedAt: new Date().toISOString(),
      };
      return { state: { ...state, playerSeats: updated } };
    });
    if (!outcome) throw new HttpError(404, 'Session not found');
    if (!outcome.applied) throw new HttpError(400, 'Could not apply buy-in — player is no longer seated');
    return serialize(outcome.row, requesterId);
  }

  return getSession(sessionId, requesterId);
}

// Server-owned timeout sweep — runs regardless of which browser tabs are
// open, unlike the old design where only the host's client drove timeouts.
export async function sweepExpiredTurns() {
  const active = await prisma.pokerSession.findMany({
    where: { sessionType: 'VIRTUAL_TABLE', status: 'active' },
    select: { id: true, engineState: true },
  });

  for (const row of active) {
    const state = row.engineState as unknown as VTEngineState;
    if (!state.isGameStarted || state.street === 'Showdown' || state.currentTurnSeat == null || !state.turnStartedAt) continue;
    const elapsed = (Date.now() - new Date(state.turnStartedAt).getTime()) / 1000;
    if (elapsed >= engine.TURN_DURATION_SEC) {
      const seatNumber = state.currentTurnSeat;
      const turnStartedAt = state.turnStartedAt;
      await runEngineTransaction(row.id, (s) => engine.timeoutSeat(s, seatNumber, turnStartedAt)).catch(err =>
        console.error('Timeout sweep failed for session', row.id, err)
      );
    }
  }
}
