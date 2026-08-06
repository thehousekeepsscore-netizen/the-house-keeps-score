import { describe, it, expect } from 'vitest';
import { deriveNight, msRemaining, REQUEST_TTL_MS, NightInput } from './night-state';
import { PokerSession, BuyInRequest } from '../types';

/**
 * The spine of the live session screen.
 *
 * Every one of these cases came from a real night in IA-PRESSURE-TEST.md §5,
 * not from enumerating the type. The ones that matter most are the ordering
 * rules — a seat has exactly one state, and the state that wins is the one
 * that has a question attached to it.
 */

const NOW = Date.parse('2026-08-06T21:00:00.000Z');
const ago = (mins: number) => new Date(NOW - mins * 60_000).toISOString();

function session(over: Partial<PokerSession> = {}): PokerSession {
  return {
    id: 's1',
    clubId: 'c1',
    sessionName: 'Fri 8 Aug',
    status: 'active',
    activePlayerUids: [],
    pendingSitInUids: [],
    sitInRequestedAt: {},
    cashOuts: [],
    startedBy: 'host',
    createdAt: ago(200),
    ...over,
  };
}

function buyIn(over: Partial<BuyInRequest> = {}): BuyInRequest {
  return {
    id: `b${Math.random().toString(36).slice(2, 7)}`,
    sessionId: 's1',
    clubId: 'c1',
    userId: 'u1',
    userDisplayName: '',
    amount: 3000,
    status: 'approved',
    requestedBy: 'u1',
    createdAt: ago(60),
    ...over,
  };
}

function derive(over: Partial<NightInput> = {}) {
  return deriveNight({
    session: session(),
    buyIns: [],
    currentUserId: 'host',
    isAdmin: true,
    now: NOW,
    ...over,
  });
}

describe('phases', () => {
  it('is dark with no session', () => {
    expect(derive({ session: null }).phase).toBe('dark');
  });

  it('is opening while nobody has chips yet', () => {
    // The arrival phase the old screen had no concept of: everyone is walking
    // in, nobody is banked, and a scoreboard of zeros is the wrong answer.
    expect(derive({ session: session({ activePlayerUids: ['a', 'b'] }) }).phase).toBe('opening');
  });

  it('is running once a buy-in is approved', () => {
    const night = derive({
      session: session({ activePlayerUids: ['a'] }),
      buyIns: [buyIn({ userId: 'a' })],
    });
    expect(night.phase).toBe('running');
  });

  it('is winding down after the first confirmed cash-out, while others play on', () => {
    const night = derive({
      session: session({
        activePlayerUids: ['a'],
        cashOuts: [{ userId: 'b', amount: 5000, status: 'confirmed', requestedAt: ago(5) }],
      }),
      buyIns: [buyIn({ userId: 'a' }), buyIn({ userId: 'b' })],
    });
    expect(night.phase).toBe('windingDown');
  });

  it('is ready only when the table is empty', () => {
    const night = derive({
      session: session({
        activePlayerUids: [],
        cashOuts: [
          { userId: 'a', amount: 4000, status: 'confirmed', requestedAt: ago(9) },
          { userId: 'b', amount: 5000, status: 'confirmed', requestedAt: ago(5) },
        ],
      }),
      buyIns: [buyIn({ userId: 'a' }), buyIn({ userId: 'b' })],
    });
    expect(night.phase).toBe('ready');
    expect(night.canSettle).toBe(true);
    expect(night.settleBlockedReason).toBeNull();
  });

  it('is closed once settled', () => {
    expect(derive({ session: session({ status: 'settled' }) }).phase).toBe('closed');
  });

  it('blocks settling a one-player night, and says why before the form is filled', () => {
    // The server rejects this. The old screen only found out on submit, after
    // the admin had entered every figure.
    const night = derive({
      session: session({
        activePlayerUids: [],
        cashOuts: [{ userId: 'a', amount: 4000, status: 'confirmed', requestedAt: ago(5) }],
      }),
      buyIns: [buyIn({ userId: 'a' })],
    });
    expect(night.phase).toBe('ready');
    expect(night.canSettle).toBe(false);
    expect(night.settleBlockedReason).toMatch(/two players/i);
  });
});

describe('seat state', () => {
  it('calls a seated player with no bank "seated, no chips", not zero chips', () => {
    // The bug this replaces: the old screen rendered this player as
    // "Arjun · 0 Chips", which is true and useless.
    const night = derive({ session: session({ activePlayerUids: ['a'] }) });
    expect(night.seats[0]).toMatchObject({ userId: 'a', state: 'seatedNoChips', totalBuyIn: 0 });
  });

  it('sums multiple buy-ins into one bank', () => {
    const night = derive({
      session: session({ activePlayerUids: ['a'] }),
      buyIns: [buyIn({ userId: 'a', amount: 5000 }), buyIn({ userId: 'a', amount: 3000 })],
    });
    expect(night.seats[0]).toMatchObject({ state: 'inPlay', totalBuyIn: 8000 });
  });

  it('a pending buy-in never masquerades as a chip count', () => {
    const night = derive({
      session: session({ activePlayerUids: ['a'] }),
      buyIns: [buyIn({ userId: 'a', amount: 3000, status: 'pending' })],
    });
    // Still no chips — the request is a question, not a bank.
    expect(night.seats[0]).toMatchObject({ state: 'seatedNoChips', totalBuyIn: 0, pendingBuyIn: 3000 });
  });

  it('counting out outranks being in play', () => {
    const night = derive({
      session: session({
        activePlayerUids: ['a'],
        cashOuts: [{ userId: 'a', amount: 8200, status: 'pending', requestedAt: ago(1) }],
      }),
      buyIns: [buyIn({ userId: 'a', amount: 5000 })],
    });
    expect(night.seats[0]).toMatchObject({ state: 'countingOut', pendingCashOut: 8200, totalBuyIn: 5000 });
  });

  it('waiting to sit outranks everything — they are not at the table yet', () => {
    const night = derive({
      session: session({ pendingSitInUids: ['a'], sitInRequestedAt: { a: ago(1) } }),
    });
    expect(night.seats[0].state).toBe('waitingToSit');
  });

  it('keeps a cashed-out player in the night, and in the settlement set', () => {
    const night = derive({
      session: session({
        activePlayerUids: ['b'],
        cashOuts: [{ userId: 'a', amount: 4000, status: 'confirmed', requestedAt: ago(9) }],
      }),
      buyIns: [buyIn({ userId: 'a' }), buyIn({ userId: 'b' })],
    });
    expect(night.seats.find((s) => s.userId === 'a')).toMatchObject({
      state: 'cashedOut',
      confirmedCashOut: 4000,
    });
    // They left the seat list but the night still settles them.
    expect(night.playersAtTable).toBe(1);
    expect(night.settlementUids.sort()).toEqual(['a', 'b']);
  });
});

describe('chips in play', () => {
  it('counts approved buy-ins less confirmed cash-outs', () => {
    const night = derive({
      session: session({
        activePlayerUids: ['b'],
        cashOuts: [{ userId: 'a', amount: 4000, status: 'confirmed', requestedAt: ago(9) }],
      }),
      buyIns: [buyIn({ userId: 'a', amount: 5000 }), buyIn({ userId: 'b', amount: 5000 })],
    });
    // 10,000 bought in, 4,000 walked out of the door.
    expect(night.chipsInPlay).toBe(6000);
  });

  it('ignores pending and rejected buy-ins', () => {
    const night = derive({
      session: session({ activePlayerUids: ['a'] }),
      buyIns: [
        buyIn({ userId: 'a', amount: 5000 }),
        buyIn({ userId: 'a', amount: 9000, status: 'pending' }),
        buyIn({ userId: 'a', amount: 7000, status: 'rejected' }),
      ],
    });
    expect(night.chipsInPlay).toBe(5000);
  });
});

describe('the queue', () => {
  it('is oldest first across all three kinds', () => {
    const night = derive({
      session: session({
        activePlayerUids: ['a', 'b'],
        pendingSitInUids: ['c'],
        sitInRequestedAt: { c: ago(3) },
        cashOuts: [{ userId: 'b', amount: 8200, status: 'pending', requestedAt: ago(1) }],
      }),
      buyIns: [buyIn({ userId: 'a', status: 'pending', createdAt: ago(4) })],
    });
    expect(night.queue.map((q) => q.kind)).toEqual(['buy-in', 'sit-in', 'cash-out']);
  });

  it('is empty when nothing is pending, so the screen can drop the section entirely', () => {
    const night = derive({
      session: session({ activePlayerUids: ['a'] }),
      buyIns: [buyIn({ userId: 'a' })],
    });
    expect(night.queue).toEqual([]);
  });

  it('shows an admin everyone, and a player only themselves', () => {
    const input = {
      session: session({ activePlayerUids: ['a', 'b'] }),
      buyIns: [
        buyIn({ userId: 'a', status: 'pending', createdAt: ago(4) }),
        buyIn({ userId: 'b', status: 'pending', createdAt: ago(2) }),
      ],
    };
    expect(derive({ ...input, isAdmin: true }).queue).toHaveLength(2);
    expect(derive({ ...input, isAdmin: false, currentUserId: 'b' }).queue).toMatchObject([
      { userId: 'b' },
    ]);
  });

  it('carries the time remaining before the server auto-rejects', () => {
    const night = derive({
      session: session({ activePlayerUids: ['a'] }),
      buyIns: [buyIn({ userId: 'a', status: 'pending', createdAt: ago(4) })],
    });
    // Four minutes gone of a five-minute window.
    expect(night.queue[0].msRemaining).toBe(60_000);
  });

  it('floors the countdown at zero rather than going negative', () => {
    const night = derive({
      session: session({ activePlayerUids: ['a'] }),
      buyIns: [buyIn({ userId: 'a', status: 'pending', createdAt: ago(9) })],
    });
    expect(night.queue[0].msRemaining).toBe(0);
  });

  it('sorts a request with no timestamp last instead of first', () => {
    // Date.parse(undefined) is NaN, and NaN comparisons would leave the order
    // to the sort's whim — putting an unknown at the top of a queue whose whole
    // purpose is "who has waited longest".
    const night = derive({
      session: session({
        activePlayerUids: ['a'],
        pendingSitInUids: ['c'],
        sitInRequestedAt: {},
      }),
      buyIns: [buyIn({ userId: 'a', status: 'pending', createdAt: ago(1) })],
    });
    expect(night.queue.map((q) => q.kind)).toEqual(['buy-in', 'sit-in']);
    expect(night.queue[1].msRemaining).toBeNull();
  });
});

describe('msRemaining', () => {
  it('is null without a timestamp', () => {
    expect(msRemaining(undefined, NOW)).toBeNull();
  });

  it('is null for an unparseable timestamp', () => {
    expect(msRemaining('not a date', NOW)).toBeNull();
  });

  it('is the full window at the moment of asking', () => {
    expect(msRemaining(new Date(NOW).toISOString(), NOW)).toBe(REQUEST_TTL_MS);
  });
});

describe('the viewer', () => {
  it('finds their own seat', () => {
    const night = derive({
      session: session({ activePlayerUids: ['host', 'a'] }),
      buyIns: [buyIn({ userId: 'host', amount: 5000 })],
      currentUserId: 'host',
    });
    expect(night.mySeat).toMatchObject({ userId: 'host', totalBuyIn: 5000 });
  });

  it('has no seat when they are not in the night', () => {
    const night = derive({
      session: session({ activePlayerUids: ['a'] }),
      currentUserId: 'nobody',
    });
    expect(night.mySeat).toBeNull();
  });
});
