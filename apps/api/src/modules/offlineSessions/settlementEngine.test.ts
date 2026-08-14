import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { computeSettlement, SettlementSettings, SettlementPlayerInput } from './settlementEngine.js';

/**
 * Money tests.
 *
 * The settlement engine decides who owes what at the end of a poker night, so
 * the property that matters more than any individual number is that it never
 * invents or loses chips. Everything below is ultimately checking one law:
 *
 *     sum(player nets) + potContribution === 0
 *
 * Read it as: whatever the players collectively gain or lose has to be exactly
 * offset by what the club pot takes in. If that holds, the chips leaving the
 * table equal the chips that arrived on it.
 *
 * The matrix test at the bottom is the real safety net — it runs every
 * combination of club rules against a set of awkward tables. The named cases
 * above it exist to pin down *specific* behaviour that has been asked about or
 * has regressed before, so a failure points at a cause rather than a config.
 */

const RULES: SettlementSettings = {
  sessionRakeAmount: 0,
  winnersCutPercent: 0,
  rakeEnabled: false,
  rakeMethod: 'PERCENT_PROFIT',
  rakeValue: 5,
  potEnabled: true,
  mismatchStrategy: 'PROPORTIONAL_WINNERS',
  rakeOrder: 'MISMATCH_FIRST',
  winnerDefinition: 'PROFIT_POSITIVE',
  winnerTopN: 1,
  roundingRule: 'NONE',
};
const rules = (overrides: Partial<SettlementSettings> = {}): SettlementSettings => ({ ...RULES, ...overrides });

const table = (...rows: [string, number, number][]): SettlementPlayerInput[] =>
  rows.map(([userDisplayName, buyIn, cashOut]) => ({ userId: userDisplayName, userDisplayName, buyIn, cashOut }));

/** sum(nets) + pot === 0 — no chips created, none destroyed. */
function expectBooksBalance(result: ReturnType<typeof computeSettlement>) {
  const sumNets = result.players.reduce((sum, p) => sum + p.netResult, 0);
  expect(sumNets + result.potContribution).toBeCloseTo(0, 6);
}

/**
 * The stronger, physical property: the chips people actually carry away from
 * the table, plus whatever the pot keeps, must equal the chips that were bought
 * onto it. This is what someone counting the cash box would check, and unlike
 * the balance above it can fail on rounding alone.
 */
function expectTableReconciles(result: ReturnType<typeof computeSettlement>) {
  const walkAway = result.players.reduce(
    (sum, p) => sum + p.cashOut - p.mismatchDeduction - p.rakeDeduction,
    0
  );
  expect(walkAway + result.potContribution).toBeCloseTo(result.totalBuyIns, 6);
}

describe('money is conserved', () => {
  it('balances a clean table with no rake at all', () => {
    const r = computeSettlement(table(['A', 5000, 8000], ['B', 2000, 1000], ['C', 2000, 0]), rules());
    expect(r.players.map((p) => p.netResult)).toEqual([3000, -1000, -2000]);
    expect(r.potContribution).toBe(0);
    expectBooksBalance(r);
  });

  it("charges the winners' cut on gross profit when the table balances", () => {
    const r = computeSettlement(table(['A', 5000, 8000], ['B', 2000, 1000], ['C', 2000, 0]), rules({ winnersCutPercent: 10 }));
    // 10% of A's 3000 profit. This is the number people expect to see.
    expect(r.players[0].rakeDeduction).toBe(300);
    expect(r.players[0].netResult).toBe(2700);
    expect(r.totalRakeCollected).toBe(300);
    expectBooksBalance(r);
  });

  it('never charges a loser the winners\' cut', () => {
    const r = computeSettlement(table(['A', 5000, 8000], ['B', 2000, 1000], ['C', 2000, 0]), rules({ winnersCutPercent: 10 }));
    expect(r.players.filter((p) => !p.isWinner).every((p) => p.rakeDeduction === 0)).toBe(true);
  });

  it('charges the session rake to every player, winners and losers alike', () => {
    const r = computeSettlement(table(['A', 2000, 3000], ['B', 2000, 2000], ['C', 2000, 1000]), rules({ sessionRakeAmount: 300 }));

    // 300 EACH, not 300 split three ways. A seat fee is what a chair costs for
    // the night; it does not get cheaper because more people sat down.
    expect(r.players.every((p) => p.rakeDeduction === 300)).toBe(true);
    expect(r.totalRakeCollected).toBeCloseTo(900, 6);
    expectBooksBalance(r);
  });

  it('scales with the table, so the same setting means the same to each player', () => {
    const three = computeSettlement(table(['A', 2000, 3000], ['B', 2000, 2000], ['C', 2000, 1000]), rules({ sessionRakeAmount: 300 }));
    const two = computeSettlement(table(['A', 2000, 2500], ['B', 2000, 1500]), rules({ sessionRakeAmount: 300 }));

    // The defect this replaced: under a total-for-the-night rake, a player at a
    // busy table paid less than the same player at a quiet one, for the same
    // configured figure and without anybody choosing that.
    expect(two.players.every((p) => p.rakeDeduction === 300)).toBe(true);
    expect(three.totalRakeCollected).toBeCloseTo(900, 6);
    expect(two.totalRakeCollected).toBeCloseTo(600, 6);
    expectBooksBalance(two);
  });

  it('divides nothing, so an awkward figure needs no rounding', () => {
    // 100 across 3 used to land on 33.33 each with the remainder pushed onto
    // the last player. Nobody divides now, so the arithmetic is exact.
    const r = computeSettlement(table(['A', 2000, 3000], ['B', 2000, 2000], ['C', 2000, 1000]), rules({ sessionRakeAmount: 100 }));

    expect(r.players.map((p) => p.rakeDeduction)).toEqual([100, 100, 100]);
    expect(r.totalRakeCollected).toBe(300);
    expectBooksBalance(r);
  });
});

describe('rake order decides what the cut is charged on', () => {
  // A grosses +3000; the table is over-declared by 2500.
  const overDeclared = table(['A', 5000, 8000], ['B', 2000, 2000], ['C', 2000, 1500]);

  it('MISMATCH_FIRST charges the cut on what survives the mismatch', () => {
    const r = computeSettlement(overDeclared, rules({ winnersCutPercent: 10, rakeOrder: 'MISMATCH_FIRST' }));
    expect(r.players[0].mismatchDeduction).toBe(2500);
    expect(r.players[0].rakeDeduction).toBe(50); // 10% of the 500 left, not of 3000
    expect(r.players[0].netResult).toBe(450);
    expectBooksBalance(r);
  });

  it('RAKE_FIRST charges the cut on gross profit, before the mismatch', () => {
    const r = computeSettlement(overDeclared, rules({ winnersCutPercent: 10, rakeOrder: 'RAKE_FIRST' }));
    expect(r.players[0].rakeDeduction).toBe(300); // 10% of 3000
    expect(r.players[0].netResult).toBe(200);
    expectBooksBalance(r);
  });
});

describe('mismatch handling', () => {
  it('sends unclaimed chips to the pot when buy-ins exceed cash-outs', () => {
    const r = computeSettlement(table(['A', 5000, 7000], ['B', 2000, 1000], ['C', 2000, 0]), rules());
    expect(r.mismatchAmount).toBe(-1000);
    expect(r.potContribution).toBe(1000);
    expectBooksBalance(r);
  });

  it('splits an excess across winners in proportion to profit', () => {
    const r = computeSettlement(table(['A', 1000, 0], ['B', 1000, 2000], ['C', 1000, 2500]), rules());
    const [, b, c] = r.players;
    expect(b.mismatchDeduction).toBeCloseTo(600, 6); // 1000/2500 of 1500
    expect(c.mismatchDeduction).toBeCloseTo(900, 6); // 1500/2500 of 1500
    expectBooksBalance(r);
  });

  it('names who absorbed the mismatch so it can be explained at the table', () => {
    const r = computeSettlement(table(['A', 1000, 0], ['B', 1000, 2000], ['C', 1000, 2500]), rules());
    const step = r.steps.find((s) => s.step === 'Mismatch')!;
    expect(step.detail).toContain('B -600 (40% of winning profit)');
    expect(step.detail).toContain('C -900 (60% of winning profit)');
  });

  it('still claws back phantom chips when the rake already consumed the profit', () => {
    // Regression: with RAKE_FIRST and a 100% cut, the rake zeroed the winner's
    // profit, the mismatch then found nothing to deduct from, and the pot was
    // credited 3000 chips the table never held.
    const r = computeSettlement(
      table(['A', 5000, 8000], ['B', 2000, 2000], ['C', 2000, 2000]),
      rules({ winnersCutPercent: 100, rakeOrder: 'RAKE_FIRST' })
    );
    expect(r.players[0].mismatchDeduction).toBe(3000);
    expect(r.potContribution).toBe(0);
    expectBooksBalance(r);
  });

  it('never leaves a winner worse off than break-even through rake alone', () => {
    const r = computeSettlement(
      table(['A', 5000, 8000], ['B', 2000, 2000], ['C', 2000, 2000]),
      rules({ winnersCutPercent: 50, rakeOrder: 'RAKE_FIRST' })
    );
    expect(r.players[0].netResult).toBeGreaterThanOrEqual(0);
    expectBooksBalance(r);
  });
});

describe('rounding never loses a chip', () => {
  it('applies the rounding residual so the table still reconciles exactly', () => {
    // Excess of 666 splits 111/222/333; at NEAREST_10 those would round to
    // 660 and leave 6 chips unaccounted for.
    const r = computeSettlement(
      table(['A', 1000, 1111], ['B', 1000, 1222], ['C', 1000, 1333]),
      rules({ roundingRule: 'NEAREST_10' })
    );
    expect(r.players.reduce((s, p) => s + p.mismatchDeduction, 0)).toBeCloseTo(666, 6);
    expect(r.steps.some((s) => /residual/i.test(s.detail))).toBe(true);
    expectTableReconciles(r);
    expectBooksBalance(r);
  });

  for (const roundingRule of ['NONE', 'NEAREST_1', 'NEAREST_5', 'NEAREST_10'] as const) {
    it(`reconciles with roundingRule=${roundingRule}`, () => {
      for (const players of [
        table(['A', 1000, 2333], ['B', 1000, 500], ['C', 1000, 167]),
        table(['A', 1000, 1777], ['B', 1000, 1333], ['C', 3000, 889]),
        table(['A', 5000, 8000], ['B', 2000, 1000], ['C', 2000, 0]),
      ]) {
        for (const cut of [0, 10, 12.5]) {
          const r = computeSettlement(players, rules({ roundingRule, winnersCutPercent: cut }));
          expectTableReconciles(r);
          expectBooksBalance(r);
        }
      }
    });
  }
});

describe('there is only one engine', () => {
  /*
   * This used to compare two files as text.
   *
   * apps/web kept a hand-maintained mirror so it could preview a settlement
   * before committing it, and drift meant the number an admin approved stopped
   * being the number that got saved. Comparing the sources caught drift after
   * it was written; sharing the module means there is nothing to drift.
   *
   * The check that remains is the one that matters now: nobody may quietly
   * paste the implementation back. A re-export is a few lines — an engine is
   * five hundred — so a length bound states the rule without pinning the exact
   * wording of a comment.
   */
  const webEngine = () =>
    readFileSync(new URL('../../../../web/src/lib/settlementEngine.ts', import.meta.url), 'utf8');

  it('the web module re-exports the API module rather than copying it', () => {
    expect(webEngine()).toMatch(
      /export \* from '\.\.\/\.\.\/\.\.\/api\/src\/modules\/offlineSessions\/settlementEngine'/
    );
  });

  it('the web module contains no implementation of its own', () => {
    const code = webEngine()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('//'));

    // One line of code. A second implementation cannot hide in that.
    expect(code).toHaveLength(1);
    expect(code[0]).toContain('export *');
  });

  it('the engine imports nothing, so one file can serve Node and the browser', () => {
    const api = readFileSync(new URL('./settlementEngine.ts', import.meta.url), 'utf8');
    // A single `node:` import here would compile fine on the server and break
    // the web bundle — which is the failure mode that ends with the preview
    // and the commit diverging again.
    expect(api).not.toMatch(/^\s*import\s/m);
  });
});

describe('every combination of club rules keeps the books balanced', () => {
  const tables: Record<string, SettlementPlayerInput[]> = {
    balanced: table(['A', 5000, 8000], ['B', 2000, 1000], ['C', 2000, 0]),
    excess: table(['A', 5000, 8000], ['B', 2000, 2000], ['C', 2000, 2000]),
    shortfall: table(['A', 5000, 7000], ['B', 2000, 1000], ['C', 2000, 0]),
    everyoneLoses: table(['A', 3000, 1000], ['B', 3000, 1000], ['C', 3000, 1000]),
    oneSweepsTheTable: table(['A', 1000, 9000], ['B', 4000, 0], ['C', 4000, 0]),
    twoWinners: table(['A', 2000, 4000], ['B', 2000, 5000], ['C', 5000, 0]),
    everyoneBreaksEven: table(['A', 2000, 2000], ['B', 2000, 2000], ['C', 2000, 2000]),
    excessBiggerThanProfit: table(['A', 1000, 9000], ['B', 1000, 1000], ['C', 1000, 1000]),
    awkwardFractions: table(['A', 1000, 2333], ['B', 1000, 500], ['C', 1000, 167]),
  };
  const rakeSetups: [string, Partial<SettlementSettings>][] = [
    ['no rake', {}],
    ["10% winners' cut", { winnersCutPercent: 10 }],
    ["12.5% winners' cut", { winnersCutPercent: 12.5 }],
    ['flat 200', { sessionRakeAmount: 200 }],
    ["flat 200 + 10% cut", { sessionRakeAmount: 200, winnersCutPercent: 10 }],
    ["100% winners' cut", { winnersCutPercent: 100 }],
  ];
  const strategies: SettlementSettings['mismatchStrategy'][] =
    ['PROPORTIONAL_WINNERS', 'EQUAL_WINNERS', 'EQUAL_ALL', 'SHORTFALL_TO_POT', 'EXCESS_FROM_POT'];
  const orders: SettlementSettings['rakeOrder'][] = ['MISMATCH_FIRST', 'RAKE_FIRST'];
  const roundings: SettlementSettings['roundingRule'][] = ['NONE', 'NEAREST_5'];

  for (const [tableName, players] of Object.entries(tables)) {
    for (const [rakeName, rake] of rakeSetups) {
      for (const mismatchStrategy of strategies) {
        for (const rakeOrder of orders) {
          for (const roundingRule of roundings) {
          it(`${tableName} · ${rakeName} · ${mismatchStrategy} · ${rakeOrder} · ${roundingRule}`, () => {
            // potEnabled stays true: a club that charges a rake without a pot
            // is rejected at creation, because the money would be taken from
            // players and never banked. See createClub in clubs.service.ts.
            const r = computeSettlement(players, rules({ ...rake, mismatchStrategy, rakeOrder, roundingRule }), {
              currentPotBalance: 100_000,
              mismatchAcknowledged: true,
            });

            expectBooksBalance(r);
            expectTableReconciles(r);
            expect(r.totalRakeCollected).toBeGreaterThanOrEqual(-1e-6);
            expect(r.totalBuyIns).toBe(players.reduce((s, p) => s + p.buyIn, 0));
            expect(r.totalCashOuts).toBe(players.reduce((s, p) => s + p.cashOut, 0));
            expect(r.mismatchAmount).toBeCloseTo(r.totalCashOuts - r.totalBuyIns, 6);

            for (const p of r.players) {
              expect(Number.isFinite(p.netResult)).toBe(true);
              // net is exactly what's left after the two deductions.
              expect(p.netResult).toBeCloseTo(p.grossProfit - p.mismatchDeduction - p.rakeDeduction, 6);
            }
          });
          }
        }
      }
    }
  }
});

/**
 * A house take with nowhere to go.
 *
 * The engine charged rake whenever a rake was configured, and credited the pot
 * only when the pot was enabled. A club with charges set and potEnabled false
 * therefore took the money off every player and gave it to nobody — it left
 * the table. The steps log even said so, after the fact.
 *
 * This is the one arrangement where sum(nets) + pot came out non-zero, so the
 * invariant every other case is checked against was the thing that would have
 * caught it, had anything asked.
 */
describe('rake needs somewhere to go', () => {
  const charged = { sessionRakeAmount: 300, winnersCutPercent: 10 };
  const night = () => table(['win', 5000, 8000], ['lose', 5000, 2000]);

  it('charges nobody when the pot is disabled', () => {
    const r = computeSettlement(night(), rules({ ...charged, potEnabled: false }));

    expect(r.players.every((p) => p.rakeDeduction === 0)).toBe(true);
    expect(r.totalRakeCollected).toBe(0);
    expect(r.potContribution).toBe(0);
  });

  it('keeps the books balanced, which is what it used to break', () => {
    const r = computeSettlement(night(), rules({ ...charged, potEnabled: false }));

    // 600 chips used to vanish here: 300 flat across two, plus 10% of the
    // winner's 3,000, deducted from players and credited to no pot.
    expectBooksBalance(r);
    expectTableReconciles(r);
  });

  it('leaves every player with exactly what they won or lost', () => {
    const r = computeSettlement(night(), rules({ ...charged, potEnabled: false }));

    expect(r.players.find((p) => p.userId === 'win')?.netResult).toBe(3000);
    expect(r.players.find((p) => p.userId === 'lose')?.netResult).toBe(-3000);
  });

  it('says why nothing was charged rather than charging quietly', () => {
    const r = computeSettlement(night(), rules({ ...charged, potEnabled: false }));

    expect(r.steps.some((st) => /Club Pot is disabled, so nothing was charged/.test(st.detail))).toBe(true);
  });

  it('still charges normally when the pot is enabled', () => {
    const r = computeSettlement(night(), rules({ ...charged, potEnabled: true }));

    // 300 a seat from two, plus 10% of the winner's 3,000.
    expect(r.totalRakeCollected).toBeCloseTo(900, 6);
    expect(r.potContribution).toBeCloseTo(900, 6);
    expectBooksBalance(r);
  });

  it('says nothing at all when no rake was configured either way', () => {
    const r = computeSettlement(night(), rules({ sessionRakeAmount: 0, winnersCutPercent: 0, potEnabled: false }));

    expect(r.steps.some((st) => /nothing was charged/.test(st.detail))).toBe(false);
    expectBooksBalance(r);
  });
});
