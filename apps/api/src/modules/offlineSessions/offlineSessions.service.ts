import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { emitToClub } from '../../realtime/socket.js';
import * as clubsService from '../clubs/clubs.service.js';
import * as notificationsService from '../notifications/notifications.service.js';
import { computeSettlement, SettlementSettings, SETTLEMENT_ENGINE_VERSION } from './settlementEngine.js';
import { buildCanonicalInputs, canonicalOutputsFrom } from './canonicalSettlement.js';
import { AUDIT_SCHEMA_VERSION } from '../clubRecords/auditMeta.js';

// Offline and Lazy Dealer sessions don't run the automated poker engine —
// they're a lightweight buy-in/cash-out wrapper (the same one the Firestore
// version used for both types) so engineState only ever needs a handful of
// config fields plus the running list of who's bought into the table.
interface OfflineEngineState {
  /**
   * When the host said "alright, let's start" — and null while the table is
   * open but the night has not begun.
   *
   * A poker night does not start when the table is created; it starts when
   * everyone is seated, has chips, and the first hand is dealt. Before this,
   * the session exists and people are gathering: that is the lobby.
   *
   * The ABSENCE of this key is what marks a session created before any of this
   * existed. Those are already being played, so they are read as started —
   * without that distinction, every live game in flight would have snapped back
   * to "Preparing table" the moment this shipped.
   */
  startedPlayingAt?: string | null;
  /**
   * Minutes the host originally set aside. Absent means no limit.
   *
   * The PLAN, not the running total — extensions are kept beside it so the
   * night's story can say "started with a 2-hour timer" and "extended by 30
   * minutes" rather than silently showing a bigger number.
   */
  durationMinutes?: number;
  /** Every extension, in the order granted. Additive and unlimited by design. */
  timeExtensions?: { minutes: number; at: string }[];
  /**
   * When the host started settling, and the table stopped moving.
   *
   * Figures cannot be agreed while they are still changing underneath. From
   * here nothing mutates — no buy-ins, no cash-outs, no approvals — until the
   * night settles or the host hands the table back. Reversible on purpose: a
   * mis-tap must not hold a room hostage.
   */
  settlingAt?: string | null;
  /**
   * When the host chose to carry on with no limit.
   *
   * One-way for the rest of the night. It is what stops a game running three
   * hours over from opening a grace period every five minutes.
   */
  timeLimitLiftedAt?: string | null;
  /**
   * Whether to say anything when the clock runs out.
   *
   * The clock never ends a night by itself — poker nights run over, and a timer
   * that settled the game would be dictating rather than informing. This only
   * decides whether the host is told.
   */
  remindAtEnd?: boolean;
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
  /**
   * The rules this night plays by, fixed the moment it starts.
   *
   * Settlement used to read these off the Club at the moment somebody pressed
   * Confirm, which meant a settings change at 11pm silently restated the
   * economics of a game running since eight — chips bought under a house take
   * of nothing, raked at whatever the club said last. Nobody at the table is
   * told, and afterwards nothing in the database shows the rules moved.
   *
   * IMMUTABLE_CLUB_RULES exists because of that hole rather than instead of it:
   * the rules were frozen at club creation because there was nowhere safe to
   * put a change. With the night holding its own copy, there is somewhere.
   *
   * Everything here is a RULE. Deliberately absent: clubPotBalance, which is a
   * live balance the pot-funded mismatch strategies must read as it stands at
   * settlement rather than at kick-off; and ownership/admin lists, which are
   * authorisation and must always be current.
   *
   * Absent on a session that started before this shipped — settlementRulesFor
   * says what happens then rather than guessing.
   */
  settlementRules?: {
    /** When it was taken, so a record can show the night carried its own. */
    capturedAt: string;
    sessionRakeAmount: number;
    winnersCutPercent: number;
    /** Deprecated at the club, still passed to the engine — captured for parity. */
    rakeEnabled: boolean;
    rakeMethod: string;
    rakeValue: number;
    potEnabled: boolean;
    mismatchStrategy: string;
    rakeOrder: string;
    winnerDefinition: string;
    winnerTopN: number;
    roundingRule: string;
  };
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

/**
 * The only safe way to rewrite engineState.
 *
 * engineState is one JSON column holding the whole table — who is seated, who
 * has asked for a chair, who has counted their chips. Every writer reads the
 * blob, changes one field and writes the whole thing back, which is a lost
 * update waiting for two people to press a button at once. It does not need a
 * busy club to happen: a host and a co-host looking at the same queue on their
 * own phones, both tapping Approve within a quarter of a second, is a Friday.
 *
 * What that cost, measured rather than imagined: Rahul approved, charged for
 * his chips, told he was in — and holding no seat, because the write that
 * seated Priya was built from a snapshot taken before his landed and put back a
 * list he had never been in. Nothing surfaces. Both admins see the row vanish,
 * both believe they did it, and the table is quietly missing a player.
 *
 * So every mutation takes a row lock on the session first and reads the state
 * fresh inside it. Concurrent callers queue rather than race, which is the same
 * shape settleSession already uses for the same reason.
 *
 * Side effects belong OUTSIDE: this returns what to emit rather than emitting,
 * because a socket event sent from inside a transaction is a lie until it
 * commits, and a rollback cannot take it back.
 */
async function mutateSessionState<T>(
  sessionId: string,
  mutate: (
    state: OfflineEngineState,
    tx: Prisma.TransactionClient,
    row: SessionRow
  ) => Promise<{ state: OfflineEngineState; result: T }>
): Promise<{ session: ReturnType<typeof serialize>; result: T }> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<SessionRow[]>`
      SELECT id, "clubId", "sessionName", "sessionType", status, "startedById",
             "createdAt", "endedAt", "engineState"
      FROM "PokerSession" WHERE id = ${sessionId} FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new HttpError(404, 'Session not found');

    const { state, result } = await mutate(row.engineState, tx, row);
    const updated = await tx.pokerSession.update({
      where: { id: sessionId },
      data: { engineState: state as any },
    });
    return { session: serialize(updated as unknown as SessionRow), result };
  });
}

/**
 * THE SESSION LIFECYCLE, stated once instead of implied in nineteen places.
 *
 *     lobby ──startPlaying──▶ playing ──beginSettling──▶ settling
 *                               │  ▲                        │
 *                               │  └──── resumeNight ────────┘
 *                               │                            │
 *                               └────── settleSession ───────┴──▶ settled
 *
 * Four phases and five transitions. Everything else is illegal, and illegal by
 * construction rather than by review: every mutation declares the phases it is
 * legal in, and `assertPhase` is the only thing that decides. Adding an endpoint
 * without naming its phases does not compile.
 *
 * THE CLOCK IS NOT IN HERE, deliberately. Running, grace and complete are states
 * of a timer, not of a session: nothing is locked in any of them, players buy in
 * and stand up throughout, and the only thing that changes is what the screen
 * says. Folding them into this diagram would suggest the grace period restricts
 * something. It restricts nothing.
 *
 * `settled` is terminal. There is no transition out of it, which is the whole
 * point of a receipt.
 */
export type SessionPhase = 'lobby' | 'playing' | 'settling' | 'settled';

export function sessionPhase(status: string, state: OfflineEngineState): SessionPhase {
  if (status !== 'active') return 'settled';
  if (state.settlingAt) return 'settling';
  // `undefined` is a session created before the lobby existed. Those are being
  // played right now — see the note on startedPlayingAt.
  if (state.startedPlayingAt === null) return 'lobby';
  return 'playing';
}

const PHASE_REFUSAL: Record<SessionPhase, string> = {
  lobby: 'The night has not started yet',
  playing: 'The night is still being played',
  settling: 'This night is being settled — resume it to make changes',
  settled: 'This night has already been settled',
};

/**
 * The one gate. Refuses with the reason the CURRENT phase gives, not with a
 * generic "cannot do that" — a host who is told "resume it to make changes"
 * knows what to press next.
 */
function assertPhase(
  row: SessionRow,
  state: OfflineEngineState,
  allowed: SessionPhase[]
) {
  const phase = sessionPhase(row.status, state);
  if (!allowed.includes(phase)) throw new HttpError(409, PHASE_REFUSAL[phase]);
  return phase;
}

/** Every settlement rule the club holds, in the shape the night keeps it. */
type SettlementRules = NonNullable<OfflineEngineState['settlementRules']>;

/**
 * The club's rules, as of now.
 *
 * The field list is not a judgement call — it is exactly what settleSession
 * feeds computeSettlement, plus the two it reads again afterwards when writing
 * the pot ledger. Anything the engine consumes belongs here; anything live
 * (clubPotBalance) or authorising (ownerId, admins) does not.
 */
function captureSettlementRules(club: {
  sessionRakeAmount: number; winnersCutPercent: number; rakeEnabled: boolean;
  rakeMethod: string; rakeValue: number; potEnabled: boolean;
  mismatchStrategy: string; rakeOrder: string; winnerDefinition: string;
  winnerTopN: number; roundingRule: string;
}): SettlementRules {
  return {
    capturedAt: new Date().toISOString(),
    sessionRakeAmount: club.sessionRakeAmount,
    winnersCutPercent: club.winnersCutPercent,
    rakeEnabled: club.rakeEnabled,
    rakeMethod: club.rakeMethod,
    rakeValue: club.rakeValue,
    potEnabled: club.potEnabled,
    mismatchStrategy: club.mismatchStrategy,
    rakeOrder: club.rakeOrder,
    winnerDefinition: club.winnerDefinition,
    winnerTopN: club.winnerTopN,
    roundingRule: club.roundingRule,
  };
}

/**
 * Which rules settle this night.
 *
 * A night settles by its own snapshot or it does not settle. There is no
 * fallback to the club, deliberately: falling back is the original fault
 * wearing a different hat — a night with no rules of its own would go on
 * settling at whatever the club says at the moment somebody presses Confirm,
 * which is exactly the silent restatement this whole mechanism exists to stop.
 *
 * Nights that started before snapshots existed therefore have to be told what
 * they are playing for, once, by a human — see initSettlementRules. Refusing
 * costs a host one deliberate action at the end of one night. Guessing costs
 * players money under rules nobody agreed to, and nothing in the record would
 * show it happened.
 *
 * The refusal names the next step rather than stating a fact, because a host
 * hitting this at 2am needs to know what to press.
 */
function settlementRulesFor(state: OfflineEngineState): SettlementRules {
  if (!state.settlementRules) {
    throw new HttpError(
      409,
      'This night started before settlement rules were recorded against a session. ' +
        'Set its rake and winners\' cut before settling — they cannot be guessed from the club, ' +
        'because the club may have changed since the night began.'
    );
  }
  return state.settlementRules;
}

/**
 * Is there anybody else HERE who could approve this?
 *
 * The rule this serves is "nobody gives themselves chips", and its escape hatch
 * is being alone — because an admin who cannot approve their own request and
 * has nobody to ask is an admin whose game has stopped.
 *
 * "Alone" has to mean alone AT THE TABLE, not alone on the club roster. Asking
 * the roster gets the owner-goes-home case exactly backwards: the owner opens
 * the night, plays an hour, cashes out and drives home, and the one admin still
 * dealing cards is refused their own rebuy because an admin exists — asleep,
 * eleven miles away, and the only person who could unblock them. The rule
 * written to stop a night being blocked becomes the thing blocking it.
 *
 * So presence, from the state under the lock: seated, or waiting on a seat.
 * Somebody whose cash-out has been confirmed is deliberately NOT counted —
 * standing up is what leaving looks like in this app, and treating a player who
 * has gone as an available approver is the same deadlock in a different hat.
 *
 * The owner has no special status here or anywhere else in a session. Every
 * session action is assertClubAdmin; owner-only powers are club-level things
 * like deleting the club or transferring it.
 *
 * Residual, and worth naming: an admin who abandons a seat without standing up
 * still counts as present, because nothing in the data distinguishes them from
 * somebody who has stepped outside for a cigarette. Standing up is the fix, and
 * it is what people do when they leave.
 */
function hasAnotherAdminHere(
  club: { ownerId: string; admins: { userId: string }[] },
  excludeUserId: string,
  state: OfflineEngineState
) {
  const everyAdmin = new Set([club.ownerId, ...club.admins.map((a) => a.userId)]);
  everyAdmin.delete(excludeUserId);
  if (everyAdmin.size === 0) return false;

  const gone = new Set(
    (state.cashOuts || []).filter((c) => c.status === 'confirmed').map((c) => c.userId)
  );
  const here = [...(state.activePlayerUids || []), ...(state.pendingSitInUids || [])].filter(
    (uid) => !gone.has(uid)
  );
  return here.some((uid) => everyAdmin.has(uid));
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

/*
 * A request waits until somebody decides it.
 *
 * There was a five-minute deadline here: an interval swept un-actioned
 * buy-ins, sit-ins and cash-outs into 'rejected', and each decide path
 * re-checked the same deadline to close the gap between a request expiring and
 * being swept.
 *
 * It was the wrong model for the room. A host puts the phone down to deal, or
 * counts a stack, or argues about a hand — and comes back to a queue that has
 * quietly rejected somebody's buy-in on their behalf. The player is told no by
 * a timer nobody set, and the only trace is a rejected row nobody wrote.
 * Requests are not perishable; the answer is just sometimes slow.
 *
 * So a pending request now lives until it is decided. Approving it, rejecting
 * it, or the night ending are the only things that take one out of the queue.
 *
 * Club join requests and edit-approval requests never expired even under the
 * old rule, for the same reason applied to a longer timescale.
 */

export interface StartSessionInput {
  sessionType: 'OFFLINE' | 'LAZY_DEALER';
  sessionName: string;
  /** Minutes the host set aside. Absent means no limit. */
  durationMinutes?: number;
  /** Whether to say anything when the clock runs out. It never ends the night. */
  remindAtEnd?: boolean;
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
    // Explicitly null rather than omitted: the key's presence is what tells a
    // new session apart from one that predates the lobby.
    startedPlayingAt: null,
    durationMinutes: input.durationMinutes,
    remindAtEnd: input.remindAtEnd,
    // The host is in the room from the moment they open the table — but with no
    // chips, so the lobby reads them as waiting for a buy-in like everyone else.
    // Opening a table is not sitting down at it.
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
  emitToClub(clubId, 'club:session-started', {
    sessionId: row.id, sessionType: input.sessionType, session: serialized,
  });
  return serialized;
}

// Lets a player mark themselves "at the table" before they've requested a
// bank yet — mirrors the original app's plain join-table action, separate
// from requesting/approving an actual buy-in.
export async function joinSession(sessionId: string, userId: string) {
  const { session } = await mutateSessionState(sessionId, async (state, _tx, row) => {
    assertPhase(row, state, ['lobby', 'playing']);
    const cleared = clearCashOutFor(state, userId);
    const activePlayerUids = Array.from(new Set([...(cleared.activePlayerUids || []), userId]));
    return { state: { ...cleared, activePlayerUids }, result: null };
  });
  return session;
}

/**
 * A member who isn't seated yet asks to be dealt in, or an admin asks on their
 * behalf. Admins already at the table approve it either way — self-seating
 * stays available via joinSession for the admin who started the session.
 *
 * TWO CALLERS, ONE REQUEST. `targetUserId` defaults to the requester, so the
 * self path is unchanged: same call, same state, same event.
 *
 * The admin path exists because the sheet already offered it and could not do
 * it. An admin opening the sheet of somebody who had stood up saw "Sit back
 * down", pressed it, and asked for a seat FOR THEMSELVES — the player's id was
 * never sent. An admin already at the table (the normal case) got
 * "You are already seated at this table" for pressing a button about somebody
 * else, and the player stayed standing with no way back except their own phone.
 *
 * WHO IS ALLOWED IS DECIDED FROM THE TOKEN, NEVER FROM THE BODY. The body says
 * who is being seated; `requesterId` comes from the authenticated session and is
 * the only thing consulted for permission. Acting for somebody else is an admin
 * capability, so it is checked against the club — matching decideSitIn, which
 * already guards the other half of this exchange.
 */
export async function requestSitIn(
  sessionId: string,
  clubId: string,
  requesterId: string,
  // Both default, so `requestSitIn(sessionId, clubId, userId)` still compiles
  // and still means exactly what it did: that person, asking for themselves.
  // `isSuperAdmin` is only ever read on the on-behalf path, which cannot be
  // reached without passing the fifth argument — so the default cannot grant
  // anything, only withhold it.
  isSuperAdmin: boolean = false,
  targetUserId: string = requesterId
) {
  const onBehalf = targetUserId !== requesterId;

  if (onBehalf) {
    const club = await clubsService.getClubOrThrow(clubId);
    clubsService.assertClubAdmin(club, requesterId, isSuperAdmin);
  }

  const { session } = await mutateSessionState(sessionId, async (state, tx, row) => {
    assertPhase(row, state, ['lobby', 'playing']);

    if ((state.activePlayerUids || []).includes(targetUserId)) {
      throw new HttpError(
        409,
        onBehalf ? 'That player is already seated at this table' : 'You are already seated at this table'
      );
    }

    /*
     * One pending request per person.
     *
     * The old code deduplicated silently with a Set, so pressing twice returned
     * 201 and changed nothing. That is defensible for one person tapping their
     * own phone and wrong the moment two admins can ask for the same player:
     * both are told it worked, and the timestamp below quietly becomes the
     * second one's. Saying so costs nothing and is the same answer
     * decideBuyInRequest gives for the same situation.
     */
    if ((state.pendingSitInUids || []).includes(targetUserId)) {
      throw new HttpError(
        409,
        onBehalf ? 'That player has already asked for a seat' : 'You have already asked for a seat'
      );
    }

    /*
     * Only somebody who is actually part of tonight.
     *
     * Checked for the admin path specifically. A self-request is how a member
     * joins a night they were never in, which is the feature — but an admin
     * naming an arbitrary id must name somebody the night already knows, or
     * this becomes a way to seat any club member from a request they never
     * made. The two ways to belong are having stood up (there are chips to
     * carry back) and having banked (they are playing).
     *
     * decideSitIn's own guard still applies afterwards: it refuses to seat
     * anyone who is not in pendingSitInUids, so nothing here bypasses it.
     */
    if (onBehalf) {
      const stoodUp = (state.cashOuts || []).some(
        (c) => c.userId === targetUserId && c.status === 'confirmed'
      );
      if (!stoodUp) {
        const banked = await tx.buyInRequest.count({
          where: { sessionId, userId: targetUserId, status: 'approved' },
        });
        if (banked === 0) throw new HttpError(404, 'That player is not part of this night');
      }
    }

    // The Set is redundant now the guard above refuses duplicates, and kept
    // anyway: it costs nothing and the invariant is worth two defences.
    const pendingSitInUids = Array.from(new Set([...(state.pendingSitInUids || []), targetUserId]));
    const sitInRequestedAt = {
      ...(state.sitInRequestedAt || {}),
      [targetUserId]: new Date().toISOString(),
    };
    return { state: { ...state, pendingSitInUids, sitInRequestedAt }, result: null };
  });

  // The person being seated, not the person who asked — the queue and the felt
  // both key off this, and sending the requester put an admin's own face on a
  // row about somebody else.
  emitToClub(clubId, 'club:sitin-requested', { sessionId, userId: targetUserId, session });
  return session;
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


  const { session } = await mutateSessionState(sessionId, async (state, _tx, row) => {
    assertPhase(row, state, ['lobby', 'playing']);

    // Only ever act on someone who actually asked — otherwise an approve call
    // could seat an arbitrary user id that never requested a seat.
    if (!(state.pendingSitInUids || []).includes(userId)) {
      throw new HttpError(404, 'No pending sit-in request from that player');
    }

    const pendingSitInUids = (state.pendingSitInUids || []).filter((u) => u !== userId);
    const sitInRequestedAt = { ...(state.sitInRequestedAt || {}) };
    delete sitInRequestedAt[userId];

    // Only an approval seats them, so only an approval voids an earlier cash-out.
    const nextState = approve ? clearCashOutFor(state, userId) : state;
    const activePlayerUids = approve
      ? Array.from(new Set([...(state.activePlayerUids || []), userId]))
      : state.activePlayerUids || [];

    return {
      state: { ...nextState, activePlayerUids, pendingSitInUids, sitInRequestedAt },
      result: null,
    };
  });


  emitToClub(clubId, 'club:sitin-decided', { sessionId, userId, approved: approve, session });
  return session;
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
export async function getBuyInCeiling(
  sessionId: string,
  clubId: string,
  // Reads inside a transaction must use that transaction's connection, or they
  // see a snapshot from before the lock was taken — which for the ceiling means
  // approving two big buy-ins at once can put the table over its own maximum.
  db: Prisma.TransactionClient | typeof prisma = prisma
): Promise<number | null> {
  const club = await db.club.findUnique({
    where: { id: clubId },
    select: { buyInMode: true, maxBuyIn: true },
  });
  if (!club || club.buyInMode === 'UNCAPPED') return null;

  const approved = await db.buyInRequest.findMany({
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

async function assertWithinBuyInCeiling(
  sessionId: string, clubId: string, amount: number,
  db: Prisma.TransactionClient | typeof prisma = prisma
) {
  const ceiling = await getBuyInCeiling(sessionId, clubId, db);
  if (ceiling !== null && amount > ceiling) {
    throw new HttpError(400, `Buy-in of ${amount} exceeds the current table maximum of ${ceiling}`);
  }
}


// A player leaving before the night ends: they count their chips, an admin
// confirms, and the figure is locked in for settlement. Kept on engineState
// rather than its own table since it dies with the session.
/**
 * "Alright, let's start."
 *
 * The one moment the app cannot infer. Everything else about a night is
 * derivable from its buy-ins and cash-outs, but whether the first hand has been
 * dealt is a fact about the room — so the host says it, once, and it is written
 * down.
 *
 * Two ready players is the only gate. Not everyone, deliberately: somebody is
 * always still parking, and a night that cannot begin until the last arrival
 * has bought in is a night the app is holding up.
 */
export async function startPlaying(
  sessionId: string, clubId: string, requesterId: string, isSuperAdmin: boolean
) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubAdmin(club, requesterId, isSuperAdmin);

  const { session, result: startedPlayingAt } = await mutateSessionState(
    sessionId,
    async (state, tx, row) => {
      assertPhase(row, state, ['lobby']);
      // Under the lock, so two hosts tapping together cannot both start a night
      // and stamp it with two different times.
      if (state.startedPlayingAt) throw new HttpError(409, 'This night has already started');

      // Ready means seated AND holding chips. Somebody with an approved buy-in
      // is ready whatever else is outstanding; somebody still waiting on
      // approval is not, which is exactly what the lobby shows them as.
      const approved = await tx.buyInRequest.findMany({
        where: { sessionId, status: 'approved' },
        select: { userId: true },
      });
      const seated = new Set(state.activePlayerUids || []);
      const ready = new Set(approved.map((r) => r.userId).filter((u) => seated.has(u)));
      if (ready.size < 2) {
        throw new HttpError(409, 'A night needs at least two players with chips before it can start');
      }

      const at = new Date().toISOString();
      /*
       * The night takes its rules with it, here and nowhere else.
       *
       * This is the moment the economics become real: from here chips are
       * bought under a known house take, and a club settings change afterwards
       * must not reach back and restate them. Taken under the same lock that
       * stamps startedPlayingAt, so a night can never exist in a state where it
       * has started but has no rules.
       *
       * Not taken at startSession: a table can sit open for an hour before
       * anybody plays, and the rules that matter are the ones in force when the
       * first hand is dealt.
       */
      return {
        state: { ...state, startedPlayingAt: at, settlementRules: captureSettlementRules(club) },
        result: at,
      };
    }
  );

  emitToClub(clubId, 'club:session-started-playing', { sessionId, startedPlayingAt, session });
  return session;
}

/**
 * More time on the clock.
 *
 * The scheduled duration is a plan, and extending it is the host saying the
 * plan changed — which at a poker table it always does. Additive, and
 * deliberately unlimited: a rule capping extensions would be the app deciding
 * when somebody else's evening ends.
 *
 * Stored as a list rather than folded into durationMinutes so the night's story
 * can name each one. The clock reads the sum.
 */
export async function extendSession(
  sessionId: string, clubId: string, requesterId: string, isSuperAdmin: boolean, minutes: number
) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubAdmin(club, requesterId, isSuperAdmin);

  const { session } = await mutateSessionState(sessionId, async (state, _tx, row) => {
    assertPhase(row, state, ['playing']);
    if (!state.durationMinutes) throw new HttpError(409, 'This night has no time limit to extend');
    if (state.timeLimitLiftedAt) {
      throw new HttpError(409, 'This night is already running without a time limit');
    }

    /*
     * One extension per grace period.
     *
     * Two admins looking at the same grace banner both tap Extend: one adds
     * thirty minutes, the other adds an hour, and the night quietly gains an
     * hour and a half that nobody chose. The first accepted extension puts the
     * clock back into play, and a clock that is running has nothing to rescue.
     *
     * So an extension is only accepted when the scheduled time has actually run
     * out. Adding more time to a night that is still counting down is not a
     * rescue, it is a second opinion — and if the host wants a longer night than
     * they planned, the grace period is five minutes away.
     */
    const scheduled =
      state.durationMinutes +
      (state.timeExtensions || []).reduce((sum, e) => sum + e.minutes, 0);
    const endsAt = Date.parse(state.startedPlayingAt!) + scheduled * 60_000;
    if (Date.now() < endsAt) {
      throw new HttpError(409, 'The night is still running — there is nothing to extend yet');
    }

    const timeExtensions = [
      ...(state.timeExtensions || []),
      { minutes, at: new Date().toISOString() },
    ];
    return { state: { ...state, timeExtensions }, result: null };
  });

  emitToClub(clubId, 'club:session-extended', { sessionId, minutes, session });
  return session;
}

/**
 * Carry on with no limit for the rest of the night.
 *
 * One-way, and that is the whole value of it: without this a night that ran
 * long would reach the end of its grace period, be extended by thirty minutes,
 * and do the same thing again an hour later. The host says once that the plan
 * is over, and the clock stops asking.
 */
export async function liftTimeLimit(
  sessionId: string, clubId: string, requesterId: string, isSuperAdmin: boolean
) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubAdmin(club, requesterId, isSuperAdmin);

  const { session } = await mutateSessionState(sessionId, async (state, _tx, row) => {
    assertPhase(row, state, ['playing']);
    if (state.timeLimitLiftedAt) return { state, result: null };
    return { state: { ...state, timeLimitLiftedAt: new Date().toISOString() }, result: null };
  });

  emitToClub(clubId, 'club:session-time-limit-lifted', { sessionId, session });
  return session;
}

/**
 * Correcting a count that was already agreed.
 *
 * The host reads 7,400 off a stack, approves it, and finds the last 200 chip
 * under a card thirty seconds later. Before this there was nothing to be done
 * about it: no pending cash-out existed to re-decide, requestCashOut refuses a
 * second entry, and settlement treats a confirmed figure as the authority over
 * the form — so a miscount was permanent from the moment it was agreed.
 *
 * Bounded by settlement, which is the natural edge. Once the night's figures are
 * agreed they are a receipt, and a receipt that can be edited is not one.
 *
 * Carries the same second-pair-of-eyes rule as confirming it did, and for the
 * same reason: this moves money, and an admin editing their own figure with
 * nobody watching is exactly what that rule exists to prevent.
 */
export async function amendCashOut(
  sessionId: string, clubId: string, requesterId: string, isSuperAdmin: boolean,
  userId: string, amount: number
) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubAdmin(club, requesterId, isSuperAdmin);

  const { session } = await mutateSessionState(sessionId, async (state, _tx, row) => {
    assertPhase(row, state, ['lobby', 'playing']);

    const entry = (state.cashOuts || []).find(
      (c) => c.userId === userId && c.status === 'confirmed'
    );
    if (!entry) throw new HttpError(404, 'That player has no confirmed cash-out to correct');

    if (userId === requesterId && hasAnotherAdminHere(club, requesterId, state)) {
      throw new HttpError(403, 'Another Club Admin must correct your own count');
    }

    // The correction is recorded, not silent. A figure that changed after it was
    // agreed is exactly the kind of thing an audit trail exists for.
    const cashOuts = (state.cashOuts || []).map((c) =>
      c.userId === userId && c.status === 'confirmed'
        ? { ...c, amount, amendedBy: requesterId, amendedAt: new Date().toISOString() }
        : c
    );
    return { state: { ...state, cashOuts }, result: null };
  });

  emitToClub(clubId, 'club:cashout-amended', { sessionId, userId, amount, session });
  return session;
}

/**
 * Stop the table so the figures can be agreed.
 *
 * Settlement is a conversation about a set of numbers, and it cannot happen
 * while somebody is still buying chips. From here every mutation refuses until
 * the night settles or the host hands the table back.
 *
 * Reversible, and that is not a detail: a host who taps this by accident at
 * eleven o'clock has to be able to give the table back, or the app has ended
 * somebody's evening on a mis-tap.
 */
/**
 * Taking somebody out of the lobby who is not coming.
 *
 * Rahul says he's in, gets marked ready, and then goes home without pressing
 * anything. Nothing else removes him: he is seated on the server, so the ready
 * count includes him and "4 of 6 ready" is describing a room that has five
 * people in it. The host needs a way to say he left.
 *
 * REFUSES ANYONE HOLDING CHIPS, and that is the load-bearing part. Somebody with
 * an approved buy-in has money in the night; making them vanish would delete it
 * from the ledger with no cash-out and no record. That is standing up, not being
 * removed, and it goes through the count like everybody else's.
 *
 * Their pending requests go with them — a request from somebody who has left is
 * a question with nobody to answer for it.
 */
export async function removeFromLobby(
  sessionId: string, clubId: string, requesterId: string, isSuperAdmin: boolean, userId: string
) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubAdmin(club, requesterId, isSuperAdmin);

  const { session } = await mutateSessionState(sessionId, async (state, tx, row) => {
    assertPhase(row, state, ['lobby']);

    const banked = await tx.buyInRequest.aggregate({
      where: { sessionId, userId, status: 'approved' },
      _sum: { amount: true },
    });
    if ((banked._sum.amount ?? 0) > 0) {
      throw new HttpError(
        409,
        'That player already has chips — they need to stand up and be counted out'
      );
    }

    const seated = (state.activePlayerUids || []).includes(userId);
    const waiting = (state.pendingSitInUids || []).includes(userId);
    const pending = await tx.buyInRequest.count({
      where: { sessionId, userId, status: 'pending' },
    });
    if (!seated && !waiting && pending === 0) {
      throw new HttpError(404, 'That player is not in this lobby');
    }

    // A question with nobody left to answer for it.
    await tx.buyInRequest.updateMany({
      where: { sessionId, userId, status: 'pending' },
      data: { status: 'rejected', approvedBy: requesterId },
    });

    const sitInRequestedAt = { ...(state.sitInRequestedAt || {}) };
    delete sitInRequestedAt[userId];

    return {
      state: {
        ...state,
        activePlayerUids: (state.activePlayerUids || []).filter((u) => u !== userId),
        pendingSitInUids: (state.pendingSitInUids || []).filter((u) => u !== userId),
        sitInRequestedAt,
      },
      result: null,
    };
  });

  emitToClub(clubId, 'club:lobby-player-removed', { sessionId, userId, session });
  return session;
}

export async function beginSettling(
  sessionId: string, clubId: string, requesterId: string, isSuperAdmin: boolean
) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubAdmin(club, requesterId, isSuperAdmin);

  const { session } = await mutateSessionState(sessionId, async (state, tx, row) => {
    assertPhase(row, state, ['playing']);

    /*
     * Settlement cannot begin on unresolved money.
     *
     * Freezing the table with a request still in the queue freezes the QUESTION
     * too: the chips are neither in the night nor out of it, and there is no
     * good answer left. Auto-rejecting would decide somebody's buy-in for them
     * without telling them; auto-approving would create money on the way into
     * the ledger; leaving it pending means settling figures with an open
     * question sitting on top of them.
     *
     * So the host clears the queue first. That is one extra tap on a screen
     * where the queue is already the thing above the table.
     */
    const pendingBuyIns = await tx.buyInRequest.count({
      where: { sessionId, status: 'pending' },
    });
    const pendingSitIns = (state.pendingSitInUids || []).length;
    const pendingCashOuts = (state.cashOuts || []).filter((c) => c.status === 'pending').length;
    const waiting = pendingBuyIns + pendingSitIns + pendingCashOuts;
    if (waiting > 0) {
      throw new HttpError(
        409,
        waiting === 1
          ? 'One request is still waiting — decide it before settling'
          : `${waiting} requests are still waiting — decide them before settling`
      );
    }
    // Idempotent: two hosts tapping together should not stamp two times.
    if (state.settlingAt) return { state, result: null };
    return { state: { ...state, settlingAt: new Date().toISOString() }, result: null };
  });

  emitToClub(clubId, 'club:settling-started', { sessionId, session });
  return session;
}

/** Give the table back. The other half of the freeze, and what makes it safe. */
export async function resumeNight(
  sessionId: string, clubId: string, requesterId: string, isSuperAdmin: boolean
) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubAdmin(club, requesterId, isSuperAdmin);

  const { session } = await mutateSessionState(sessionId, async (state, _tx, row) => {
    assertPhase(row, state, ['settling']);
    return { state: { ...state, settlingAt: null }, result: null };
  });

  emitToClub(clubId, 'club:settling-cancelled', { sessionId, session });
  return session;
}

export async function requestCashOut(sessionId: string, clubId: string, userId: string, amount: number) {
  const { session, result } = await mutateSessionState(sessionId, async (state, _tx, row) => {
    assertPhase(row, state, ['lobby', 'playing']);
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
    return { state: { ...state, cashOuts }, result: null };
  });

  void result;
  emitToClub(clubId, 'club:cashout-requested', { sessionId, userId, amount, session });
  return session;
}

/**
 * `amount` corrects the figure the player submitted.
 *
 * A cash-out is the one number in the night that is read off a physical stack
 * rather than chosen, so it is the one number that is routinely wrong. The
 * admin confirming it is standing at the table looking at the same chips; if
 * the count is out, correcting it here is the honest move. Rejecting instead
 * makes the player re-count something the admin has already counted.
 *
 * Omitted, the submitted figure stands.
 */
export async function decideCashOut(
  sessionId: string, clubId: string, requesterId: string, isSuperAdmin: boolean,
  userId: string, approve: boolean, amount?: number
) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubAdmin(club, requesterId, isSuperAdmin);


  const { session } = await mutateSessionState(sessionId, async (state, _tx, row) => {
    assertPhase(row, state, ['lobby', 'playing']);
    const entry = (state.cashOuts || []).find((c) => c.userId === userId && c.status === 'pending');
    if (!entry) throw new HttpError(404, 'No pending cash-out from that player');

    // Money moving requires a second pair of eyes, exactly as a buy-in does. A
    // player who is also an admin standing themselves up is still the author of
    // that request, and the last admin in the room may always approve their own
    // so a game can never deadlock.
    if (approve && userId === requesterId && hasAnotherAdminHere(club, requesterId, state)) {
      throw new HttpError(403, 'Another Club Admin must confirm your own cash-out');
    }

    const finalAmount = approve && amount !== undefined ? amount : entry.amount;

    // Rejecting drops the request entirely so the player can re-count and retry.
    const cashOuts = approve
      ? (state.cashOuts || []).map((c) =>
          c.userId === userId
            ? { ...c, amount: finalAmount, status: 'confirmed' as const, confirmedBy: requesterId }
            : c)
      : (state.cashOuts || []).filter((c) => c.userId !== userId);

    // A confirmed cash-out frees the seat — they're done playing, but their
    // figures still feed settlement.
    const activePlayerUids = approve
      ? (state.activePlayerUids || []).filter((u) => u !== userId)
      : state.activePlayerUids || [];

    return { state: { ...state, cashOuts, activePlayerUids }, result: null };
  });


  emitToClub(clubId, 'club:cashout-decided', { sessionId, userId, approved: approve, session });
  return session;
}

/**
 * `requestedBy` is whoever pressed the button, which is not always the person
 * getting the chips.
 *
 * It used to be written as `userId` — the recipient — which quietly defeated the
 * oversight rule below. An admin adding chips to another player's stack created
 * a request attributed to that player, so the admin was free to approve their
 * own creation with nobody watching. The recipient is `userId`; the author is
 * `requestedBy`; they are only the same person when someone banks themselves.
 */

export async function requestBuyIn(
  sessionId: string, clubId: string, userId: string, amount: number,
  requestedBy: string = userId
) {
  /*
   * Everything about one buy-in happens under the session lock.
   *
   * The "one pending request per player" check was read-then-write, which is
   * exactly the shape that fails when an admin adds Priya at the same moment
   * Priya taps Join: both calls looked, both found nothing pending, and the
   * host was asked the same question twice about one seat.
   */
  const { result: request } = await mutateSessionState(sessionId, async (state, tx, row) => {
    assertPhase(row, state, ['lobby', 'playing']);

    // Enforced here, not only in the UI — the cap was previously client-side
    // only and any direct API call sailed past it.
    await assertWithinBuyInCeiling(sessionId, clubId, amount, tx);

    /*
     * You cannot come back short of what you left with.
     *
     * The table-stakes rule every home game already plays by: a player who
     * stands up with 7,200 and sits back down with 1,000 has taken 6,200 out
     * of the night mid-game. Everyone else's money is still on the table;
     * theirs is in their pocket. Poker calls it going south.
     *
     * The floor is their own confirmed cash-out, so it is a rule about their
     * money rather than a limit somebody set for them — and somebody who
     * busted out has a floor of zero, which is the point.
     */
    const stoodUpWith = (state.cashOuts || []).find(
      (c) => c.userId === userId && c.status === 'confirmed'
    );
    if (stoodUpWith && amount < stoodUpWith.amount) {
      throw new HttpError(
        409,
        `You stood up with ${stoodUpWith.amount}, so you cannot sit back down with less than that`
      );
    }

    // One pending buy-in per player per session. Its absence was not
    // theoretical: a player whose screen appeared frozen pressed the button
    // around twenty times and created around twenty rows, every one of which
    // an admin then had to triage.
    const pending = await tx.buyInRequest.findFirst({
      where: { sessionId, userId, status: 'pending' },
      select: { id: true },
    });
    if (pending) {
      throw new HttpError(409, 'You already have a buy-in request waiting for approval');
    }

    const created = await tx.buyInRequest.create({
      data: { sessionId, clubId, userId, amount, status: 'pending', requestedBy },
    });

    /*
     * A buy-in supersedes a bare sit-in for the same person.
     *
     * They are different tables in the database and one person in the room.
     * Approving a buy-in seats them anyway, so leaving the sit-in alongside it
     * asks the host to make two decisions about one chair — and answering only
     * one of them leaves a half-arrived player on the felt.
     */
    const pendingSitInUids = (state.pendingSitInUids || []).filter((u) => u !== userId);
    const sitInRequestedAt = { ...(state.sitInRequestedAt || {}) };
    delete sitInRequestedAt[userId];

    return { state: { ...state, pendingSitInUids, sitInRequestedAt }, result: created };
  });

  emitToClub(clubId, 'club:buyin-requested', { sessionId, requestId: request.id, request });
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

  /*
   * Everything that decides the request happens inside the lock.
   *
   * Reading the row, checking it is still pending and then writing it was a
   * check-then-act with a whole network round trip in the middle: two admins
   * both read "pending", both passed the check, and both wrote. Neither was
   * told anything, and approvedBy ended up naming whichever write landed
   * second — the ledger crediting the admin who lost the race.
   *
   * The status check is now the WHERE clause of the update itself, so the
   * database decides who won. Exactly one caller can match a pending row.
   */
  const { session: updatedSession, result } = await mutateSessionState(
    sessionId,
    async (state, tx, row) => {
      assertPhase(row, state, ['lobby', 'playing']);
      const req = await tx.buyInRequest.findUnique({ where: { id: requestId } });
      if (!req || req.sessionId !== sessionId) throw new HttpError(404, 'Buy-in request not found');
      if (req.status !== 'pending') throw new HttpError(409, 'This request has already been decided');

      if (approve) {
        await assertWithinBuyInCeiling(sessionId, session.clubId, req.amount, tx);
        // No exception for the owner. "Nobody can give themselves chips" is the
        // rule, and an owner who wrote the request is exactly as much its author
        // as anyone else. Somebody alone at the table still approves their own —
        // the escape hatch is being alone, not being senior.
        if (req.requestedBy === requesterId && hasAnotherAdminHere(club, requesterId, state)) {
          throw new HttpError(403, 'Another Club Admin must approve your own buy-in request');
        }
      }

      // Conditional by status: the database, not this process, decides which of
      // two simultaneous presses wins.
      const claimed = await tx.buyInRequest.updateMany({
        where: { id: requestId, status: 'pending' },
        data: { status: approve ? 'approved' : 'rejected', approvedBy: requesterId },
      });
      if (claimed.count === 0) throw new HttpError(409, 'This request has already been decided');

      const decided = await tx.buyInRequest.findUniqueOrThrow({ where: { id: requestId } });

      const activePlayerUids = approve
        ? Array.from(new Set([...(state.activePlayerUids || []), req.userId]))
        : state.activePlayerUids || [];

      return { state: { ...state, activePlayerUids }, result: { req, decided } };
    }
  );

  // Emitted after the commit, never inside it: an event sent from within a
  // transaction is a claim about state that may still roll back.
  emitToClub(session.clubId, 'club:buyin-decided', {
    sessionId, requestId, userId: result.req.userId, approve, request: result.decided,
  });

  // Only approvals are messaged, and never awaited — a slow or failing SMS
  // provider must not hold up (or fail) the approval that already committed.
  if (approve) {
    void notificationsService.notifyBuyInApproved({
      userId: result.req.userId,
      clubId: session.clubId,
      amount: result.req.amount,
    });
  }

  void updatedSession;
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
    // The phases the diagram above already grants this transition, stated to the
    // one gate that enforces them. This was the only mutation not declaring its
    // phases, which read as "settling is legal everywhere" — including from the
    // lobby, where a night that never started could be settled on the buy-ins
    // players had put up while waiting. Both documented paths (settling, and the
    // direct one from playing) behave exactly as before.
    assertPhase(row, row.engineState, ['playing', 'settling']);

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

    /*
     * The night's own rules if it has them, the club's if it predates them.
     *
     * This one line is the whole fix: settlement stopped asking "what does the
     * club charge?" and started asking "what did this night agree to?". Every
     * calculation below is untouched — only where the configuration comes from
     * has moved.
     */
    const rules = settlementRulesFor(state);

    const settlementSettings: SettlementSettings = {
      sessionRakeAmount: rules.sessionRakeAmount,
      winnersCutPercent: rules.winnersCutPercent,
      rakeEnabled: rules.rakeEnabled,
      rakeMethod: rules.rakeMethod as SettlementSettings['rakeMethod'],
      rakeValue: rules.rakeValue,
      potEnabled: rules.potEnabled,
      mismatchStrategy: rules.mismatchStrategy as SettlementSettings['mismatchStrategy'],
      rakeOrder: rules.rakeOrder as SettlementSettings['rakeOrder'],
      winnerDefinition: rules.winnerDefinition as SettlementSettings['winnerDefinition'],
      winnerTopN: rules.winnerTopN,
      roundingRule: rules.roundingRule as SettlementSettings['roundingRule'],
    };

    /*
     * The engine's inputs, built once and then both RUN and RECORDED.
     *
     * Extracted into a variable rather than inlined into the call so the
     * canonical record below is provably the same array the engine settled —
     * participant order included, which is arithmetic rather than presentation
     * (canonicalSettlement.ts). Building it twice would let the two drift.
     */
    const enginePlayers = activePlayerUids.map((uid) => {
      const entry = entryByUid.get(uid);
      return {
        userId: uid,
        userDisplayName: nameByUid.get(uid) || 'Player',
        buyIn: Number(entry?.buyIn || 0),
        cashOut: lockedCashOut.has(uid) ? lockedCashOut.get(uid)! : Number(entry?.cashOut || 0),
        manualWinner: entry?.manualWinner,
      };
    });

    const engineResult = computeSettlement(enginePlayers, settlementSettings, {
      currentPotBalance: club.clubPotBalance,
      mismatchAcknowledged: input.mismatchAcknowledged,
    });

    /*
     * The replay contract, captured beside the settlement rather than instead
     * of it. The live path above is untouched — same call, same arguments, same
     * numbers — and this records everything needed to reproduce it later
     * without consulting the Club again.
     *
     * settlementRulesSnapshot.integration.test.ts proves the captured record
     * replays back to exactly what was stored.
     */
    const canonicalInputs = buildCanonicalInputs({
      rules: settlementSettings,
      players: enginePlayers,
      currentPotBalance: club.clubPotBalance,
      mismatchAcknowledged: input.mismatchAcknowledged,
      capturedFrom: 'settleSession',
    });
    const canonicalOutputs = canonicalOutputsFrom(engineResult, canonicalInputs);

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
        /*
         * ONE MEANING, both writers.
         *
         * This was hard-coded to 0 here and set to the FULL rake by
         * applySessionChange, so the same column meant different things
         * depending on which path last wrote it — and it could not mean the
         * winners' cut at all, because the engine fused the cut and the seat
         * fee into one number. Now that the engine reports them apart, the
         * column can finally hold what its name says.
         *
         * Rounded because the column is an Int and Prisma coerces silently;
         * `canonicalOutputs` carries the unrounded figure.
         *
         * Rows written before this change are unreliable and cannot be
         * repaired — nothing renders this field, which is why the ambiguity
         * went unnoticed and why pinning it changes nothing on screen.
         */
        totalWinnersCut: Math.round(engineResult.totalWinnersCut),
        rakeCollected: engineResult.totalRakeCollected,
        potAdjustment: engineResult.potContribution,
        playerSummaries: summaries as any,
        engineVersion: canonicalInputs.engineVersion,
        canonicalInputs: canonicalInputs as unknown as Prisma.InputJsonValue,
        canonicalOutputs: canonicalOutputs as unknown as Prisma.InputJsonValue,
      },
    });

    /*
     * Revision 1, written the moment the night is settled.
     *
     * The original is a revision like any other rather than a special case, so
     * every later correction has something to supersede — and the precondition
     * the design states ("no revision 1, no correction") is satisfied for new
     * nights without a backfill ever running.
     *
     * Inside this transaction on purpose: a settlement that exists without its
     * revision would be a night that could later be overwritten with nothing
     * behind it, which is the one thing the revision model exists to prevent.
     *
     * `isLive` is true and stays true until a correction supersedes it. The
     * partial unique index on (recordId, recordType) WHERE isLive makes "one
     * current settlement per night" a database constraint.
     */
    await tx.settlementRevision.create({
      data: {
        recordId: settlement.id,
        recordType: 'cashout',
        revision: 1,
        isLive: true,
        engineVersion: canonicalInputs.engineVersion,
        ruleSnapshot: canonicalInputs.rules as unknown as Prisma.InputJsonValue,
        canonicalInputs: canonicalInputs as unknown as Prisma.InputJsonValue,
        canonicalOutputs: canonicalOutputs as unknown as Prisma.InputJsonValue,
        totals: canonicalOutputs.totals as unknown as Prisma.InputJsonValue,
        causedBy: 'settle',
        reason: 'Original settlement.',
        requestedBy: requesterId,
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
            // WHICH rules decided this, and whether the night carried its own.
            // Without this a settled record cannot be told apart from one
            // settled under rules that changed after the chips were bought —
            // which is the entire failure this snapshot exists to prevent.
            // The rules that decided these numbers, on the record beside them.
            settlementRules: rules,
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

    // Same source as the engine used. Reading club.potEnabled here while the
    // engine ran on the snapshot would let it compute a pot movement that the
    // ledger silently refuses to write — money accounted for nowhere.
    if (rules.potEnabled && engineResult.potContribution !== 0) {
      if (engineResult.totalRakeCollected > 0) {
        await tx.clubPotLog.create({
          data: {
            clubId: row.clubId,
            sessionId,
            amount: engineResult.totalRakeCollected,
            source: 'fixed_rake',
            note: `Rake (${rules.rakeMethod}) from ${row.sessionName}`,
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

/**
 * Tell a night what it is playing for. Once.
 *
 * The narrow, deliberate door for nights that started before snapshots existed
 * and would otherwise have no rules to settle by. It is an INITIALISATION, not
 * an edit: once a night holds rules, nothing changes them — not another admin,
 * not a club settings change, not a reconnect, not settlement.
 *
 * That one-shot restriction is the whole safety property. An endpoint that
 * could be called repeatedly would let one admin raise the rake and another
 * lower it while a game is running, which is the loophole this mechanism was
 * built to close, reintroduced through its own escape hatch. A host who set the
 * wrong figure has to resume, settle, and start a night with the right ones —
 * expensive on purpose, because the alternative is economics that move under
 * players who already put chips down.
 *
 * The check and the write happen inside mutateSessionState's row lock, so two
 * admins initialising at the same instant serialise: the first wins, the second
 * reads the rules the first just wrote and is refused. Both are told which.
 */
export async function initSettlementRules(
  sessionId: string,
  clubId: string,
  requesterId: string,
  isSuperAdmin: boolean,
  input: { sessionRakeAmount: number; winnersCutPercent: number }
) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubAdmin(club, requesterId, isSuperAdmin);

  if (!Number.isInteger(input.sessionRakeAmount) || input.sessionRakeAmount < 0) {
    throw new HttpError(400, 'The session rake must be a whole number of chips, and cannot be negative');
  }
  if (!Number.isInteger(input.winnersCutPercent) || input.winnersCutPercent < 0 || input.winnersCutPercent > 100) {
    throw new HttpError(400, "The winners' cut must be a whole percentage between 0 and 100");
  }

  const { session, result } = await mutateSessionState(sessionId, async (state, tx, row) => {
    assertPhase(row, state, ['playing']);

    // Inside the lock. Two admins arriving together both read the state fresh
    // here, one at a time, so the second sees what the first wrote.
    if (state.settlementRules) {
      const held = state.settlementRules;
      throw new HttpError(
        409,
        `This night already has its rules: rake ${held.sessionRakeAmount} chips, ` +
          `winners' cut ${held.winnersCutPercent}%. They are fixed for the rest of the night.`
      );
    }

    // Everything except the two figures being set comes from the club, so the
    // night ends up with a complete and coherent set rather than two values
    // floating on nothing.
    const rules: SettlementRules = {
      ...captureSettlementRules(club),
      sessionRakeAmount: input.sessionRakeAmount,
      winnersCutPercent: input.winnersCutPercent,
    };

    const actor = await tx.user.findUnique({ where: { id: requesterId }, select: { displayName: true } });
    await tx.auditLog.create({
      data: {
        clubId: row.clubId,
        // The PokerSession, not a settlement record — this happened to the
        // night itself, and is the one place that lookup means what it says.
        sessionId,
        sessionTitle: row.sessionName,
        action: 'init_settlement_rules',
        changedBy: requesterId,
        changedByName: actor?.displayName ?? 'Unknown',
        details:
          `Set the settlement rules for ${row.sessionName}: ` +
          `rake ${rules.sessionRakeAmount} chips, winners' cut ${rules.winnersCutPercent}%. ` +
          'The night had none, having started before rules were recorded against a session.',
        changes: {
          meta: { auditSchemaVersion: AUDIT_SCHEMA_VERSION, createdFrom: 'initSettlementRules' },
          // Null rather than the club's current values: this night genuinely
          // had no rules, and writing the club's in as "before" would claim it
          // was playing by them.
          before: null,
          after: rules,
        },
        // createdAt is the database's own clock — never the caller's.
      },
    });

    return { state: { ...state, settlementRules: rules }, result: rules };
  });

  emitToClub(clubId, 'club:settlement-rules-set', { sessionId, session, rules: result });
  return { session, rules: result };
}
