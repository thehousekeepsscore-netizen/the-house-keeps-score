import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { emitToClub } from '../../realtime/socket.js';
import * as clubsService from '../clubs/clubs.service.js';
import * as notificationsService from '../notifications/notifications.service.js';
import { computeSettlement, SettlementSettings, SETTLEMENT_ENGINE_VERSION } from './settlementEngine.js';
import { AUDIT_SCHEMA_VERSION } from '../clubRecords/auditMeta.js';

// Offline and Lazy Dealer sessions don't run the automated poker engine —
// they're a lightweight buy-in/cash-out wrapper (the same one the Firestore
// version used for both types) so engineState only ever needs a handful of
// config fields plus the running list of who's bought into the table.
interface OfflineEngineState {
  activePlayerUids: string[];
  // Members who asked to sit in but haven't been waved through by an admin
  // yet. Kept here rather than in its own table since it's transient state
  // that dies with the session.
  pendingSitInUids?: string[];
  // When each pending sit-in was asked for, so it can expire like the other
  // two request types. Kept as a side map rather than turning
  // pendingSitInUids into objects, so the serialized shape the client already
  // reads stays exactly as it was.
  sitInRequestedAt?: Record<string, string>;
  // A player who stood up mid-session and declared their chips. Stays pending
  // until an admin confirms the count, then their seat is freed and the amount
  // is carried into settlement as their cash-out.
  cashOuts?: { userId: string; amount: number; status: 'pending' | 'confirmed'; requestedAt: string; confirmedBy?: string }[];
  assignedDealerUid?: string;
  assignedDealerName?: string;
  smallBlind?: number;
  bigBlind?: number;
  minBuyIn?: number;
  maxBuyIn?: number;
  maxPlayers?: number;
  skipBlindLimit?: number;
}

interface SessionRow {
  id: string;
  clubId: string;
  sessionName: string;
  sessionType: string;
  status: string;
  startedById: string;
  createdAt: Date;
  endedAt: Date | null;
  engineState: OfflineEngineState;
}

function serialize(row: SessionRow) {
  return {
    id: row.id,
    clubId: row.clubId,
    sessionName: row.sessionName,
    sessionType: row.sessionType,
    status: row.status,
    startedById: row.startedById,
    createdAt: row.createdAt,
    endedAt: row.endedAt,
    ...row.engineState,
  };
}

function hasOtherAdmins(club: { admins: { userId: string }[] }, excludeUserId: string) {
  return club.admins.some((a) => a.userId !== excludeUserId);
}

// Seating someone who had already cashed out voids that cash-out. They never
// actually took the money off the table — they carry those chips straight back
// into play — so the figure is not theirs to keep and must not survive as a
// locked settlement number. Their banks are deliberately left alone: the chips
// were bought once, and settlement still nets them against whatever they
// finally leave with. Taking another bank later is a separate buy-in as usual.
//
// This matters beyond the seat: settleSession treats a confirmed cash-out as
// the authority over the admin's settle form, so a stale one would quietly
// lock in a figure from an earlier stint.
function clearCashOutFor(state: OfflineEngineState, userId: string): OfflineEngineState {
  if (!state.cashOuts?.length) return state;
  return { ...state, cashOuts: state.cashOuts.filter((c) => c.userId !== userId) };
}

// A request an admin hasn't acted on within this window is auto-rejected. It
// applies to the three at-the-table request types only — buy-in, sit-in and
// cash-out — where a stale request misrepresents the live table. Club join
// requests and edit-approval requests deliberately never expire: nobody is
// waiting at a table for those, and an owner who is offline for five minutes
// would otherwise reject every one of them.
export const REQUEST_TTL_MS = 5 * 60 * 1000;

// Removes a pending sit-in and its timestamp without seating the player.
async function dropSitIn(sessionId: string, state: OfflineEngineState, userId: string) {
  const pendingSitInUids = (state.pendingSitInUids || []).filter((u) => u !== userId);
  const sitInRequestedAt = { ...(state.sitInRequestedAt || {}) };
  delete sitInRequestedAt[userId];
  await prisma.pokerSession.update({
    where: { id: sessionId },
    data: { engineState: { ...state, pendingSitInUids, sitInRequestedAt } as any },
  });
}

export function isRequestExpired(requestedAt: Date | string | undefined, now = Date.now()): boolean {
  if (!requestedAt) return false; // no timestamp recorded — never expire it
  const t = requestedAt instanceof Date ? requestedAt.getTime() : Date.parse(requestedAt);
  return Number.isFinite(t) && now - t > REQUEST_TTL_MS;
}

/**
 * Auto-rejects every at-the-table request that has outlived REQUEST_TTL_MS.
 *
 * The decide* paths each re-check expiry themselves, so this is not what makes
 * expiry correct — it is what makes it *visible*: it clears dead rows out of
 * the admin's queue and emits the same events a real decision would, so open
 * clients update without a reload. Safe to call on an interval and safe to run
 * concurrently with a real decision, since every write is narrowed to rows
 * that are still pending.
 *
 * Assumes a single API process. With more than one, run it on only one of them
 * (or move to a scheduler) or each instance will emit duplicate events.
 */
export async function expireStaleRequests(now = Date.now()) {
  const cutoff = new Date(now - REQUEST_TTL_MS);
  let expiredBuyIns = 0;
  let expiredSitIns = 0;
  let expiredCashOuts = 0;

  // Buy-ins live in their own table, so they expire in one statement. Grab the
  // ids first — the update itself can't tell us which rows it touched.
  const staleBuyIns = await prisma.buyInRequest.findMany({
    where: { status: 'pending', createdAt: { lt: cutoff } },
    select: { id: true, sessionId: true, clubId: true, userId: true },
  });
  if (staleBuyIns.length > 0) {
    await prisma.buyInRequest.updateMany({
      where: { id: { in: staleBuyIns.map((r) => r.id) }, status: 'pending' },
      data: { status: 'rejected' },
    });
    expiredBuyIns = staleBuyIns.length;
    for (const r of staleBuyIns) {
      emitToClub(r.clubId, 'club:buyin-decided', {
        sessionId: r.sessionId, requestId: r.id, userId: r.userId, approve: false, expired: true,
      });
    }
  }

  // Sit-ins and cash-outs are engineState fields, so they need a read/modify/
  // write per active session.
  const sessions = await prisma.pokerSession.findMany({
    where: { status: 'active' },
    select: { id: true, clubId: true, engineState: true },
  });

  for (const session of sessions) {
    const state = session.engineState as unknown as OfflineEngineState;

    const deadSitIns = (state.pendingSitInUids || []).filter((uid) =>
      isRequestExpired(state.sitInRequestedAt?.[uid], now)
    );
    const deadCashOuts = (state.cashOuts || []).filter(
      (c) => c.status === 'pending' && isRequestExpired(c.requestedAt, now)
    );
    if (deadSitIns.length === 0 && deadCashOuts.length === 0) continue;

    const pendingSitInUids = (state.pendingSitInUids || []).filter((uid) => !deadSitIns.includes(uid));
    const sitInRequestedAt = { ...(state.sitInRequestedAt || {}) };
    deadSitIns.forEach((uid) => delete sitInRequestedAt[uid]);
    // Rejecting a cash-out drops it entirely, same as decideCashOut does, so
    // the player can re-count and ask again.
    const deadCashOutUids = new Set(deadCashOuts.map((c) => c.userId));
    const cashOuts = (state.cashOuts || []).filter((c) => !deadCashOutUids.has(c.userId));

    await prisma.pokerSession.update({
      where: { id: session.id },
      data: { engineState: { ...state, pendingSitInUids, sitInRequestedAt, cashOuts } as any },
    });

    for (const uid of deadSitIns) {
      emitToClub(session.clubId, 'club:sitin-decided', {
        sessionId: session.id, userId: uid, approved: false, expired: true,
      });
    }
    for (const c of deadCashOuts) {
      emitToClub(session.clubId, 'club:cashout-decided', {
        sessionId: session.id, userId: c.userId, approved: false, expired: true,
      });
    }
    expiredSitIns += deadSitIns.length;
    expiredCashOuts += deadCashOuts.length;
  }

  return { expiredBuyIns, expiredSitIns, expiredCashOuts };
}

export interface StartSessionInput {
  sessionType: 'OFFLINE' | 'LAZY_DEALER';
  sessionName: string;
  assignedDealerUid?: string;
  assignedDealerName?: string;
  smallBlind?: number;
  bigBlind?: number;
  minBuyIn?: number;
  maxBuyIn?: number;
  maxPlayers?: number;
  skipBlindLimit?: number;
}

export async function getActiveOfflineSession(clubId: string) {
  const row = await prisma.pokerSession.findFirst({
    where: { clubId, status: 'active', sessionType: { in: ['OFFLINE', 'LAZY_DEALER'] } },
    orderBy: { createdAt: 'desc' },
  });
  return row ? serialize(row as unknown as SessionRow) : null;
}

export async function startSession(clubId: string, requesterId: string, isSuperAdmin: boolean, input: StartSessionInput) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubAdmin(club, requesterId, isSuperAdmin);

  const existing = await getActiveOfflineSession(clubId);
  if (existing) throw new HttpError(409, 'This club already has an active session');

  const engineState: OfflineEngineState = {
    activePlayerUids: [requesterId],
    assignedDealerUid: input.assignedDealerUid,
    assignedDealerName: input.assignedDealerName,
    smallBlind: input.smallBlind,
    bigBlind: input.bigBlind,
    minBuyIn: input.minBuyIn,
    maxBuyIn: input.maxBuyIn,
    maxPlayers: input.maxPlayers,
    skipBlindLimit: input.skipBlindLimit,
  };

  const row = await prisma.pokerSession.create({
    data: {
      clubId,
      sessionName: input.sessionName,
      sessionType: input.sessionType,
      status: 'active',
      startedById: requesterId,
      engineState: engineState as any,
    },
  });

  const serialized = serialize(row as unknown as SessionRow);
  emitToClub(clubId, 'club:session-started', { sessionId: row.id, sessionType: input.sessionType });
  return serialized;
}

// Lets a player mark themselves "at the table" before they've requested a
// bank yet — mirrors the original app's plain join-table action, separate
// from requesting/approving an actual buy-in.
export async function joinSession(sessionId: string, userId: string) {
  const session = await prisma.pokerSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new HttpError(404, 'Session not found');
  const state = clearCashOutFor(session.engineState as unknown as OfflineEngineState, userId);
  const activePlayerUids = Array.from(new Set([...(state.activePlayerUids || []), userId]));
  const row = await prisma.pokerSession.update({
    where: { id: sessionId },
    data: { engineState: { ...state, activePlayerUids } as any },
  });
  return serialize(row as unknown as SessionRow);
}

// A member who isn't seated yet asks to be dealt in. Admins already at the
// table approve it — self-seating stays available via joinSession for the
// admin who started the session.
export async function requestSitIn(sessionId: string, clubId: string, userId: string) {
  const session = await prisma.pokerSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new HttpError(404, 'Session not found');
  if (session.status !== 'active') throw new HttpError(409, 'This session has already been settled');

  const state = session.engineState as unknown as OfflineEngineState;
  if ((state.activePlayerUids || []).includes(userId)) {
    throw new HttpError(409, 'You are already seated at this table');
  }

  const pendingSitInUids = Array.from(new Set([...(state.pendingSitInUids || []), userId]));
  const sitInRequestedAt = { ...(state.sitInRequestedAt || {}), [userId]: new Date().toISOString() };
  const row = await prisma.pokerSession.update({
    where: { id: sessionId },
    data: { engineState: { ...state, pendingSitInUids, sitInRequestedAt } as any },
  });

  emitToClub(clubId, 'club:sitin-requested', { sessionId, userId });
  return serialize(row as unknown as SessionRow);
}

export async function decideSitIn(
  sessionId: string,
  clubId: string,
  requesterId: string,
  isSuperAdmin: boolean,
  userId: string,
  approve: boolean
) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubAdmin(club, requesterId, isSuperAdmin);

  const session = await prisma.pokerSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new HttpError(404, 'Session not found');

  const state = session.engineState as unknown as OfflineEngineState;

  // Only ever act on someone who actually asked — otherwise an approve call
  // could seat an arbitrary user id that never requested a seat.
  if (!(state.pendingSitInUids || []).includes(userId)) {
    throw new HttpError(404, 'No pending sit-in request from that player');
  }

  // Checked at decision time as well as by the sweep: the sweep runs on an
  // interval, so without this an admin could still approve a request in the
  // gap after it expired but before it was swept.
  if (isRequestExpired(state.sitInRequestedAt?.[userId])) {
    await dropSitIn(sessionId, state, userId);
    emitToClub(clubId, 'club:sitin-decided', { sessionId, userId, approved: false, expired: true });
    throw new HttpError(409, 'That sit-in request expired before it was approved');
  }

  const pendingSitInUids = (state.pendingSitInUids || []).filter((u) => u !== userId);
  const sitInRequestedAt = { ...(state.sitInRequestedAt || {}) };
  delete sitInRequestedAt[userId];
  // Only an approval seats them, so only an approval voids an earlier cash-out.
  const nextState = approve ? clearCashOutFor(state, userId) : state;
  const activePlayerUids = approve
    ? Array.from(new Set([...(state.activePlayerUids || []), userId]))
    : state.activePlayerUids || [];

  const row = await prisma.pokerSession.update({
    where: { id: sessionId },
    data: { engineState: { ...nextState, activePlayerUids, pendingSitInUids, sitInRequestedAt } as any },
  });

  emitToClub(clubId, 'club:sitin-decided', { sessionId, userId, approved: approve });
  return serialize(row as unknown as SessionRow);
}


/**
 * The ceiling on a single buy-in request, per the club's buyInMode.
 *
 *   UNCAPPED       — no ceiling.
 *   MATCH_HIGHEST  — a request may be as large as the biggest bank any player
 *                    currently holds. Before anyone holds one, the club's
 *                    configured maxBuyIn is the opening ceiling. The ceiling
 *                    only ever rises: taking the maximum makes your own bank
 *                    the new reference.
 *
 * Returns null only for UNCAPPED clubs, which is the sole case the UI labels
 * "No limit". A MATCH_HIGHEST club always has a number.
 */
export async function getBuyInCeiling(sessionId: string, clubId: string): Promise<number | null> {
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { buyInMode: true, maxBuyIn: true },
  });
  if (!club || club.buyInMode === 'UNCAPPED') return null;

  const approved = await prisma.buyInRequest.findMany({
    where: { sessionId, status: 'approved' },
    select: { userId: true, amount: true },
  });

  const banks = new Map<string, number>();
  for (const r of approved) banks.set(r.userId, (banks.get(r.userId) || 0) + r.amount);
  const highest = banks.size > 0 ? Math.max(...banks.values()) : 0;

  // Before anyone holds a bank there is nothing to match, so the club's
  // configured maxBuyIn is the opening ceiling. Previously this returned null,
  // which meant the opening buy-in of a night was unbounded no matter what the
  // club had configured — and the table showed "No limit" while it was true.
  //
  // Afterwards the biggest bank at the table takes over, so the ceiling only
  // ever rises: taking the maximum makes your own bank the new reference.
  return highest > 0 ? highest : club.maxBuyIn;
}

async function assertWithinBuyInCeiling(sessionId: string, clubId: string, amount: number) {
  const ceiling = await getBuyInCeiling(sessionId, clubId);
  if (ceiling !== null && amount > ceiling) {
    throw new HttpError(400, `Buy-in of ${amount} exceeds the current table maximum of ${ceiling}`);
  }
}


// A player leaving before the night ends: they count their chips, an admin
// confirms, and the figure is locked in for settlement. Kept on engineState
// rather than its own table since it dies with the session.
export async function requestCashOut(sessionId: string, clubId: string, userId: string, amount: number) {
  const session = await prisma.pokerSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new HttpError(404, 'Session not found');
  if (session.status !== 'active') throw new HttpError(409, 'This session has already been settled');

  const state = session.engineState as unknown as OfflineEngineState;
  if (!(state.activePlayerUids || []).includes(userId)) {
    throw new HttpError(409, 'That player is not seated at this table');
  }
  const existing = (state.cashOuts || []).find((c) => c.userId === userId);
  if (existing) {
    throw new HttpError(409, existing.status === 'pending'
      ? 'A cash-out is already awaiting confirmation for that player'
      : 'That player has already cashed out');
  }

  const cashOuts = [...(state.cashOuts || []),
    { userId, amount, status: 'pending' as const, requestedAt: new Date().toISOString() }];
  const row = await prisma.pokerSession.update({
    where: { id: sessionId }, data: { engineState: { ...state, cashOuts } as any } });

  emitToClub(clubId, 'club:cashout-requested', { sessionId, userId, amount });
  return serialize(row as unknown as SessionRow);
}

export async function decideCashOut(
  sessionId: string, clubId: string, requesterId: string, isSuperAdmin: boolean,
  userId: string, approve: boolean
) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubAdmin(club, requesterId, isSuperAdmin);

  const session = await prisma.pokerSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new HttpError(404, 'Session not found');

  const state = session.engineState as unknown as OfflineEngineState;
  const entry = (state.cashOuts || []).find((c) => c.userId === userId && c.status === 'pending');
  if (!entry) throw new HttpError(404, 'No pending cash-out from that player');

  // Same reasoning as decideSitIn: close the window between expiry and sweep.
  if (isRequestExpired(entry.requestedAt)) {
    await prisma.pokerSession.update({
      where: { id: sessionId },
      data: { engineState: clearCashOutFor(state, userId) as any },
    });
    emitToClub(clubId, 'club:cashout-decided', { sessionId, userId, approved: false, expired: true });
    throw new HttpError(409, 'That cash-out request expired before it was confirmed — ask the player to re-count');
  }

  // Rejecting drops the request entirely so the player can re-count and retry.
  const cashOuts = approve
    ? (state.cashOuts || []).map((c) =>
        c.userId === userId ? { ...c, status: 'confirmed' as const, confirmedBy: requesterId } : c)
    : (state.cashOuts || []).filter((c) => c.userId !== userId);

  // A confirmed cash-out frees the seat — they're done playing, but their
  // figures still feed settlement.
  const activePlayerUids = approve
    ? (state.activePlayerUids || []).filter((u) => u !== userId)
    : state.activePlayerUids || [];

  const row = await prisma.pokerSession.update({
    where: { id: sessionId }, data: { engineState: { ...state, cashOuts, activePlayerUids } as any } });

  emitToClub(clubId, 'club:cashout-decided', { sessionId, userId, approved: approve });
  return serialize(row as unknown as SessionRow);
}

export async function requestBuyIn(sessionId: string, clubId: string, userId: string, amount: number) {
  // Enforced here, not only in the UI — the cap was previously client-side
  // only and any direct API call sailed past it.
  await assertWithinBuyInCeiling(sessionId, clubId, amount);

  // One pending buy-in per player per session, matching requestSitIn and
  // requestCashOut. This was the only request endpoint without the rule, and
  // its absence was not theoretical: a player whose screen appeared frozen
  // pressed the button around twenty times and created around twenty rows,
  // every one of which an admin then had to triage.
  //
  // Enforced on the server rather than by disabling the button, because a
  // disabled button only helps a client that is behaving.
  const pending = await prisma.buyInRequest.findFirst({
    where: { sessionId, userId, status: 'pending' },
    select: { id: true },
  });
  if (pending) {
    throw new HttpError(409, 'You already have a buy-in request waiting for approval');
  }

  const request = await prisma.buyInRequest.create({
    data: { sessionId, clubId, userId, amount, status: 'pending', requestedBy: userId },
  });
  emitToClub(clubId, 'club:buyin-requested', { sessionId, requestId: request.id });
  return request;
}

export async function listBuyInRequests(sessionId: string) {
  return prisma.buyInRequest.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
}

export async function decideBuyInRequest(
  sessionId: string,
  requesterId: string,
  isSuperAdmin: boolean,
  requestId: string,
  approve: boolean
) {
  const session = await prisma.pokerSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new HttpError(404, 'Session not found');
  const club = await clubsService.getClubOrThrow(session.clubId);
  clubsService.assertClubAdmin(club, requesterId, isSuperAdmin);

  const req = await prisma.buyInRequest.findUnique({ where: { id: requestId } });
  if (!req || req.sessionId !== sessionId) throw new HttpError(404, 'Buy-in request not found');
  if (req.status !== 'pending') throw new HttpError(409, 'This request has already been decided');

  // Same reasoning as decideSitIn: close the window between expiry and sweep.
  if (isRequestExpired(req.createdAt)) {
    await prisma.buyInRequest.update({
      where: { id: requestId },
      data: { status: 'rejected', approvedBy: null },
    });
    emitToClub(session.clubId, 'club:buyin-decided', {
      sessionId, requestId, userId: req.userId, approve: false, expired: true,
    });
    throw new HttpError(409, 'That buy-in request expired before it was approved');
  }

  if (approve) {
    await assertWithinBuyInCeiling(sessionId, session.clubId, req.amount);
    const isOwner = clubsService.isClubOwner(club, requesterId, isSuperAdmin);
    if (req.requestedBy === requesterId && !isOwner && hasOtherAdmins(club, requesterId)) {
      throw new HttpError(403, 'Another Club Admin must approve your own buy-in request');
    }
  }

  await prisma.buyInRequest.update({
    where: { id: requestId },
    data: { status: approve ? 'approved' : 'rejected', approvedBy: requesterId },
  });

  if (approve) {
    const state = session.engineState as unknown as OfflineEngineState;
    const activePlayerUids = Array.from(new Set([...(state.activePlayerUids || []), req.userId]));
    await prisma.pokerSession.update({
      where: { id: sessionId },
      data: { engineState: { ...state, activePlayerUids } as any },
    });
  }

  emitToClub(session.clubId, 'club:buyin-decided', { sessionId, requestId, approve });

  // Only approvals are messaged, and never awaited — a slow or failing SMS
  // provider must not hold up (or fail) the approval that already committed.
  if (approve) {
    void notificationsService.notifyBuyInApproved({
      userId: req.userId,
      clubId: session.clubId,
      amount: req.amount,
    });
  }

  return getActiveOfflineSession(session.clubId);
}

export interface SettleInput {
  // Buy-in is auto-populated client-side from approved BuyInRequest sums but
  // editable by the admin at settle time (e.g. to correct a data-entry
  // mistake) — the server trusts these submitted figures as authoritative
  // rather than re-deriving them from BuyInRequest itself.
  entries: { userId: string; buyIn: number; cashOut: number; manualWinner?: boolean }[];
  // Required to settle when the club's mismatchStrategy is MANUAL and a
  // mismatch is present — the admin has reconciled it outside the app.
  mismatchAcknowledged?: boolean;
}

export async function settleSession(sessionId: string, requesterId: string, isSuperAdmin: boolean, input: SettleInput) {
  const result = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<SessionRow[]>`
      SELECT id, "clubId", "sessionName", "sessionType", status, "startedById", "createdAt", "endedAt", "engineState"
      FROM "PokerSession" WHERE id = ${sessionId} FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new HttpError(404, 'Session not found');
    if (row.status !== 'active') throw new HttpError(409, 'Session is already settled');

    const club = await tx.club.findUniqueOrThrow({ where: { id: row.clubId }, include: { admins: true } });
    const isAdmin = club.ownerId === requesterId || isSuperAdmin || club.admins.some((a) => a.userId === requesterId);
    if (!isAdmin) throw new HttpError(403, 'Only a Club Admin or Owner can do this');

    const state = row.engineState;
    // Anyone who cashed out early has already left activePlayerUids, but they
    // still played and their figures must settle — otherwise their buy-ins
    // vanish from the totals and every mismatch/rake number comes out wrong.
    const confirmedCashOuts = (state.cashOuts || []).filter((c) => c.status === 'confirmed');
    const activePlayerUids: string[] = Array.from(
      new Set([...(state.activePlayerUids || []), ...confirmedCashOuts.map((c) => c.userId)])
    );
    // Same floor as a back-dated night: two players minimum.
    if (input.entries.length < 2) throw new HttpError(400, 'A session needs at least two players');
    const entryByUid = new Map(input.entries.map((e) => [e.userId, e]));
    // A confirmed early cash-out is the authority on that player's figure — an
    // admin already counted and signed off on it, so it wins over the form.
    const lockedCashOut = new Map(confirmedCashOuts.map((c) => [c.userId, c.amount]));

    const users = await tx.user.findMany({ where: { id: { in: activePlayerUids } }, select: { id: true, displayName: true } });
    const nameByUid = new Map(users.map((u) => [u.id, u.displayName]));

    const settlementSettings: SettlementSettings = {
      sessionRakeAmount: club.sessionRakeAmount,
      winnersCutPercent: club.winnersCutPercent,
      rakeEnabled: club.rakeEnabled,
      rakeMethod: club.rakeMethod as SettlementSettings['rakeMethod'],
      rakeValue: club.rakeValue,
      potEnabled: club.potEnabled,
      mismatchStrategy: club.mismatchStrategy as SettlementSettings['mismatchStrategy'],
      rakeOrder: club.rakeOrder as SettlementSettings['rakeOrder'],
      winnerDefinition: club.winnerDefinition as SettlementSettings['winnerDefinition'],
      winnerTopN: club.winnerTopN,
      roundingRule: club.roundingRule as SettlementSettings['roundingRule'],
    };

    const engineResult = computeSettlement(
      activePlayerUids.map((uid) => {
        const entry = entryByUid.get(uid);
        return {
          userId: uid,
          userDisplayName: nameByUid.get(uid) || 'Player',
          buyIn: Number(entry?.buyIn || 0),
          cashOut: lockedCashOut.has(uid) ? lockedCashOut.get(uid)! : Number(entry?.cashOut || 0),
          manualWinner: entry?.manualWinner,
        };
      }),
      settlementSettings,
      { currentPotBalance: club.clubPotBalance, mismatchAcknowledged: input.mismatchAcknowledged }
    );

    if (engineResult.requiresManualResolution) {
      throw new HttpError(409, 'This club requires manual mismatch resolution — acknowledge it before settling.');
    }

    // Shaped to match the existing PlayerSessionSummary/CashOutSettlement
    // columns so History/Leaderboard keep working unchanged: `excessDeduction`
    // now carries whatever the configured mismatch strategy deducted (not
    // only the old "proportional excess" case), and `winnersCutDeduction`
    // carries whatever the configured rake method deducted.
    const summaries = engineResult.players.map((p) => ({
      userId: p.userId,
      userDisplayName: p.userDisplayName,
      totalBuyIn: p.totalBuyIn,
      cashOut: p.cashOut,
      grossProfit: p.grossProfit,
      excessDeduction: p.mismatchDeduction,
      winnersCutDeduction: p.rakeDeduction,
      netResult: p.netResult,
    }));

    const sessionTypeLabel = row.sessionType === 'LAZY_DEALER' ? 'Lazy Dealer Session' : 'Offline Session';

    const settlement = await tx.cashOutSettlement.create({
      data: {
        clubId: row.clubId,
        sessionId,
        sessionType: sessionTypeLabel,
        settledBy: requesterId,
        totalBuyIns: engineResult.totalBuyIns,
        totalCashOuts: engineResult.totalCashOuts,
        totalWinnersCut: 0, // superseded by totalRakeCollected — kept 0 for schema/history compatibility
        rakeCollected: engineResult.totalRakeCollected,
        potAdjustment: engineResult.potContribution,
        playerSummaries: summaries as any,
      },
    });

    // Settling creates money records, so it leaves a trace like every edit,
    // deletion and restore already does.
    //
    // Written inside the settlement transaction, and deliberately as early
    // as the settlement row exists rather than at the end: every later step
    // (session close, pot movement) can still fail, and placing the audit
    // after them would mean a failure there rolled back a settlement whose
    // audit was never even attempted. Here, any failure in this transaction
    // takes the settlement and its record down together. The status guard
    // above means a session can only ever be settled once, so there can
    // never be a second row for the same session.
    //
    // Keyed on the settlement's own id — the same id applySessionChange
    // audits against — so a record's whole life (settled → edited → deleted
    // → restored) shares one sessionId in the audit trail.
    const actor = await tx.user.findUnique({ where: { id: requesterId }, select: { displayName: true } });
    await tx.auditLog.create({
      data: {
        clubId: row.clubId,
        sessionId: settlement.id,
        sessionTitle: row.sessionName,
        action: 'settle_session',
        changedBy: requesterId,
        changedByName: actor?.displayName ?? 'Unknown',
        details:
          `Settled ${row.sessionName} for ${summaries.length} player(s): ` +
          `${engineResult.totalBuyIns} in / ${engineResult.totalCashOuts} out, ` +
          `house take ${engineResult.totalRakeCollected}, pot ${engineResult.potContribution >= 0 ? '+' : ''}${engineResult.potContribution}.`,
        changes: {
          // Immutable provenance. Which engine produced these numbers, and
          // which shape this record is in, cannot be reconstructed later —
          // when the engine changes, an old record must still say what
          // decided it, or a historical dispute is indistinguishable from a
          // release that changed behaviour.
          meta: {
            auditSchemaVersion: AUDIT_SCHEMA_VERSION,
            settlementEngineVersion: SETTLEMENT_ENGINE_VERSION,
            createdFrom: 'settleSession',
          },
          totalBuyIns: engineResult.totalBuyIns,
          totalCashOuts: engineResult.totalCashOuts,
          mismatchAmount: engineResult.mismatchAmount,
          totalRakeCollected: engineResult.totalRakeCollected,
          potContribution: engineResult.potContribution,
          players: summaries.map((s) => ({
            userId: s.userId,
            userDisplayName: s.userDisplayName,
            totalBuyIn: s.totalBuyIn,
            cashOut: s.cashOut,
            netResult: s.netResult,
          })),
        } as any,
      },
    });

    await tx.pokerSession.update({ where: { id: sessionId }, data: { status: 'settled', endedAt: new Date() } });

    if (club.potEnabled && engineResult.potContribution !== 0) {
      if (engineResult.totalRakeCollected > 0) {
        await tx.clubPotLog.create({
          data: {
            clubId: row.clubId,
            sessionId,
            amount: engineResult.totalRakeCollected,
            source: 'fixed_rake',
            note: `Rake (${club.rakeMethod}) from ${row.sessionName}`,
          },
        });
      }
      const mismatchPotEffect = engineResult.potContribution - engineResult.totalRakeCollected;
      if (mismatchPotEffect > 0) {
        await tx.clubPotLog.create({
          data: { clubId: row.clubId, sessionId, amount: mismatchPotEffect, source: 'buyin_leftover', note: `Mismatch surplus from ${row.sessionName}` },
        });
      } else if (mismatchPotEffect < 0) {
        await tx.clubPotLog.create({
          data: { clubId: row.clubId, sessionId, amount: mismatchPotEffect, source: 'manual_adjustment', note: `Mismatch covered from Club Pot for ${row.sessionName}` },
        });
      }
      await tx.club.update({ where: { id: row.clubId }, data: { clubPotBalance: { increment: engineResult.potContribution } } });
    }

    return { clubId: row.clubId, settlement, sessionName: row.sessionName, summaries };
  });

  emitToClub(result.clubId, 'club:session-settled', { sessionId });

  // Sent only after the settlement transaction has committed, and never
  // awaited — each player is told their own result and their own running
  // total, never anyone else's.
  void notificationsService.notifySessionSettled({
    clubId: result.clubId,
    sessionName: result.sessionName,
    summaries: result.summaries,
  });

  return result.settlement;
}
