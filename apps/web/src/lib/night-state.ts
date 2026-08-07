import { PokerSession, BuyInRequest } from '../types';

/**
 * Everything the live session screen needs, derived from the session and its
 * buy-in requests. One pure function, no React, no network.
 *
 * It exists because the old screen recomputed each of these inline, in render,
 * a few lines apart — which is how "Arjun · 0 Chips" happened: the chip figure
 * and the pending request were derived independently, so a player waiting on a
 * decision was described with settled-state vocabulary.
 *
 * Deriving them together makes that contradiction unrepresentable: a seat has
 * exactly one state, and the queue and the seat are computed from the same
 * pass over the same data.
 *
 * Nothing here talks to the server. The server is the authority on every rule
 * this mirrors (the buy-in ceiling, the expiry window, who may approve what);
 * this only decides what the screen says.
 */

/**
 * The six faces of a night. Every one is derivable from fields the API already
 * returns — no schema change, and no new endpoint.
 *
 * The point of naming them is that each has a different answer to "what do I
 * need to do next?", and a screen that does not know which one it is in has to
 * show all six answers at once.
 */
export type NightPhase =
  /** No session running. */
  | 'dark'
  /** Running, but nobody has chips yet — the arrival phase. */
  | 'opening'
  /** The long middle: people are playing. */
  | 'running'
  /** At least one player has been counted out, others are still in. */
  | 'windingDown'
  /** Everyone has left the table. One decision remains. */
  | 'ready'
  /** Settled. The night is a receipt. */
  | 'closed';

/**
 * What a seat is doing. Five states, all real, all derivable today.
 *
 * "Sitting out" is deliberately absent: the offline session model has no such
 * field, and a ledger app does not deal hands, so "deal me out for a few" is a
 * no-op it should never have tracked. `seatedNoChips` replaces it — a real
 * state the old screen mislabelled as "0 Chips".
 *
 * Dealer is absent too: the dealer button exists physically on the table.
 */
export type SeatState =
  | 'waitingToSit'
  | 'seatedNoChips'
  | 'inPlay'
  | 'countingOut'
  | 'cashedOut';

export type QueueKind = 'buy-in' | 'sit-in' | 'cash-out';

/**
 * Mirrors REQUEST_TTL_MS in offlineSessions.service.ts. The server is the
 * authority — this copy exists so the screen can show the countdown, and it
 * must never claim a request is dead before the server says so.
 */
export const REQUEST_TTL_MS = 5 * 60 * 1000;

export interface QueuedRequest {
  /** Stable across renders: the buy-in row id, or `<kind>:<uid>` for the two that live on engineState. */
  id: string;
  kind: QueueKind;
  userId: string;
  /**
   * Whether this is someone arriving or someone already at the table.
   *
   * Both are a pending buy-in to the server, and they are completely different
   * events to a human: "Priya wants to join" and "Rahul needs more chips" are
   * the same row in the database and never the same sentence.
   */
  joining: boolean;
  /** Chips. Sit-ins have no amount. */
  amount?: number;
  requestedAt?: string;
  /** Milliseconds until the server will auto-reject. Null when unknown. */
  msRemaining: number | null;
}

export interface Seat {
  userId: string;
  state: SeatState;
  /** Sum of approved buy-ins. Never a live stack — the app cannot know that. */
  totalBuyIn: number;
  /** Amount awaiting approval, if any. */
  pendingBuyIn: number | null;
  /** Amount awaiting confirmation, if they are counting out. */
  pendingCashOut: number | null;
  /** Locked figure, once an admin has confirmed it. */
  confirmedCashOut: number | null;
}

export interface Night {
  phase: NightPhase;
  seats: Seat[];
  /** Oldest first — the longest wait is the biggest social cost at a real table. */
  queue: QueuedRequest[];
  /** Bought in, less anything already counted out. Not a pot. */
  chipsInPlay: number;
  /** Seated right now. Excludes anyone already counted out. */
  playersAtTable: number;
  /** Everyone the night settles: seated players plus confirmed cash-outs. */
  settlementUids: string[];
  canSettle: boolean;
  settleBlockedReason: string | null;
  /** The viewer's own seat, when they have one. */
  mySeat: Seat | null;
}

export interface NightInput {
  session: PokerSession | null;
  buyIns: BuyInRequest[];
  currentUserId: string;
  /** Admins triage everyone's requests; a player only ever sees their own. */
  isAdmin: boolean;
  now?: number;
}

/** Null rather than a negative number when there is no timestamp to count from. */
export function msRemaining(requestedAt: string | undefined, now: number): number | null {
  if (!requestedAt) return null;
  const t = Date.parse(requestedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, t + REQUEST_TTL_MS - now);
}

export function deriveNight(input: NightInput): Night {
  const { session, buyIns, currentUserId, isAdmin } = input;
  const now = input.now ?? Date.now();

  if (!session) {
    return {
      phase: 'dark',
      seats: [],
      queue: [],
      chipsInPlay: 0,
      playersAtTable: 0,
      settlementUids: [],
      canSettle: false,
      settleBlockedReason: null,
      mySeat: null,
    };
  }

  const sessionBuyIns = buyIns.filter((r) => r.sessionId === session.id);
  const approved = sessionBuyIns.filter((r) => r.status === 'approved');
  const pendingBuyIns = sessionBuyIns.filter((r) => r.status === 'pending');

  const activeUids = session.activePlayerUids ?? [];
  const pendingSitInUids = session.pendingSitInUids ?? [];
  const cashOuts = session.cashOuts ?? [];
  const pendingCashOuts = cashOuts.filter((c) => c.status === 'pending');
  const confirmedCashOuts = cashOuts.filter((c) => c.status === 'confirmed');

  const bankByUid = new Map<string, number>();
  for (const r of approved) bankByUid.set(r.userId, (bankByUid.get(r.userId) ?? 0) + r.amount);

  // What is on the table: everything bought in, less anything already counted
  // out. Buy-ins alone would keep counting chips that left with their owner.
  const chipsInPlay =
    approved.reduce((sum, r) => sum + r.amount, 0) -
    confirmedCashOuts.reduce((sum, c) => sum + c.amount, 0);

  // Everyone the night settles. Someone who stood up has left activePlayerUids
  // but is still part of the night, and the server settles this same union —
  // iterating the smaller set silently drops them from the figures.
  const settlementUids = Array.from(
    new Set([...activeUids, ...confirmedCashOuts.map((c) => c.userId)])
  );

  // Seat order is FIXED FOR THE NIGHT, by when each player first took a bank.
  //
  // Deriving it from the live lists would reorder the table every time someone
  // moved between them — confirming a cash-out removes a player from
  // activePlayerUids, so they would jump to the end of the array and every seat
  // after them would shift. During the ten minutes when people are leaving,
  // that is the whole table rearranging itself repeatedly, and it breaks the
  // one rule the felt has to keep: a seat never moves because someone else
  // left. It would also move live controls under a thumb (PRODUCT-BRIEF §2.5).
  //
  // First approved buy-in, then sit-in request, then uid — so the order is
  // arrival order where that is known, and deterministic where it is not.
  const firstBank = new Map<string, number>();
  for (const r of approved) {
    const t = Date.parse(r.createdAt);
    if (!Number.isFinite(t)) continue;
    const prev = firstBank.get(r.userId);
    if (prev === undefined || t < prev) firstBank.set(r.userId, t);
  }
  const joinedAt = (uid: string) => {
    const banked = firstBank.get(uid);
    if (banked !== undefined) return banked;
    const asked = Date.parse(session.sitInRequestedAt?.[uid] ?? '');
    return Number.isFinite(asked) ? asked : Number.POSITIVE_INFINITY;
  };

  // Someone who has asked to join is at the table the moment they ask.
  //
  // They have no seat on the server until an admin approves — but making them
  // wait on a separate screen while the table carries on without them is the
  // difference between joining a game and filing a request. Their seat appears
  // straight away, waiting, and everyone else can see they are about to sit
  // down. Approval then turns that seat into a playing one, rather than
  // teleporting a new person onto the felt.
  const everyone = Array.from(
    new Set([
      ...activeUids,
      ...pendingSitInUids,
      ...pendingBuyIns.map((r) => r.userId),
      ...cashOuts.map((c) => c.userId),
    ])
  ).sort((a, b) => joinedAt(a) - joinedAt(b) || (a < b ? -1 : a > b ? 1 : 0));

  const seats: Seat[] = everyone.map((userId) => {
    const pendingCashOut = pendingCashOuts.find((c) => c.userId === userId) ?? null;
    const confirmedCashOut = confirmedCashOuts.find((c) => c.userId === userId) ?? null;
    const pendingBuyIn = pendingBuyIns.find((r) => r.userId === userId) ?? null;
    const totalBuyIn = bankByUid.get(userId) ?? 0;

    // Order matters, and it is the rule that pending state never masquerades as
    // settled state: an unresolved question about a player outranks any fact
    // about them.
    //
    // "Seated" is the hinge. Someone with a pending buy-in who is already at
    // the table is buying more chips; the same request from someone who is not
    // is them arriving. Same row on the server, different person to talk to.
    const seated = activeUids.includes(userId);
    const state: SeatState =
      !seated && (pendingSitInUids.includes(userId) || pendingBuyIn)
        ? 'waitingToSit'
        : pendingCashOut
          ? 'countingOut'
          : confirmedCashOut
            ? 'cashedOut'
            : totalBuyIn > 0
              ? 'inPlay'
              : 'seatedNoChips';

    return {
      userId,
      state,
      totalBuyIn,
      pendingBuyIn: pendingBuyIn?.amount ?? null,
      pendingCashOut: pendingCashOut?.amount ?? null,
      confirmedCashOut: confirmedCashOut?.amount ?? null,
    };
  });

  const mine = (userId: string) => isAdmin || userId === currentUserId;

  const queue: QueuedRequest[] = [
    ...pendingBuyIns.filter((r) => mine(r.userId)).map((r) => ({
      id: r.id,
      kind: 'buy-in' as const,
      userId: r.userId,
      joining: !activeUids.includes(r.userId),
      amount: r.amount,
      requestedAt: r.createdAt,
      msRemaining: msRemaining(r.createdAt, now),
    })),
    ...pendingSitInUids.filter(mine).map((userId) => {
      const requestedAt = session.sitInRequestedAt?.[userId];
      return {
        id: `sit-in:${userId}`,
        kind: 'sit-in' as const,
        userId,
        joining: true,
        requestedAt,
        msRemaining: msRemaining(requestedAt, now),
      };
    }),
    ...pendingCashOuts.filter((c) => mine(c.userId)).map((c) => ({
      id: `cash-out:${c.userId}`,
      kind: 'cash-out' as const,
      userId: c.userId,
      joining: false,
      amount: c.amount,
      requestedAt: c.requestedAt,
      msRemaining: msRemaining(c.requestedAt, now),
    })),
  ].sort((a, b) => {
    // Oldest first. All three kinds share one TTL, so this is also
    // least-time-remaining first — the one about to expire rises to the top.
    // Anything without a timestamp sorts last rather than winning by accident.
    const ta = a.requestedAt ? Date.parse(a.requestedAt) : Number.POSITIVE_INFINITY;
    const tb = b.requestedAt ? Date.parse(b.requestedAt) : Number.POSITIVE_INFINITY;
    return ta - tb;
  });

  const phase: NightPhase =
    session.status === 'settled'
      ? 'closed'
      : activeUids.length === 0 && settlementUids.length > 0
        ? 'ready'
        : confirmedCashOuts.length > 0
          ? 'windingDown'
          : approved.length > 0
            ? 'running'
            : 'opening';

  // Mirrors offlineSessions.service.ts, which rejects a one-player night. The
  // old screen only discovered this on submit, after the admin had entered
  // every figure.
  const settleBlockedReason =
    phase === 'ready' && settlementUids.length < 2
      ? 'A night needs at least two players to settle.'
      : null;

  return {
    phase,
    seats,
    queue,
    chipsInPlay,
    playersAtTable: activeUids.length,
    settlementUids,
    canSettle: phase === 'ready' && settleBlockedReason === null,
    settleBlockedReason,
    mySeat: seats.find((s) => s.userId === currentUserId) ?? null,
  };
}
