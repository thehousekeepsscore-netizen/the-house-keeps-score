/**
 * The matrix the golden fixtures are built from.
 *
 * Lives in its own file because two things must agree on it exactly: the
 * generator that recorded each version's output out of git, and the test that
 * replays it. If they built the matrix separately they would drift, and a
 * fixture that describes a different matrix than the one under test proves
 * nothing at all.
 *
 * Deliberately wider than realistic — every mismatch strategy, both rake
 * orders, all four rounding rules, four winner definitions, five rake shapes,
 * pot on and off, over ten table shapes. 22,400 cases per version. A matrix
 * that only covered nights we have actually seen would not catch the
 * divergence we have not.
 *
 * NOTHING HERE MAY CHANGE once fixtures exist. Adding a case changes the
 * digest for all three versions at once, which is indistinguishable from an
 * engine regression. If the matrix genuinely needs to grow, add a SECOND
 * matrix and a second set of fixtures rather than editing this one.
 */

import { createHash } from 'node:crypto';
import type { SettlementResult, SettlementSettings } from './settlementEngine.js';

export interface FixturePlayer {
  userId: string;
  userDisplayName: string;
  buyIn: number;
  cashOut: number;
  manualWinner?: boolean;
}

export interface FixtureCase {
  table: string;
  players: FixturePlayer[];
  settings: SettlementSettings;
  opts: { currentPotBalance: number; mismatchAcknowledged: boolean };
}

const table = (name: string, pairs: [number, number][], manualWinners: number[] = []) => ({
  name,
  players: pairs.map(([buyIn, cashOut], i) => ({
    userId: `u${i}`,
    userDisplayName: `P${i}`,
    buyIn,
    cashOut,
    ...(manualWinners.includes(i) ? { manualWinner: true } : {}),
  })) as FixturePlayer[],
});

export const FIXTURE_TABLES = [
  table('reconciled pair', [[5000, 8000], [5000, 2000]]),
  table('over-declared trio', [[5000, 9000], [5000, 3000], [5000, 3500]]),
  table('under-declared trio', [[5000, 4000], [5000, 3000], [5000, 2000]]),
  // Three players and an indivisible flat fee is exactly where v1 and v2 part.
  table('three, fee does not divide', [[5000, 6000], [5000, 5000], [5000, 4000]]),
  table('five mixed', [[2000, 5000], [2000, 1000], [3000, 0], [1000, 1500], [4000, 4500]]),
  table('everyone flat', [[1000, 1000], [1000, 1000], [1000, 1000]]),
  // Two identical winners: TOP_N has to break the tie by position.
  table('exact tie at the top', [[5000, 7000], [5000, 7000], [5000, 1000]]),
  table('one player busted', [[5000, 0], [5000, 10000]]),
  table('eight at the table', Array.from({ length: 8 }, (_, i) => [5000, i < 3 ? 8000 : 3000] as [number, number])),
  table('manual winners marked', [[5000, 8000], [5000, 6000], [5000, 1000]], [1]),
];

const MISMATCH = ['PROPORTIONAL_WINNERS', 'EQUAL_WINNERS', 'EQUAL_ALL', 'SHORTFALL_TO_POT', 'EXCESS_FROM_POT', 'MANUAL', 'CUSTOM'] as const;
const ORDERS = ['MISMATCH_FIRST', 'RAKE_FIRST'] as const;
const ROUNDING = ['NONE', 'NEAREST_1', 'NEAREST_5', 'NEAREST_10'] as const;
const WINNERS = [
  { winnerDefinition: 'PROFIT_POSITIVE', winnerTopN: 1 },
  { winnerDefinition: 'TOP_N', winnerTopN: 1 },
  { winnerDefinition: 'TOP_N', winnerTopN: 2 },
  { winnerDefinition: 'MANUAL', winnerTopN: 1 },
] as const;
/** 0, round figures, and two that do not divide by three. */
const RAKES = [
  { sessionRakeAmount: 0, winnersCutPercent: 0 },
  { sessionRakeAmount: 1000, winnersCutPercent: 0 },
  { sessionRakeAmount: 0, winnersCutPercent: 10 },
  { sessionRakeAmount: 100, winnersCutPercent: 5 },
  { sessionRakeAmount: 333, winnersCutPercent: 12 },
];

export function fixtureSettings(): SettlementSettings[] {
  const out: SettlementSettings[] = [];
  for (const mismatchStrategy of MISMATCH)
    for (const rakeOrder of ORDERS)
      for (const roundingRule of ROUNDING)
        for (const winner of WINNERS)
          for (const rake of RAKES)
            for (const potEnabled of [true, false])
              out.push({
                ...rake,
                rakeEnabled: false,
                rakeMethod: 'PERCENT_PROFIT',
                rakeValue: 0,
                potEnabled,
                mismatchStrategy,
                rakeOrder,
                ...winner,
                roundingRule,
              } as SettlementSettings);
  return out;
}

/** Every case, in a fixed order. The order is part of the contract. */
export function fixtureCases(): FixtureCase[] {
  const opts = { currentPotBalance: 10_000, mismatchAcknowledged: true };
  const cases: FixtureCase[] = [];
  for (const t of FIXTURE_TABLES) {
    for (const settings of fixtureSettings()) {
      cases.push({ table: t.name, players: t.players, settings, opts });
    }
  }
  return cases;
}

/**
 * What a result is worth comparing on.
 *
 * The settlement itself, in full, to two decimals — plus the SEQUENCE of
 * pipeline steps, but not the sentence each one writes. Which steps ran and in
 * what order is behaviour. The prose is explanation, and holding a fixture
 * hostage to wording would have people regenerating it for a typo, which is
 * how a fixture stops being evidence.
 */
export function canonicalise(result: SettlementResult): string {
  const money = {
    totalBuyIns: result.totalBuyIns,
    totalCashOuts: result.totalCashOuts,
    mismatchAmount: result.mismatchAmount,
    mismatchResolution: result.mismatchResolution,
    requiresManualResolution: result.requiresManualResolution,
    totalRakeCollected: round2(result.totalRakeCollected),
    potContribution: round2(result.potContribution),
    players: result.players.map((p) => ({
      userId: p.userId,
      totalBuyIn: p.totalBuyIn,
      cashOut: p.cashOut,
      grossProfit: round2(p.grossProfit),
      isWinner: p.isWinner,
      mismatchDeduction: round2(p.mismatchDeduction),
      rakeDeduction: round2(p.rakeDeduction),
      netResult: round2(p.netResult),
    })),
    stepSequence: result.steps.map((s) => s.step),
  };
  return JSON.stringify(money);
}

/**
 * Floating point, pinned.
 *
 * The engine already rounds to 2dp, but a proportional split can leave
 * `-0` or a value whose last bit differs between two arithmetically identical
 * routes. Neither is a behaviour change, and neither should be able to fail a
 * fixture. `+ 0` collapses `-0`.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100 + 0;
}

export function digestOf(canonicalResults: string[]): string {
  const h = createHash('sha256');
  for (const line of canonicalResults) h.update(line).update('\n');
  return h.digest('hex');
}

/**
 * Which cases get their full expected output written down.
 *
 * Every 400th, which is deterministic, spread evenly across the matrix, and
 * enough to make a failure diagnosable — the digest says *that* something
 * changed, these say *what*.
 */
export const SAMPLE_STRIDE = 400;
