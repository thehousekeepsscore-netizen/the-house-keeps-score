import { describe, it, expect } from 'vitest';
import { deriveFeed, feedLine, agoLabel, FeedEvent } from './night-feed';
import { PokerSession, BuyInRequest } from '../types';

/**
 * The story of the night, and what it refuses to say.
 *
 * The load-bearing claim is negative: no workflow. "Requested", "pending",
 * "awaiting approval", "approved by" are all things the data knows and the feed
 * must never mention, because nobody at a table cares that a state machine
 * advanced. Everything here is something that happened in the room.
 */

const NOW = Date.parse('2026-08-06T21:00:00.000Z');
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();
const fmt = (n: number) => n.toLocaleString();

function session(over: Partial<PokerSession> = {}): PokerSession {
  return {
    id: 's1', clubId: 'c1', sessionName: 'Fri 8 Aug', status: 'active',
    activePlayerUids: [], pendingSitInUids: [], sitInRequestedAt: {}, cashOuts: [],
    startedBy: 'host', createdAt: ago(300),
    startedPlayingAt: ago(250),
    ...over,
  };
}

function buyIn(over: Partial<BuyInRequest> = {}): BuyInRequest {
  return {
    id: `b-${over.userId}-${over.createdAt}`, sessionId: 's1', clubId: 'c1',
    userId: 'priya', userDisplayName: '', amount: 5000, status: 'approved',
    requestedBy: 'priya', createdAt: ago(60),
    ...over,
  };
}

const names: Record<string, string> = { priya: 'Priya', arjun: 'Arjun', me: 'You' };
const nameOf = (uid: string) => names[uid] ?? 'Player';
const lines = (events: FeedEvent[]) => events.map((e) => feedLine(e, nameOf, fmt).text);

describe('it tells you what happened, never what was processed', () => {
  it('says nothing at all about requests that are still waiting', () => {
    // The single rule that separates a story from a log. A pending buy-in is a
    // workflow state; it belongs in the approval queue and nowhere else.
    const feed = deriveFeed({
      session: session(),
      buyIns: [buyIn({ userId: 'priya', status: 'pending', createdAt: ago(1) })],
    });
    expect(feed).toEqual([]);
  });

  it('says nothing about rejections either', () => {
    const feed = deriveFeed({
      session: session(),
      buyIns: [buyIn({ userId: 'priya', status: 'rejected', createdAt: ago(1) })],
    });
    expect(feed).toEqual([]);
  });

  it('never uses the vocabulary of the queue', () => {
    const feed = deriveFeed({
      session: session({
        cashOuts: [{ userId: 'arjun', amount: 7200, status: 'pending', requestedAt: ago(2) }],
      }),
      buyIns: [buyIn({ userId: 'priya', amount: 3000, createdAt: ago(9) })],
    });
    const text = lines(feed).join(' | ').toLowerCase();
    for (const word of ['request', 'pending', 'approv', 'waiting', 'admin']) {
      expect(text).not.toContain(word);
    }
  });
});

describe('the events themselves', () => {
  it('reads a first buy-in as arriving and the rest as topping up', () => {
    const feed = deriveFeed({
      session: session(),
      buyIns: [
        buyIn({ userId: 'priya', amount: 3000, createdAt: ago(20) }),
        buyIn({ userId: 'priya', amount: 5000, createdAt: ago(4) }),
      ],
      buyInMode: 'UNCAPPED',
    });
    expect(lines(feed)).toEqual([
      'Priya bought another 5,000',
      'Priya bought in for 3,000',
    ]);
  });

  it('seats someone who has arrived with no chips down yet', () => {
    const feed = deriveFeed({
      session: session({ pendingSitInUids: ['arjun'], sitInRequestedAt: { arjun: ago(3) } }),
      buyIns: [],
    });
    expect(lines(feed)).toEqual(['Arjun joined the table']);
  });

  it('does not announce an arrival twice for someone who bought in', () => {
    // Their first chips ARE the arrival. Two lines at one moment is the exact
    // noise this feed exists to avoid.
    const feed = deriveFeed({
      session: session({ pendingSitInUids: ['priya'], sitInRequestedAt: { priya: ago(20) } }),
      buyIns: [buyIn({ userId: 'priya', amount: 3000, createdAt: ago(20) })],
      buyInMode: 'UNCAPPED',
    });
    expect(lines(feed)).toEqual(['Priya bought in for 3,000']);
  });

  it('keeps the figure when somebody stands up, and again when they leave', () => {
    const standing = deriveFeed({
      session: session({
        cashOuts: [{ userId: 'arjun', amount: 7200, status: 'pending', requestedAt: ago(2) }],
      }),
      buyIns: [],
    });
    expect(lines(standing)).toEqual(['Arjun stood up with 7,200']);

    const gone = deriveFeed({
      session: session({
        cashOuts: [{ userId: 'arjun', amount: 7200, status: 'confirmed', requestedAt: ago(2) }],
      }),
      buyIns: [],
    });
    // One line per person, not two: a confirmed cash-out carries no separate
    // confirmation time, so both events would land on the same timestamp.
    expect(lines(gone)).toEqual(['Arjun left the table with 7,200']);
  });
});

describe('the moving ceiling', () => {
  it('announces a rise nobody could have read off the line above', () => {
    // A top-up is the case that earns the line: 3,000 plus another 5,000 is a
    // bank of 8,000, and 8,000 appears nowhere else on screen.
    const feed = deriveFeed({
      session: session(),
      buyIns: [
        buyIn({ userId: 'priya', amount: 5000, createdAt: ago(40) }),
        buyIn({ userId: 'arjun', amount: 3000, createdAt: ago(30) }),
        buyIn({ userId: 'arjun', amount: 5000, createdAt: ago(10) }),
      ],
      buyInMode: 'MATCH_HIGHEST',
      clubMaxBuyIn: 5000,
    });
    expect(lines(feed)).toContain('Max buy-in is now 8,000');
  });

  it('stays quiet when the rise is the buy-in restated', () => {
    // Under MATCH_HIGHEST a player's FIRST buy-in sets the ceiling to exactly
    // its own amount. "Kabir bought in for 10,000 / Max buy-in is now 10,000"
    // is the same number twice, and in a night where each player takes a little
    // more than the last it turned half the feed into an echo.
    const feed = deriveFeed({
      session: session(),
      buyIns: [
        buyIn({ userId: 'priya', amount: 5000, createdAt: ago(30) }),
        buyIn({ userId: 'arjun', amount: 9000, createdAt: ago(10) }),
      ],
      buyInMode: 'MATCH_HIGHEST',
      clubMaxBuyIn: 5000,
    });
    expect(lines(feed)).toEqual([
      'Arjun bought in for 9,000',
      'Priya bought in for 5,000',
    ]);
  });

  it('puts a rise above the buy-in that caused it, though they share a timestamp', () => {
    const feed = deriveFeed({
      session: session(),
      buyIns: [
        buyIn({ userId: 'priya', amount: 5000, createdAt: ago(40) }),
        buyIn({ userId: 'arjun', amount: 3000, createdAt: ago(30) }),
        buyIn({ userId: 'arjun', amount: 5000, createdAt: ago(10) }),
      ],
      buyInMode: 'MATCH_HIGHEST',
      clubMaxBuyIn: 5000,
    });
    expect(lines(feed).slice(0, 2)).toEqual([
      'Max buy-in is now 8,000',
      'Arjun bought another 5,000',
    ]);
  });

  it('stays quiet when a buy-in does not move the limit at all', () => {
    const feed = deriveFeed({
      session: session(),
      buyIns: [
        buyIn({ userId: 'priya', amount: 9000, createdAt: ago(30) }),
        buyIn({ userId: 'arjun', amount: 3000, createdAt: ago(10) }),
      ],
      buyInMode: 'MATCH_HIGHEST',
      clubMaxBuyIn: 5000,
    });
    expect(lines(feed).filter((l) => /max buy-in/i.test(l))).toHaveLength(0);
  });

  it('says nothing about a ceiling a club does not have', () => {
    const feed = deriveFeed({
      session: session(),
      buyIns: [buyIn({ userId: 'priya', amount: 9000, createdAt: ago(30) })],
      buyInMode: 'UNCAPPED',
    });
    expect(lines(feed).some((l) => /max buy-in/i.test(l))).toBe(false);
  });
});

describe('ordering and length', () => {
  it('puts the newest at the top', () => {
    const feed = deriveFeed({
      session: session(),
      buyIns: [
        buyIn({ userId: 'priya', amount: 3000, createdAt: ago(40) }),
        buyIn({ userId: 'arjun', amount: 3000, createdAt: ago(5) }),
      ],
      buyInMode: 'UNCAPPED',
    });
    expect(lines(feed)[0]).toMatch(/Arjun/);
  });

  it('drops the start of the evening rather than growing forever', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      buyIn({ userId: `u${i}`, amount: 1000, createdAt: ago(200 - i) })
    );
    expect(deriveFeed({ session: session(), buyIns: many, buyInMode: 'UNCAPPED' })).toHaveLength(30);
    expect(deriveFeed({ session: session(), buyIns: many, buyInMode: 'UNCAPPED', limit: 5 })).toHaveLength(5);
  });

  it('has nothing to tell before a night starts', () => {
    expect(deriveFeed({ session: null, buyIns: [buyIn()] })).toEqual([]);
  });

  it('ignores buy-ins belonging to a different session', () => {
    const feed = deriveFeed({
      session: session(),
      buyIns: [buyIn({ sessionId: 'other', userId: 'priya', createdAt: ago(3) })],
    });
    expect(feed).toEqual([]);
  });
});

describe('it is your view of the night', () => {
  it('speaks to you in the second person', () => {
    const events = deriveFeed({
      session: session({
        cashOuts: [{ userId: 'me', amount: 7200, status: 'confirmed', requestedAt: ago(1) }],
      }),
      buyIns: [
        buyIn({ userId: 'me', amount: 3000, createdAt: ago(30) }),
        buyIn({ userId: 'me', amount: 2000, createdAt: ago(20) }),
      ],
      buyInMode: 'UNCAPPED',
    });
    expect(lines(events)).toEqual([
      'You left the table with 7,200',
      'You bought another 2,000',
      'You bought in for 3,000',
    ]);
  });

  it('speaks about everyone else in the third', () => {
    const events = deriveFeed({
      session: session(),
      buyIns: [buyIn({ userId: 'arjun', amount: 3000, createdAt: ago(30) })],
      buyInMode: 'UNCAPPED',
    });
    expect(lines(events)).toEqual(['Arjun bought in for 3,000']);
  });
});

describe('how long ago', () => {
  it('is coarse, because the feed is glanced at rather than read', () => {
    expect(agoLabel(new Date(NOW - 3_000).toISOString(), NOW)).toBe('just now');
    expect(agoLabel(new Date(NOW - 18_000).toISOString(), NOW)).toBe('18 sec ago');
    expect(agoLabel(new Date(NOW - 90_000).toISOString(), NOW)).toBe('1 min ago');
    expect(agoLabel(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3h 0m ago');
  });

  it('says nothing rather than NaN when a timestamp is unusable', () => {
    expect(agoLabel('not a date', NOW)).toBe('');
  });
});

/**
 * The clock, as things that happened.
 *
 * A timer changing under you is confusing unless the feed says why: the
 * scheduled hour ran out, somebody added thirty minutes, the host decided to
 * carry on. These are the events that explain a number nobody touched.
 */
describe('why the timer changed', () => {
  it('says nothing at all about a night with no limit', () => {
    const feed = deriveFeed({ session: session(), buyIns: [], now: NOW });
    expect(lines(feed).some((l) => /timer|session/i.test(l))).toBe(false);
  });

  it('names the length a timed night started with', () => {
    const feed = deriveFeed({
      session: session({ startedPlayingAt: ago(30), durationMinutes: 120 }),
      buyIns: [],
      now: NOW,
    });
    expect(lines(feed)).toContain('Session started (2-hour timer)');
  });

  it('names each extension, rather than silently showing a bigger number', () => {
    const feed = deriveFeed({
      session: session({
        startedPlayingAt: ago(130),
        durationMinutes: 120,
        timeExtensions: [{ minutes: 30, at: ago(5) }],
      }),
      buyIns: [],
      now: NOW,
    });
    expect(lines(feed)).toContain('Session extended by 30 minutes');
  });

  it('marks the scheduled end only once it has actually passed', () => {
    const early = deriveFeed({
      session: session({ startedPlayingAt: ago(30), durationMinutes: 120 }),
      buyIns: [],
      now: NOW,
    });
    expect(lines(early)).not.toContain('Scheduled time reached');

    const late = deriveFeed({
      session: session({ startedPlayingAt: ago(130), durationMinutes: 120 }),
      buyIns: [],
      now: NOW,
    });
    expect(lines(late)).toContain('Scheduled time reached');
  });

  it('records the moment the host decided the plan was over', () => {
    const feed = deriveFeed({
      session: session({
        startedPlayingAt: ago(130),
        durationMinutes: 120,
        timeLimitLiftedAt: ago(2),
      }),
      buyIns: [],
      now: NOW,
    });
    expect(lines(feed)[0]).toBe('Session continued without a time limit');
  });
});
