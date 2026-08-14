/**
 * The seat fee and the winners' cut, told apart.
 *
 * `rakeDeduction` summed two different charges and could not be separated
 * afterwards (SETTLEMENT-REVIEW.md finding 11). A player who wanted to know how
 * much of their deduction was the table fee could not be told, and the
 * settlement audit specified in SETTLEMENT-HISTORY-DESIGN.md §8 asks for rake
 * and cut differences as separate columns.
 *
 * The split is a REPORTING change, not an arithmetic one. Two things have to be
 * true at once, and each has its own test below:
 *
 *   1. the parts always sum to the whole, at every rounding rule
 *   2. no total moved — which the golden fixtures already prove, since
 *      `canonicalise` compares rakeDeduction and the digests are unchanged
 */

import { describe, expect, it } from 'vitest';
import {
  computeSettlement,
  computeSettlementAt,
  EngineVersion,
  SettlementSettings,
  RoundingRule,
} from './settlementEngine.js';

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

describe('the parts sum to the whole', () => {
  const shapes: [string, [number, number][]][] = [
    ['reconciled', [[5000, 8000], [5000, 2000]]],
    ['over-declared', [[5000, 9000], [5000, 3000], [5000, 3500]]],
    ['under-declared', [[5000, 4000], [5000, 3000], [5000, 2000]]],
    ['fee does not divide', [[5000, 6000], [5000, 5000], [5000, 4000]]],
    ['one busted', [[5000, 0], [5000, 10000]]],
  ];

  for (const version of [1, 2, 3] as EngineVersion[]) {
    for (const roundingRule of ['NONE', 'NEAREST_1', 'NEAREST_5', 'NEAREST_10'] as RoundingRule[]) {
      it(`holds for v${version} at ${roundingRule}`, () => {
        let checked = 0;
        for (const [, pairs] of shapes) {
          for (const fee of [0, 100, 333, 1000]) {
            for (const cut of [0, 5, 12.5]) {
              const r = computeSettlementAt(version, table(pairs), rules({
                sessionRakeAmount: fee,
                winnersCutPercent: cut,
                roundingRule,
              }));
              for (const p of r.players) {
                // Money precision, not bit precision. `totalRakeCollected` is
                // summed without rounding in runRake, so it can carry float
                // noise like 225.00000000000003 — a pre-existing artifact this
                // step deliberately does not change, since the value is stored
                // and changing it would move a settled figure. Recorded in the
                // final test in this file rather than smoothed over here.
                expect(p.seatFee + p.winnersCut).toBeCloseTo(p.rakeDeduction, 2);
                expect(p.seatFee).toBeGreaterThanOrEqual(0);
                expect(p.winnersCut).toBeGreaterThanOrEqual(0);
                checked += 1;
              }
              expect(r.totalSeatFees + r.totalWinnersCut).toBeCloseTo(r.totalRakeCollected, 2);
            }
          }
        }
        expect(checked).toBeGreaterThan(100);
      });
    }
  }
});

describe('each part is the charge it says it is', () => {
  it('a seat fee with no cut is all seat fee', () => {
    const r = computeSettlement(table([[5000, 8000], [5000, 2000]]), rules({ sessionRakeAmount: 500 }));
    expect(r.players.map((p) => p.seatFee)).toEqual([500, 500]);
    expect(r.players.map((p) => p.winnersCut)).toEqual([0, 0]);
    expect(r.totalSeatFees).toBe(1000);
    expect(r.totalWinnersCut).toBe(0);
  });

  it('a cut with no seat fee is all cut, and only winners pay it', () => {
    const r = computeSettlement(table([[5000, 8000], [5000, 2000]]), rules({ winnersCutPercent: 10 }));
    expect(r.players[0].winnersCut).toBe(300); // 10% of a 3,000 profit
    expect(r.players[0].seatFee).toBe(0);
    expect(r.players[1].winnersCut).toBe(0); // the loser
    expect(r.totalWinnersCut).toBe(300);
    expect(r.totalSeatFees).toBe(0);
  });

  it('separates them when both are charged', () => {
    const r = computeSettlement(
      table([[5000, 8000], [5000, 2000]]),
      rules({ sessionRakeAmount: 200, winnersCutPercent: 10 })
    );
    // The winner pays both; the loser pays only the chair.
    expect(r.players[0]).toMatchObject({ seatFee: 200, winnersCut: 300, rakeDeduction: 500 });
    expect(r.players[1]).toMatchObject({ seatFee: 200, winnersCut: 0, rakeDeduction: 200 });
  });

  it('v1 reports its divided share as the seat fee, remainder and all', () => {
    // 100 across three is 33.33, 33.33, 33.34 — and the last seat's extra cent
    // is a seat fee, not a cut.
    const r = computeSettlementAt(1, table([[5000, 6000], [5000, 5000], [5000, 4000]]), rules({ sessionRakeAmount: 100 }));
    expect(r.players.map((p) => p.seatFee)).toEqual([33.33, 33.33, 33.34]);
    expect(r.players.map((p) => p.winnersCut)).toEqual([0, 0, 0]);
    expect(r.totalSeatFees).toBe(100);
  });
});

describe('the refund comes off the cut before the chair', () => {
  it('reduces the winners cut first when a winner would go below break-even', () => {
    /*
     * RAKE_FIRST charges the cut on gross profit, then the mismatch reverses
     * that profit — so the refund pass claws the rake back. The chair still
     * costs what it costs, so the cut is what should give way.
     */
    const r = computeSettlement(
      table([[5000, 8000], [5000, 2000], [5000, 2500]]),
      rules({ sessionRakeAmount: 200, winnersCutPercent: 20, rakeOrder: 'RAKE_FIRST' })
    );

    const winner = r.players[0];
    expect(winner.grossProfit).toBeGreaterThan(0);
    // Whatever the refund took, the invariant survives and the chair is intact
    // while any cut remains.
    expect(winner.seatFee + winner.winnersCut).toBeCloseTo(winner.rakeDeduction, 2);
    if (winner.rakeDeduction >= 200) expect(winner.seatFee).toBe(200);
  });

  it('caps the seat fee at the total when a refund eats into it', () => {
    // A winner whose whole profit is reversed keeps no rake at all, so neither
    // part may exceed what remains.
    const r = computeSettlement(
      table([[1000, 9000], [1000, 1000], [1000, 1000]]),
      rules({ sessionRakeAmount: 5000, winnersCutPercent: 50, rakeOrder: 'RAKE_FIRST' })
    );
    for (const p of r.players) {
      expect(p.seatFee).toBeLessThanOrEqual(p.rakeDeduction);
      expect(p.seatFee + p.winnersCut).toBeCloseTo(p.rakeDeduction, 2);
    }
  });
});

describe('nothing else moved', () => {
  it('rakeDeduction, netResult and the pot are untouched by the split', () => {
    // Belt and braces alongside the golden fixtures: the fields that existed
    // before still hold the values they held, computed the long way round.
    const r = computeSettlement(
      table([[5000, 9000], [5000, 3000], [5000, 3500]]),
      rules({ sessionRakeAmount: 333, winnersCutPercent: 12, roundingRule: 'NEAREST_5' })
    );
    for (const p of r.players) {
      expect(p.netResult).toBe(p.grossProfit - p.mismatchDeduction - p.rakeDeduction);
    }
    expect(r.totalRakeCollected).toBeCloseTo(
      r.players.reduce((s, p) => s + p.rakeDeduction, 0),
      2
    );
    expect(r.players.reduce((s, p) => s + p.netResult, 0) + r.potContribution).toBeCloseTo(0, 2);
  });
});

describe('a pre-existing artifact, recorded rather than fixed', () => {
  it('totalRakeCollected is summed without rounding and can carry float noise', () => {
    /*
     * `runRake` ends with `working.reduce((s, p) => s + p.rakeDeduction, 0)` and
     * no rounding, so three shares of 75.00000000000001 come out as
     * 225.00000000000003. The refund pass rounds it, but only when a refund
     * actually happens.
     *
     * Left alone ON PURPOSE. It is stored in `CashOutSettlement.rakeCollected`,
     * so rounding it here would move a figure that settled nights already
     * carry — a behaviour change, which belongs to a new engine version and not
     * to a reporting change. Written down so the next person finds a decision
     * rather than a mystery.
     */
    const noisy = computeSettlementAt(1, table([[5000, 6000], [5000, 5000], [5000, 4000]]), rules({
      sessionRakeAmount: 100,
      winnersCutPercent: 12.5,
    }));

    // Pinned to the actual value, so this test fails the day somebody rounds
    // the total — which is a behaviour change and should have to be noticed.
    expect(noisy.totalRakeCollected).toBe(225.00000000000003);
    expect(noisy.totalRakeCollected).not.toBe(225);

    // The split, derived from the per-player figures, is clean.
    expect(noisy.totalSeatFees).toBe(100);
    expect(noisy.totalWinnersCut).toBe(125);
  });
});
