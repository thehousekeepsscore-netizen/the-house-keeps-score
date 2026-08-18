import { prisma } from '../../lib/prisma.js';
import { sendMessageSafely } from '../../lib/messaging.js';
import { buyInApprovedMessage, joinRequestDecidedMessage, sessionSettledMessage } from '../../lib/messageTemplates.js';

// Player-facing messages. Two triggers only, per the product decision:
//   1. a buy-in was approved — SMS/WhatsApp only, never email (too frequent)
//   2. a session was settled — every channel. Each player gets their own
//      result, running total and rank, never anybody else's figures.
//
// Every function here is fire-and-forget: they swallow their own errors so a
// messaging problem can never roll back the poker action that triggered them.

const chips = (n: number) => `${Math.round(n).toLocaleString('en-IN')} Chips`;

const signedChips = (n: number) => {
  const rounded = Math.round(n);
  if (rounded === 0) return 'even';
  return `${rounded > 0 ? '+' : '-'}${Math.abs(rounded).toLocaleString('en-IN')} Chips`;
};

interface PlayerSummaryLike {
  userId?: string;
  userDisplayName?: string;
  netResult: number;
  totalBuyIn: number;
  cashOut: number;
}

interface HistoricalStatLike {
  userId?: string;
  userName?: string;
  profit: number;
}

const ordinal = (n: number): string => {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

interface Standings {
  /** Lifetime net per player. Used only to derive each player's own figures. */
  netByUser: Map<string, number>;
  /** Every ranked participant, including unlinked/manual rows. */
  totalRanked: number;
  rankByUser: Map<string, number>;
}

/**
 * Lifetime nets for the whole club in one pass, across settled cashouts and
 * imported paper records — the same aggregation the leaderboard uses.
 *
 * Computed once per settlement and shared across all the emails, rather than
 * re-scanning both tables for every player. Callers must only ever read the
 * *recipient's own* entry out of this: nobody is shown another player's
 * figures, only their own rank position within the total.
 */
async function getStandings(clubId: string): Promise<Standings> {
  const [historicalRecords, settlements] = await Promise.all([
    prisma.historicalSessionRecord.findMany({ where: { clubId, isDeleted: false }, select: { playerStats: true } }),
    prisma.cashOutSettlement.findMany({ where: { clubId, isDeleted: false }, select: { playerSummaries: true } }),
  ]);

  // Unlinked/manual rows have no userId but still occupy a leaderboard place,
  // so they're keyed by name to keep the rank denominator honest.
  const netByKey = new Map<string, number>();
  const netByUser = new Map<string, number>();

  const add = (userId: string | undefined, name: string | undefined, amount: number) => {
    const key = userId || `name:${name || 'unknown'}`;
    netByKey.set(key, (netByKey.get(key) || 0) + amount);
    if (userId) netByUser.set(userId, (netByUser.get(userId) || 0) + amount);
  };

  for (const record of historicalRecords) {
    for (const stat of (record.playerStats as unknown as HistoricalStatLike[]) || []) {
      add(stat.userId, stat.userName, stat.profit || 0);
    }
  }

  for (const settlement of settlements) {
    for (const summary of (settlement.playerSummaries as unknown as PlayerSummaryLike[]) || []) {
      add(summary.userId, summary.userDisplayName, summary.netResult || 0);
    }
  }

  const ordered = [...netByKey.entries()].sort((a, b) => b[1] - a[1]);
  const rankByUser = new Map<string, number>();
  ordered.forEach(([key], i) => {
    if (!key.startsWith('name:')) rankByUser.set(key, i + 1);
  });

  return { netByUser, totalRanked: ordered.length, rankByUser };
}

export async function notifyBuyInApproved(params: {
  userId: string;
  clubId: string;
  amount: number;
}): Promise<void> {
  try {
    const [user, club] = await Promise.all([
      prisma.user.findUnique({
        where: { id: params.userId },
        select: { displayName: true, email: true, phoneNumber: true },
      }),
      prisma.club.findUnique({ where: { id: params.clubId }, select: { name: true } }),
    ]);
    if (!user) return;

    const message = buyInApprovedMessage({
      firstName: (user.displayName || 'Player').split(' ')[0],
      amount: chips(params.amount),
      clubName: club?.name || 'your club',
    });

    // Deliberately not emailed: a player can take several banks in one night,
    // and that many emails reads as spam. Cashouts are the only email.
    await sendMessageSafely(user, message, `buy-in approval to ${params.userId}`, {
      channels: ['sms', 'whatsapp'],
    });
  } catch (err) {
    console.error('[notifications] notifyBuyInApproved failed:', err);
  }
}

export async function notifySessionSettled(params: {
  clubId: string;
  sessionName: string;
  summaries: PlayerSummaryLike[];
}): Promise<void> {
  try {
    const club = await prisma.club.findUnique({ where: { id: params.clubId }, select: { name: true } });

    // Only players linked to a real account can be messaged; imported/manual
    // rows have no userId.
    const userIds = params.summaries.map((s) => s.userId).filter((id): id is string => !!id);
    if (userIds.length === 0) return;

    const [users, standings] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, displayName: true, email: true, phoneNumber: true },
      }),
      // One pass for the whole club, shared across every email below.
      getStandings(params.clubId),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));

    // Sequential rather than Promise.all so a burst of sends doesn't trip the
    // provider's rate limit on a big table.
    for (const summary of params.summaries) {
      if (!summary.userId) continue;
      const user = userById.get(summary.userId);
      if (!user) continue;

      const lifetimeNet = standings.netByUser.get(summary.userId) ?? 0;
      const place = standings.rankByUser.get(summary.userId);
      const rank = place ? `${ordinal(place)} of ${standings.totalRanked}` : 'Unranked';
      const resultLine =
        summary.netResult === 0
          ? 'You broke even this session.'
          : `You ${summary.netResult > 0 ? 'won' : 'lost'} ${chips(Math.abs(summary.netResult))} this session.`;

      const message = sessionSettledMessage({
        firstName: (user.displayName || 'Player').split(' ')[0],
        sessionName: params.sessionName,
        clubName: club?.name || 'your club',
        resultLine,
        bankIn: chips(summary.totalBuyIn),
        cashedOut: chips(summary.cashOut),
        netResult: summary.netResult,
        standing: signedChips(lifetimeNet),
        rank,
      });

      await sendMessageSafely(user, message, `settlement to ${summary.userId}`);
    }
  } catch (err) {
    console.error('[notifications] notifySessionSettled failed:', err);
  }
}

/**
 * Tells someone the answer to their request to join a club.
 *
 * Both outcomes are sent. A rejection that goes unsent leaves the requester
 * watching a "pending" badge that will never move, which is worse than the
 * answer they did not want.
 *
 * NOT a socket event. The requester is not in the club's socket room — on
 * rejection they never will be, and on acceptance they only join it on their
 * next connection — so `emitToClub` would reach every admin and miss the one
 * person the message is for. Messaging is the channel that reaches them.
 *
 * Failures are swallowed, as everywhere else in this file: the decision is
 * already committed, and a messaging outage must not make it look otherwise.
 */
export async function notifyJoinRequestDecided(params: {
  userId: string;
  clubId: string;
  accepted: boolean;
}): Promise<void> {
  try {
    const [user, club] = await Promise.all([
      prisma.user.findUnique({
        where: { id: params.userId },
        select: { displayName: true, email: true, phoneNumber: true },
      }),
      prisma.club.findUnique({ where: { id: params.clubId }, select: { name: true } }),
    ]);
    if (!user) return;

    const message = joinRequestDecidedMessage({
      firstName: (user.displayName || 'Player').split(' ')[0],
      clubName: club?.name || 'the club',
      accepted: params.accepted,
    });

    // Email included, unlike a buy-in: this happens once per club, not several
    // times a night, so it cannot read as spam — and it is the one message a
    // requester may be waiting on while not in the app.
    await sendMessageSafely(user, message, `join decision to ${params.userId}`, {
      channels: ['email', 'sms', 'whatsapp'],
    });
  } catch (err) {
    console.error('[notifications] notifyJoinRequestDecided failed:', err);
  }
}
