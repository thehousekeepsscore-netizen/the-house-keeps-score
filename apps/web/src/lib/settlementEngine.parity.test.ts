import { describe, it, expect } from 'vitest';
import {
  computeSettlement as webCompute,
  SETTLEMENT_ENGINE_VERSION as WEB_VERSION,
  SettlementSettings,
  SettlementPlayerInput,
  MismatchStrategy,
  RakeOrder,
  WinnerDefinition,
  RoundingRule,
} from './settlementEngine';
import {
  computeSettlement as apiCompute,
  SETTLEMENT_ENGINE_VERSION as API_VERSION,
} from '../../../api/src/modules/offlineSessions/settlementEngine';

/**
 * There is one engine now, and this is what proves it.
 *
 * apps/web used to keep a hand-maintained mirror of the API's settlement
 * engine so a host could see what a night would settle to before committing
 * it. Two copies of 500 lines, kept in step by a comment asking the next
 * person to remember. The host approved figures from one copy and the server
 * committed figures from the other, so a drift meant a settlement nobody
 * signed off on — silently: no error, nothing to notice, no way to tell
 * afterwards.
 *
 * `apps/web/src/lib/settlementEngine.ts` is now a re-export of the API module,
 * so the preview and the commit are the same function. This file keeps running
 * because two things still need proving, and neither is about drift:
 *
 *   - the shared module actually RESOLVES AND EXECUTES from the web app —
 *     bundling, tsconfig, module resolution, anything that could make the
 *     import work in a type-check and fail in a browser
 *   - `export *` re-exports the values, not just the types, so `computeSettlement`
 *     imported from the web path is the real function rather than undefined
 *
 * The identity check below is the new guarantee; the behavioural comparison
 * underneath it is the old one, kept because a passing identity assertion
 * would still be worthless if the module never ran.
 */
describe('the web engine IS the API engine', () => {
  it('re-exports the same function object, not an equivalent one', () => {
    // Stronger than any output comparison: there is no second implementation
    // for a comparison to be run against.
    expect(webCompute).toBe(apiCompute);
    expect(WEB_VERSION).toBe(API_VERSION);
  });

  it('resolves as a callable value across the app boundary', () => {
    // `export *` is a type-level no-op if the module fails to load, and a
    // type-check alone would not notice.
    expect(typeof webCompute).toBe('function');
  });
});

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

/**
 * Tables chosen for the shapes that make settlement hard, not for variety.
 *
 * A night that balances is the easy case. What separates the two engines, if
 * anything ever does, is a table that is over- or under-declared, one where the
 * winner's profit is entirely consumed, one where nobody won, and one that
 * divides badly.
 */
const TABLES: Record<string, SettlementPlayerInput[]> = {
  balanced: table(['A', 5000, 8000], ['B', 2000, 1000], ['C', 2000, 0]),
  overDeclared: table(['A', 5000, 8000], ['B', 2000, 2000], ['C', 2000, 1500]),
  underDeclared: table(['A', 5000, 3000], ['B', 5000, 4000]),
  everybodyLost: table(['A', 5000, 1000], ['B', 5000, 2000], ['C', 5000, 0]),
  oneWinnerTakesAll: table(['A', 1000, 3000], ['B', 1000, 0], ['C', 1000, 0]),
  tiedWinners: table(['A', 5000, 7000], ['B', 5000, 7000], ['C', 5000, 1000]),
  awkwardDivision: table(['A', 1000, 1100], ['B', 1000, 950], ['C', 1000, 950]),
  headsUp: table(['A', 10000, 15000], ['B', 10000, 5000]),
  nine: table(
    ['A', 5000, 9000], ['B', 5000, 1000], ['C', 5000, 4000], ['D', 5000, 6000], ['E', 5000, 2000],
    ['F', 5000, 5000], ['G', 5000, 7000], ['H', 5000, 3000], ['I', 5000, 3000]
  ),
  singlePlayer: table(['A', 5000, 5000]),
  everyoneAtZero: table(['A', 0, 0], ['B', 0, 0]),
};

const MISMATCH: MismatchStrategy[] = [
  'PROPORTIONAL_WINNERS', 'EQUAL_WINNERS', 'EQUAL_ALL',
  'SHORTFALL_TO_POT', 'EXCESS_FROM_POT', 'MANUAL', 'CUSTOM',
];
const ORDERS: RakeOrder[] = ['MISMATCH_FIRST', 'RAKE_FIRST'];
const WINNERS: WinnerDefinition[] = ['PROFIT_POSITIVE', 'TOP_N', 'MANUAL', 'CUSTOM'];
const ROUNDING: RoundingRule[] = ['NONE', 'NEAREST_1', 'NEAREST_5', 'NEAREST_10'];

/** Both engines, same inputs. Anything that differs is the bug. */
function bothAgree(players: SettlementPlayerInput[], settings: SettlementSettings, opts = {}) {
  const w = webCompute(players, settings, opts);
  const a = apiCompute(players, settings, opts);
  return { w, a };
}

describe('the client engine matches the server engine', () => {
  it('reports the same version, so a settled record cannot name the wrong one', () => {
    // The version is stamped onto every settlement audit. If the copies drift
    // in version alone, a night says it was decided by an engine it was not.
    expect(WEB_VERSION).toBe(API_VERSION);
  });

  it.each(Object.keys(TABLES))('agrees on %s with no rake and no pot', (name) => {
    const { w, a } = bothAgree(TABLES[name], rules());
    expect(w).toEqual(a);
  });

  it.each(Object.keys(TABLES))('agrees on %s with a seat fee and a winners cut', (name) => {
    const { w, a } = bothAgree(
      TABLES[name],
      rules({ sessionRakeAmount: 300, winnersCutPercent: 10, potEnabled: true })
    );
    expect(w).toEqual(a);
  });

  it.each(Object.keys(TABLES))('agrees on %s when the pot is disabled but charges are set', (name) => {
    // The arrangement that was losing chips until engine version 3.
    const { w, a } = bothAgree(
      TABLES[name],
      rules({ sessionRakeAmount: 300, winnersCutPercent: 10, potEnabled: false })
    );
    expect(w).toEqual(a);
  });

  it.each(MISMATCH)('agrees under %s', (mismatchStrategy) => {
    for (const t of Object.values(TABLES)) {
      const { w, a } = bothAgree(
        t,
        rules({ mismatchStrategy, potEnabled: true, sessionRakeAmount: 200, winnersCutPercent: 5 }),
        { currentPotBalance: 10_000, mismatchAcknowledged: true }
      );
      expect(w).toEqual(a);
    }
  });

  it.each(ORDERS)('agrees under %s', (rakeOrder) => {
    for (const t of Object.values(TABLES)) {
      const { w, a } = bothAgree(t, rules({ rakeOrder, potEnabled: true, winnersCutPercent: 15 }));
      expect(w).toEqual(a);
    }
  });

  it.each(WINNERS)('agrees under %s', (winnerDefinition) => {
    for (const t of Object.values(TABLES)) {
      const { w, a } = bothAgree(
        t,
        rules({ winnerDefinition, winnerTopN: 2, potEnabled: true, winnersCutPercent: 12 })
      );
      expect(w).toEqual(a);
    }
  });

  it.each(ROUNDING)('agrees under %s, where rounding is most likely to split them', (roundingRule) => {
    for (const t of Object.values(TABLES)) {
      const { w, a } = bothAgree(
        t,
        rules({ roundingRule, potEnabled: true, sessionRakeAmount: 100, winnersCutPercent: 7 })
      );
      expect(w).toEqual(a);
    }
  });

  it('agrees across every combination of the rules, not only one at a time', () => {
    // The cross product. A divergence that needs two settings to show up is
    // exactly the one a hand-maintained mirror produces.
    let compared = 0;
    for (const t of Object.values(TABLES)) {
      for (const mismatchStrategy of MISMATCH) {
        for (const rakeOrder of ORDERS) {
          for (const roundingRule of ROUNDING) {
            for (const potEnabled of [true, false]) {
              const settings = rules({
                mismatchStrategy, rakeOrder, roundingRule, potEnabled,
                sessionRakeAmount: 250, winnersCutPercent: 8,
              });
              const { w, a } = bothAgree(t, settings, {
                currentPotBalance: 5_000,
                mismatchAcknowledged: true,
              });
              expect(w, `${mismatchStrategy}/${rakeOrder}/${roundingRule}/pot=${potEnabled}`).toEqual(a);
              compared += 1;
            }
          }
        }
      }
    }
    // Guards the loop itself: a bad filter would compare nothing and pass.
    expect(compared).toBe(
      Object.keys(TABLES).length * MISMATCH.length * ORDERS.length * ROUNDING.length * 2
    );
  });

  it('agrees on the reasoning, not only the figures', () => {
    // steps[] is what the preview shows a human to explain the numbers. Two
    // engines that agree on the money and disagree on why would put a
    // different explanation on screen than the one recorded in the audit.
    const { w, a } = bothAgree(
      TABLES.overDeclared,
      rules({ potEnabled: true, sessionRakeAmount: 300, winnersCutPercent: 10 })
    );
    expect(w.steps).toEqual(a.steps);
  });
});
