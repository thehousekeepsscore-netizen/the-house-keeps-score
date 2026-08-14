/**
 * The versioned replay has to be trustworthy before the audit's verdicts are.
 *
 * Two claims, and the audit rests on both:
 *
 *   1. `computeSettlementAt(3, …)` is the live engine — not a copy that agrees
 *      today. It delegates, and this proves the delegation covers every field
 *      over a cross product rather than a happy path.
 *   2. Each divergence moves the number git says it moves, and nothing else.
 *
 * When step 2 replaces this file with real dispatch, these tests move with it.
 */

import { describe, expect, it } from 'vitest';
import { computeSettlement, SettlementSettings } from '../offlineSessions/settlementEngine.js';
import { computeSettlementAt, EngineVersion } from './versionedEngine.js';

const rules = (over: Partial<SettlementSettings> = {}): SettlementSettings => ({
  sessionRakeAmount: 0,
  winnersCutPercent: 0,
  rakeEnabled: false,
  rakeMethod: 'PERCENT_PROFIT',
  rakeValue: 0,
  potEnabled: true,
  mismatchStrategy: 'PROPORTIONAL_WINNERS',
  rakeOrder: 'MISMATCH_FIRST',
  winnerDefinition: 'PROFIT_POSITIVE',
  winnerTopN: 1,
  roundingRule: 'NONE',
  ...over,
});

const table = (pairs: [number, number][]) =>
  pairs.map(([buyIn, cashOut], i) => ({
    userId: `u${i}`,
    userDisplayName: `P${i}`,
    buyIn,
    cashOut,
  }));

const TABLES: [string, ReturnType<typeof table>][] = [
  ['balanced pair', table([[5000, 8000], [5000, 2000]])],
  ['three, over-declared', table([[5000, 9000], [5000, 3000], [5000, 3500]])],
  ['three, under-declared', table([[5000, 4000], [5000, 3000], [5000, 2000]])],
  ['five, mixed', table([[2000, 5000], [2000, 1000], [3000, 0], [1000, 1500], [4000, 4500]])],
  ['everyone flat', table([[1000, 1000], [1000, 1000], [1000, 1000]])],
];

describe('computeSettlementAt(3) is the live engine', () => {
  const settings: SettlementSettings[] = [];
  for (const strategy of ['PROPORTIONAL_WINNERS', 'EQUAL_WINNERS', 'EQUAL_ALL', 'SHORTFALL_TO_POT', 'EXCESS_FROM_POT'] as const)
    for (const order of ['MISMATCH_FIRST', 'RAKE_FIRST'] as const)
      for (const rounding of ['NONE', 'NEAREST_1', 'NEAREST_5', 'NEAREST_10'] as const)
        for (const potEnabled of [true, false])
          settings.push(rules({ mismatchStrategy: strategy, rakeOrder: order, roundingRule: rounding, potEnabled, sessionRakeAmount: 300, winnersCutPercent: 10 }));

  it('matches field for field across the cross product', () => {
    let compared = 0;
    for (const [, players] of TABLES) {
      for (const s of settings) {
        const opts = { currentPotBalance: 10_000, mismatchAcknowledged: true };
        expect(computeSettlementAt(3, players, s, opts)).toEqual(computeSettlement(players, s, opts));
        compared += 1;
      }
    }
    // A silently empty loop would pass the assertion above and prove nothing.
    expect(compared).toBe(TABLES.length * settings.length);
    expect(compared).toBeGreaterThan(300);
  });
});

describe('divergence 1 — the flat rake (v1 → v2)', () => {
  const players = table([[5000, 6000], [5000, 5000], [5000, 4000]]);
  const s = rules({ sessionRakeAmount: 900, potEnabled: true });

  it('v1 splits the fee across the table, v2 and v3 charge it per head', () => {
    const v1 = computeSettlementAt(1, players, s);
    const v2 = computeSettlementAt(2, players, s);
    const v3 = computeSettlementAt(3, players, s);

    expect(v1.totalRakeCollected).toBe(900);
    expect(v2.totalRakeCollected).toBe(2700);
    expect(v3.totalRakeCollected).toBe(2700);
    expect(v1.players.map((p) => p.rakeDeduction)).toEqual([300, 300, 300]);
    expect(v2.players.map((p) => p.rakeDeduction)).toEqual([900, 900, 900]);
  });

  it('v1 gives the indivisible remainder to the LAST player, so order is arithmetic', () => {
    const odd = rules({ sessionRakeAmount: 100, potEnabled: true });
    const forward = computeSettlementAt(1, players, odd);
    const reversed = computeSettlementAt(1, [...players].reverse(), odd);

    // 100 across 3 is 33.33, 33.33 and the rest.
    expect(forward.players.map((p) => p.rakeDeduction)).toEqual([33.33, 33.33, 33.34]);

    const byId = (r: typeof forward) =>
      Object.fromEntries(r.players.map((p) => [p.userId, p.rakeDeduction]));
    expect(byId(forward)).not.toEqual(byId(reversed));
  });

  it('v2 and v3 divide nothing, so seat order changes no figure', () => {
    for (const v of [2, 3] as EngineVersion[]) {
      const byId = (players_: typeof players) =>
        Object.fromEntries(computeSettlementAt(v, players_, s).players.map((p) => [p.userId, p.rakeDeduction]));
      expect(byId(players)).toEqual(byId([...players].reverse()));
    }
  });
});

describe('divergence 2 — no pot, no rake (v2 → v3)', () => {
  const players = table([[5000, 8000], [5000, 2000]]);
  const s = rules({ sessionRakeAmount: 300, winnersCutPercent: 10, potEnabled: false });

  it('v1 and v2 take money the pot cannot receive; v3 takes nothing', () => {
    const v1 = computeSettlementAt(1, players, s);
    const v2 = computeSettlementAt(2, players, s);
    const v3 = computeSettlementAt(3, players, s);

    expect(v1.totalRakeCollected).toBeGreaterThan(0);
    expect(v2.totalRakeCollected).toBeGreaterThan(0);
    expect(v3.totalRakeCollected).toBe(0);

    const books = (r: typeof v1) => r.players.reduce((sum, p) => sum + p.netResult, 0) + r.potContribution;
    expect(books(v1)).toBeLessThan(0); // the leak PR #21 closed
    expect(books(v2)).toBeLessThan(0);
    expect(books(v3)).toBe(0);
  });

  it('is the ONLY difference between v2 and v3 — with a pot, they agree', () => {
    const withPot = rules({ sessionRakeAmount: 300, winnersCutPercent: 10, potEnabled: true });
    for (const [, t] of TABLES) {
      expect(computeSettlementAt(2, t, withPot)).toEqual(computeSettlementAt(3, t, withPot));
    }
  });
});

describe('what did NOT change across versions', () => {
  it('winners, mismatch and rounding are identical in all three', () => {
    const s = rules({ mismatchStrategy: 'EQUAL_WINNERS', roundingRule: 'NEAREST_5', potEnabled: true });
    for (const [, t] of TABLES) {
      const [a, b, c] = ([1, 2, 3] as EngineVersion[]).map((v) => computeSettlementAt(v, t, s));
      expect(a.players.map((p) => p.mismatchDeduction)).toEqual(b.players.map((p) => p.mismatchDeduction));
      expect(b.players.map((p) => p.mismatchDeduction)).toEqual(c.players.map((p) => p.mismatchDeduction));
      expect(a.players.map((p) => p.isWinner)).toEqual(c.players.map((p) => p.isWinner));
    }
  });
});
