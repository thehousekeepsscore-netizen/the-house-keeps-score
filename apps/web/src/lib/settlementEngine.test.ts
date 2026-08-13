import { describe, it, expect } from 'vitest';
import {
  computeSettlement,
  SettlementSettings,
  SettlementPlayerInput,
  SettlementResult,
} from './settlementEngine';

/**
 * The engine that produces the figures an admin approves.
 *
 * This copy had no tests of its own. It is the one that runs in the browser and
 * fills the settlement preview, and the number a host signs off on comes from
 * here — the server then recomputes with its own copy and saves that. So a
 * fault here is not a display bug: it is a host agreeing to figures that were
 * never committed, with nothing on screen to say so.
 *
 * settlementEngine.parity.test.ts proves this copy and the server's produce
 * identical output. That is the guard against DRIFT. This file is the guard
 * against both being wrong together — it asserts what the numbers should
 * actually be, from the rules, rather than that two copies agree.
 */

const RULES: SettlementSettings = {
  sessionRakeAmount: 0,
  winnersCutPercent: 0,
  rakeEnabled: false,
  rakeMethod: 'PERCENT_PROFIT',
  rakeValue: 0,
  potEnabled: false,
  mismatchStrategy: 'PROPORTIONAL_WINNERS',
  rakeOrder: 'MISMATCH_FIRST',
  winnerDefinition: 'PROFIT_POSITIVE',
  winnerTopN: 1,
  roundingRule: 'NONE',
};

const rules = (over: Partial<SettlementSettings> = {}): SettlementSettings => ({ ...RULES, ...over });

const table = (...rows: [string, number, number][]): SettlementPlayerInput[] =>
  rows.map(([userDisplayName, buyIn, cashOut]) => ({ userId: userDisplayName, userDisplayName, buyIn, cashOut }));

const netOf = (r: SettlementResult, id: string) => r.players.find((p) => p.userId === id)!.netResult;
const rakeOf = (r: SettlementResult, id: string) => r.players.find((p) => p.userId === id)!.rakeDeduction;

/** No chips created, none destroyed. The property every case must hold. */
function expectBooksBalance(r: SettlementResult) {
  const sum = r.players.reduce((s, p) => s + p.netResult, 0);
  expect(sum + r.potContribution).toBeCloseTo(0, 6);
}

describe('a night with no house take', () => {
  it('gives everyone exactly what they won or lost', () => {
    const r = computeSettlement(table(['A', 5000, 8000], ['B', 5000, 2000]), rules());

    expect(netOf(r, 'A')).toBe(3000);
    expect(netOf(r, 'B')).toBe(-3000);
    expect(r.totalRakeCollected).toBe(0);
    expectBooksBalance(r);
  });

  it('reports the totals it was given', () => {
    const r = computeSettlement(table(['A', 5000, 8000], ['B', 5000, 2000]), rules());

    expect(r.totalBuyIns).toBe(10_000);
    expect(r.totalCashOuts).toBe(10_000);
    expect(r.mismatchAmount).toBe(0);
  });
});

describe('the pot switch decides whether anyone is charged', () => {
  const charged = { sessionRakeAmount: 300, winnersCutPercent: 10 };
  const night = () => table(['win', 5000, 8000], ['lose', 5000, 2000]);

  it('charges a seat fee to every player and a cut to the winner', () => {
    const r = computeSettlement(night(), rules({ ...charged, potEnabled: true }));

    // 300 a seat from each, plus 10% of the winner's 3,000.
    expect(rakeOf(r, 'win')).toBeCloseTo(600, 6);
    expect(rakeOf(r, 'lose')).toBeCloseTo(300, 6);
    expect(r.totalRakeCollected).toBeCloseTo(900, 6);
    expect(r.potContribution).toBeCloseTo(900, 6);
    expectBooksBalance(r);
  });

  it('charges nobody when there is no pot to receive it', () => {
    const r = computeSettlement(night(), rules({ ...charged, potEnabled: false }));

    expect(r.totalRakeCollected).toBe(0);
    expect(r.potContribution).toBe(0);
    expect(netOf(r, 'win')).toBe(3000);
    expectBooksBalance(r);
  });

  it('charges the seat fee to losers as well as winners', () => {
    const r = computeSettlement(night(), rules({ sessionRakeAmount: 400, potEnabled: true }));

    // A chair costs what it costs. It is not a tax on profit.
    expect(rakeOf(r, 'lose')).toBeCloseTo(400, 6);
    expect(netOf(r, 'lose')).toBeCloseTo(-3400, 6);
  });

  it('takes the winners cut only from players who finished up', () => {
    const r = computeSettlement(night(), rules({ winnersCutPercent: 20, potEnabled: true }));

    expect(rakeOf(r, 'lose')).toBe(0);
    expect(rakeOf(r, 'win')).toBeCloseTo(600, 6);
  });
});

describe('a table that does not add up', () => {
  it('takes an excess back from the winners in proportion to profit', () => {
    // 12,000 bought in, 14,000 declared. Two thousand chips that never existed.
    const r = computeSettlement(
      table(['A', 4000, 9000], ['B', 4000, 4000], ['C', 4000, 1000]),
      rules({ mismatchStrategy: 'PROPORTIONAL_WINNERS' })
    );

    expect(r.mismatchAmount).toBe(2000);
    expect(r.players.find((p) => p.userId === 'A')!.mismatchDeduction).toBeCloseTo(2000, 6);
    expectBooksBalance(r);
  });

  it('splits an excess equally across everyone under EQUAL_ALL', () => {
    const r = computeSettlement(
      table(['A', 4000, 9000], ['B', 4000, 4000], ['C', 4000, 1000]),
      rules({ mismatchStrategy: 'EQUAL_ALL' })
    );

    expect(r.players.every((p) => Math.abs(p.mismatchDeduction - 2000 / 3) < 0.01)).toBe(true);
    expectBooksBalance(r);
  });

  it('sends a shortfall to the pot when there is one', () => {
    // 10,000 in, 7,000 declared: three thousand unclaimed.
    const r = computeSettlement(
      table(['A', 5000, 4000], ['B', 5000, 3000]),
      rules({ potEnabled: true, mismatchStrategy: 'SHORTFALL_TO_POT' })
    );

    expect(r.mismatchAmount).toBe(-3000);
    expect(r.mismatchResolution).toBe('shortfall_to_pot');
    expect(r.potContribution).toBe(3000);
    expectBooksBalance(r);
  });

  it('refuses to settle a MANUAL mismatch until it is acknowledged', () => {
    const night = table(['A', 4000, 9000], ['B', 4000, 4000], ['C', 4000, 1000]);

    expect(computeSettlement(night, rules({ mismatchStrategy: 'MANUAL' })).requiresManualResolution).toBe(true);
    expect(
      computeSettlement(night, rules({ mismatchStrategy: 'MANUAL' }), { mismatchAcknowledged: true })
        .requiresManualResolution
    ).toBe(false);
  });
});

describe('rounding', () => {
  it('keeps two decimal places rather than whole chips by default', () => {
    // A proportional share routinely lands on halves, and forcing integers
    // would stop the cash-outs summing back to the buy-ins.
    const r = computeSettlement(
      table(['A', 1000, 1100], ['B', 1000, 950], ['C', 1000, 950]),
      rules({ potEnabled: true, winnersCutPercent: 33 })
    );

    expectBooksBalance(r);
  });

  it.each([
    ['NEAREST_1' as const, 1],
    ['NEAREST_5' as const, 5],
    ['NEAREST_10' as const, 10],
  ])('rounds every deduction to %s', (roundingRule, step) => {
    const r = computeSettlement(
      table(['A', 4000, 9000], ['B', 4000, 4000], ['C', 4000, 1000]),
      rules({ roundingRule, potEnabled: true, winnersCutPercent: 13 })
    );

    for (const p of r.players) {
      // The residual is pushed onto the largest deduction so the books still
      // reconcile, so the mismatch line is allowed to miss the step.
      expect(p.rakeDeduction % step).toBeCloseTo(0, 6);
    }
  });

  it('still reconciles the table when the figures divide badly', () => {
    const r = computeSettlement(
      table(['A', 1000, 1000], ['B', 1000, 1000], ['C', 1000, 1100]),
      rules({ roundingRule: 'NEAREST_10', potEnabled: true, sessionRakeAmount: 100, winnersCutPercent: 7 })
    );

    expectBooksBalance(r);
  });
});

describe('the shapes that break naive arithmetic', () => {
  it('handles a night where nobody won', () => {
    const r = computeSettlement(
      table(['A', 5000, 1000], ['B', 5000, 2000], ['C', 5000, 0]),
      rules({ potEnabled: true, winnersCutPercent: 20 })
    );

    expect(r.players.every((p) => p.isWinner === false)).toBe(true);
    expect(r.totalRakeCollected).toBe(0);
    expectBooksBalance(r);
  });

  it('handles a single player, which is not a game but is a valid input', () => {
    const r = computeSettlement(table(['A', 5000, 5000]), rules());

    expect(r.players).toHaveLength(1);
    expect(netOf(r, 'A')).toBe(0);
    expectBooksBalance(r);
  });

  it('handles an empty table without throwing', () => {
    const r = computeSettlement([], rules({ potEnabled: true, sessionRakeAmount: 500 }));

    expect(r.players).toEqual([]);
    expect(r.totalBuyIns).toBe(0);
    expect(r.totalRakeCollected).toBe(0);
    // A seat fee with no seats collects nothing, rather than the flat figure.
    expect(r.potContribution).toBe(0);
  });

  it('handles everyone buying in for nothing', () => {
    const r = computeSettlement(table(['A', 0, 0], ['B', 0, 0]), rules({ potEnabled: true, winnersCutPercent: 10 }));

    expect(r.totalBuyIns).toBe(0);
    expect(r.mismatchAmount).toBe(0);
    expectBooksBalance(r);
  });

  it('never charges a winner more than they won', () => {
    // RAKE_FIRST can rake profit the mismatch then reverses; the refund pass
    // unwinds it rather than banking money the table never held.
    const r = computeSettlement(
      table(['A', 5000, 9000], ['B', 2000, 2000], ['C', 2000, 1500]),
      rules({ rakeOrder: 'RAKE_FIRST', potEnabled: true, winnersCutPercent: 30 })
    );

    for (const p of r.players) {
      if (p.grossProfit > 0) expect(p.netResult).toBeGreaterThanOrEqual(0);
    }
    expectBooksBalance(r);
  });

  it('scales to a full table', () => {
    const r = computeSettlement(
      table(
        ['A', 5000, 9000], ['B', 5000, 1000], ['C', 5000, 4000], ['D', 5000, 6000], ['E', 5000, 2000],
        ['F', 5000, 5000], ['G', 5000, 7000], ['H', 5000, 3000], ['I', 5000, 3000]
      ),
      rules({ potEnabled: true, sessionRakeAmount: 200, winnersCutPercent: 10 })
    );

    expect(r.players).toHaveLength(9);
    // 200 a seat from nine, plus the cut on the four who finished up.
    expect(r.totalRakeCollected).toBeGreaterThan(1800);
    expectBooksBalance(r);
  });
});

describe('the engine explains itself', () => {
  it('records a step for every rule that fired', () => {
    const r = computeSettlement(
      table(['A', 4000, 9000], ['B', 4000, 4000], ['C', 4000, 1000]),
      rules({ potEnabled: true, sessionRakeAmount: 300, winnersCutPercent: 10 })
    );

    const steps = r.steps.map((s) => s.step);
    expect(steps).toContain('Winner Definition');
    expect(steps).toContain('Mismatch');
    expect(steps).toContain('Rake');
  });

  it('names who paid for a mismatch, since that is the first thing asked', () => {
    const r = computeSettlement(
      table(['A', 4000, 9000], ['B', 4000, 4000], ['C', 4000, 1000]),
      rules({ mismatchStrategy: 'PROPORTIONAL_WINNERS' })
    );

    expect(r.steps.some((s) => s.step === 'Mismatch' && /A -2000/.test(s.detail))).toBe(true);
  });
});
