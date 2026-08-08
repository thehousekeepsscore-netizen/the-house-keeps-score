import { PokerSession, BuyInRequest } from '../types';
import { durationPhrase } from './night-clock';

/**
 * The story of the night, told from what already happened.
 *
 * DERIVED, not streamed. A socket feed would only ever show you what has
 * happened since you unlocked your phone, which is exactly backwards: the whole
 * point is that you glance at it after twenty minutes of playing cards and
 * immediately know how the evening is going. Everything here is recovered from
 * the buy-ins and cash-outs the client already holds, so the story is complete
 * the moment the screen opens, on any device, with no schema change and no new
 * endpoint.
 *
 * It is a story, not a log. The distinction is what it refuses to say:
 * requested, pending, awaiting approval, approved by. Nobody at a table cares
 * that a workflow advanced — they care that Tara sat down and that the maximum
 * just went up. Every event here is something that happened in the room.
 *
 * TWO HONEST LIMITS, both from the shape of the data rather than from choice:
 *
 *   Buy-ins carry `createdAt` (when it was asked for) and no approval time, and
 *   cash-outs carry `requestedAt` and no confirmation time. So an event is
 *   timestamped when it was ASKED, not when it was agreed. The gap is bounded
 *   by the five-minute request window and is usually seconds.
 *
 *   "Priya is now hosting" is not derivable at all — admin changes carry no
 *   timestamp anywhere in the payload — so it is absent rather than guessed at.
 */

export type FeedKind =
  /** Seated, with no money down yet — the arrival phase. */
  | 'joined'
  /** Their first chips of the night. */
  | 'bought-in'
  /** Any chips after that. */
  | 'topped-up'
  /** Counted up, waiting on somebody to agree. */
  | 'stood-up'
  /** Agreed. They are out of the game and in the room. */
  | 'left'
  /** The table maximum moved, which under MATCH_HIGHEST it does all night. */
  | 'ceiling'
  /** The host started a timed night. */
  | 'timer-started'
  /** More time on the clock. */
  | 'timer-extended'
  /** Several earlier extensions, collapsed so they stop crowding the story. */
  | 'timer-extended-many'
  /** The scheduled time ran out — which ends nothing. */
  | 'timer-reached'
  /** The host chose to carry on with no limit. */
  | 'timer-lifted'
  /** The night is over. */
  | 'settled';

export interface FeedEvent {
  /** Stable across renders, so React keys and the "what is new" check both hold. */
  id: string;
  kind: FeedKind;
  /** ISO. See the timestamp caveat above. */
  at: string;
  userId?: string;
  amount?: number;
  /** How many events this line stands for, when it stands for more than one. */
  count?: number;
}

export interface FeedInput {
  session: PokerSession | null;
  buyIns: BuyInRequest[];
  /** The club's ceiling rule, mirroring getBuyInCeiling on the server. */
  buyInMode?: 'UNCAPPED' | 'MATCH_HIGHEST' | string;
  clubMaxBuyIn?: number;
  /** Older events fall off the end; nobody scrolls to the start of the evening. */
  limit?: number;
  /** Injectable so "has the scheduled time passed yet" is testable. */
  now?: number;
}

const DEFAULT_LIMIT = 30;

/** Mirrors getBuyInCeiling: the biggest bank held, or the club's own maximum until one is. */
function ceilingOf(
  banks: Map<string, number>,
  mode: string | undefined,
  clubMax: number | undefined
): number | null {
  if ((mode ?? 'MATCH_HIGHEST') === 'UNCAPPED') return null;
  const highest = banks.size ? Math.max(...banks.values()) : 0;
  return highest > 0 ? highest : clubMax ?? null;
}

export function deriveFeed(input: FeedInput): FeedEvent[] {
  const { session, buyIns, buyInMode, clubMaxBuyIn } = input;
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!session) return [];

  /*
   * The lobby is silent.
   *
   * Nothing has happened yet — people are arriving and buying in, which is
   * preparation rather than story, and a feed narrating it ("Priya bought in
   * for 5,000") would be telling you about a night that has not started. The
   * story begins when the host does.
   *
   * Undefined, as everywhere else, means a session older than the lobby: those
   * are being played, so they have a story.
   */
  if (session.startedPlayingAt === null) return [];

  const events: FeedEvent[] = [];

  // Chronological on the way in, because two of these are cumulative: whether a
  // buy-in is somebody's first, and whether it moved the ceiling. Reversed at
  // the end, once the answers are known.
  const approved = buyIns
    .filter((r) => r.sessionId === session.id && r.status === 'approved')
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const banks = new Map<string, number>();
  let ceiling = ceilingOf(banks, buyInMode, clubMaxBuyIn);

  for (const r of approved) {
    const first = !banks.has(r.userId);
    banks.set(r.userId, (banks.get(r.userId) ?? 0) + r.amount);

    events.push({
      id: `buyin:${r.id}`,
      kind: first ? 'bought-in' : 'topped-up',
      at: r.createdAt,
      userId: r.userId,
      amount: r.amount,
    });

    /*
     * A rise is only worth saying when it is not already on the line above it.
     *
     * Under MATCH_HIGHEST the ceiling is the biggest bank anyone HOLDS, so a
     * player's first buy-in sets it to exactly that amount: "Kabir bought in
     * for 10,000" followed by "Max buy-in is now 10,000" is the same number
     * twice, and in a night where each player takes a little more than the last
     * it turns half the feed into an echo.
     *
     * A top-up is the case that earns the line — someone at 3,000 buying
     * another 5,000 pushes the maximum to 8,000, which appears nowhere else.
     *
     * A fall is not announced at all. The ceiling cannot drop while a night
     * runs, but a club switching modes mid-session would otherwise report a cut
     * nobody made.
     */
    const next = ceilingOf(banks, buyInMode, clubMaxBuyIn);
    if (next !== null && ceiling !== null && next > ceiling && next !== r.amount) {
      events.push({ id: `ceiling:${r.id}`, kind: 'ceiling', at: r.createdAt, amount: next });
    }
    ceiling = next;
  }

  // Seated with nothing down yet. Only for people who have not bought in at all,
  // so an arrival and their first chips are never two lines about one moment.
  for (const userId of session.pendingSitInUids ?? []) {
    const at = session.sitInRequestedAt?.[userId];
    if (at && !banks.has(userId)) {
      events.push({ id: `join:${userId}`, kind: 'joined', at, userId });
    }
  }

  // One event per person, not two. A confirmed cash-out carries no separate
  // confirmation time, so emitting both "stood up" and "left" would put two
  // lines at one timestamp — the line simply becomes the later of the two when
  // the count is agreed, and keeps the figure either way.
  for (const c of session.cashOuts ?? []) {
    events.push({
      id: `cashout:${c.userId}`,
      kind: c.status === 'confirmed' ? 'left' : 'stood-up',
      at: c.requestedAt,
      userId: c.userId,
      amount: c.amount,
    });
  }

  /*
   * The clock, as things that happened.
   *
   * A timer changing under you is confusing unless the feed says why: the
   * scheduled hour ran out, somebody added thirty minutes, the host decided to
   * carry on. These are the events that explain a number nobody touched.
   */
  if (session.startedPlayingAt && session.durationMinutes) {
    events.push({
      id: 'timer:started',
      kind: 'timer-started',
      at: session.startedPlayingAt,
      amount: session.durationMinutes,
    });

    /*
     * Extensions, individually while that stays readable.
     *
     * A night extended twice is a story. A night extended six times is six
     * near-identical lines pushing everything else off the feed, and the thing
     * anybody actually wants from them is "this night has been going a while".
     * Past two, the older ones collapse into one line carrying the total.
     */
    const exts = session.timeExtensions ?? [];
    const RECENT = 2;
    const recent = exts.slice(-RECENT);
    const older = exts.slice(0, -RECENT);

    if (older.length > 0) {
      events.push({
        id: 'timer:ext:earlier',
        kind: 'timer-extended-many',
        at: older[older.length - 1].at,
        amount: older.reduce((sum, e) => sum + e.minutes, 0),
        count: older.length,
      });
    }
    for (const [i, ext] of recent.entries()) {
      events.push({
        id: `timer:ext:${older.length + i}`,
        kind: 'timer-extended',
        at: ext.at,
        amount: ext.minutes,
      });
    }

    // Derived rather than stored: the scheduled end is arithmetic, and it is
    // only worth saying once it has actually passed.
    const total =
      session.durationMinutes +
      (session.timeExtensions ?? []).reduce((sum, e) => sum + e.minutes, 0);
    const endsAt = Date.parse(session.startedPlayingAt) + total * 60_000;
    if (Number.isFinite(endsAt) && endsAt <= (input.now ?? Date.now())) {
      events.push({ id: 'timer:reached', kind: 'timer-reached', at: new Date(endsAt).toISOString() });
    }
  }

  if (session.timeLimitLiftedAt) {
    events.push({ id: 'timer:lifted', kind: 'timer-lifted', at: session.timeLimitLiftedAt });
  }

  if (session.status === 'settled' && session.endedAt) {
    events.push({ id: 'settled', kind: 'settled', at: session.endedAt });
  }

  return events
    .sort((a, b) => {
      const d = Date.parse(b.at) - Date.parse(a.at);
      // A buy-in and the ceiling it moved share a timestamp exactly. The rise
      // has to read as the consequence, so it sorts above the cause.
      if (d !== 0) return d;
      if (a.kind === 'ceiling' && b.kind !== 'ceiling') return -1;
      if (b.kind === 'ceiling' && a.kind !== 'ceiling') return 1;
      // A buy-in and a cash-out can land in the same second. Falling back to 0
      // leaves the order to whatever the input happened to be, so the feed can
      // reshuffle between one render and the next for no reason anybody can see.
      // The id is stable and unique, so this is arbitrary but never changes.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, limit);
}

/** One glyph per kind. The only place in the app that uses emoji, and it earns
 *  them: a feed is scanned down the left edge, and a shape is faster than a word. */
const ICON: Record<FeedKind, string> = {
  'timer-started': '⏱',
  'timer-extended': '⏱',
  'timer-extended-many': '⏱',
  'timer-reached': '🏁',
  'timer-lifted': '▶',
  joined: '👤',
  'bought-in': '🟢',
  'topped-up': '💰',
  'stood-up': '💵',
  left: '✅',
  ceiling: '⬆️',
  settled: '🏁',
};

/**
 * The line, in the second person wherever it is about you.
 *
 * "You bought another 5,000" and "Arjun bought another 5,000" are the same event
 * and not the same sentence, and the difference is the whole reason this reads
 * as your view of the night rather than a system log.
 */
export function feedLine(
  event: FeedEvent,
  nameOf: (userId: string) => string,
  amount: (n: number) => string
): { icon: string; text: string } {
  const icon = ICON[event.kind];
  const who = event.userId ? nameOf(event.userId) : '';
  const you = who === 'You';
  const n = event.amount ?? 0;

  switch (event.kind) {
    case 'joined':
      return { icon, text: `${who} joined the table` };
    case 'bought-in':
      return { icon, text: `${who} bought in for ${amount(n)}` };
    case 'topped-up':
      return { icon, text: `${who} bought another ${amount(n)}` };
    case 'stood-up':
      return { icon, text: `${who} stood up with ${amount(n)}` };
    case 'left':
      // "has left" for someone else, "have left" for you — the one place the
      // second person needs a different verb, and the reason to write both out
      // rather than assemble them.
      return { icon, text: you ? `You left the table with ${amount(n)}` : `${who} left the table with ${amount(n)}` };
    case 'ceiling':
      return { icon, text: `Max buy-in is now ${amount(n)}` };
    case 'timer-started':
      return { icon, text: `Session started (${durationPhrase(n)} timer)` };
    case 'timer-extended':
      return { icon, text: `Session extended by ${minutesPhrase(n)}` };
    case 'timer-extended-many':
      return {
        icon,
        text: `Extended ${event.count} more times, by ${minutesPhrase(n)} in total`,
      };
    case 'timer-reached':
      return { icon, text: 'Scheduled time reached' };
    case 'timer-lifted':
      return { icon, text: 'Session continued without a time limit' };
    case 'settled':
      return { icon, text: 'Settlement started' };
  }
}

/** "30 minutes", "1 hour" — how an extension reads in a sentence. */
function minutesPhrase(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h === 1 ? '1 hour' : `${h} hours`;
  const mins = m === 1 ? '1 minute' : `${m} minutes`;
  // "90 minutes" is fine for one extension and poor for a total: four half-hours
  // read as "2 hours", not as "120 minutes".
  if (h === 0) return mins;
  return m === 0 ? hours : `${hours} ${mins}`;
}

/** "2 sec ago" — coarse on purpose, because the feed is glanced at, not read. */
export function agoLabel(at: string, now: number): string {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return '';
  const secs = Math.max(0, Math.round((now - t) / 1000));
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs} sec ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}
