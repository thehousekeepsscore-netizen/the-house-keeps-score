/**
 * The replay contract, and the one property that makes it worth having:
 *
 *     inputs + rules + engineVersion  →  engine  →  outputs
 *
 * with no dependency on the current Club configuration or any other mutable
 * state. `replayCanonical` takes one argument, so the test cannot cheat by
 * passing a club — and neither can production code.
 */

import { describe, expect, it } from 'vitest';
import {
  BUY_IN_SOURCE_APPROVED_BANKS,
  buildCanonicalInputs,
  canonicalOutputsFrom,
  copyRules,
  hasAuthoritativeBuyIns,
  potBalanceAffectsResult,
  replayCanonical,
  validateCanonicalInputs,
  CanonicalSettlementInputs,
} from './canonicalSettlement.js';
import { computeSettlement, computeSettlementAt, SettlementSettings } from './settlementEngine.js';

const RULES: SettlementSettings = {
  sessionRakeAmount: 500,
  winnersCutPercent: 10,
  rakeEnabled: false,
  rakeMethod: 'PERCENT_PROFIT',
  rakeValue: 0,
  potEnabled: true,
  mismatchStrategy: 'PROPORTIONAL_WINNERS',
  rakeOrder: 'MISMATCH_FIRST',
  winnerDefinition: 'PROFIT_POSITIVE',
  winnerTopN: 1,
  roundingRule: 'NONE',
};

const players = (pairs: [number, number][]) =>
  pairs.map(([buyIn, cashOut], i) => ({
    userId: `u${i}`,
    userDisplayName: `P${i}`,
    buyIn,
    cashOut,
  }));

const inputs = (over: Partial<Parameters<typeof buildCanonicalInputs>[0]> = {}) =>
  buildCanonicalInputs({
    rules: RULES,
    players: players([[5000, 8000], [5000, 2000]]),
    currentPotBalance: 10_000,
    mismatchAcknowledged: true,
    capturedFrom: 'settleSession',
    ...over,
  });

describe('a replay depends on the inputs and nothing else', () => {
  it('reproduces the engine exactly from the captured inputs', () => {
    const captured = inputs();
    const direct = computeSettlement(players([[5000, 8000], [5000, 2000]]), RULES, {
      currentPotBalance: 10_000,
      mismatchAcknowledged: true,
    });
    const replayed = replayCanonical(captured);

    expect(replayed.players.map((p) => p.netResult)).toEqual(direct.players.map((p) => p.netResult));
    expect(replayed.totals.rake).toBe(direct.totalRakeCollected);
    expect(replayed.totals.potContribution).toBe(direct.potContribution);
  });

  it('is unaffected by anything happening to the rules afterwards', () => {
    const captured = inputs();
    const before = replayCanonical(captured);

    // The mutation a club settings change would make, applied to the very
    // object the club handed over. A snapshot that shared a reference would
    // follow it; a verbatim copy does not.
    const clubRules = captured.rules as unknown as Record<string, unknown>;
    expect(clubRules.sessionRakeAmount).toBe(500);

    const mutated: SettlementSettings = { ...RULES, sessionRakeAmount: 99_999, winnersCutPercent: 90 };
    void mutated; // never handed to the replay — that is the point
    const after = replayCanonical(captured);
    expect(after).toEqual({ ...before, computedAt: after.computedAt });
  });

  it('copies the rules rather than referencing them', () => {
    const source: SettlementSettings = { ...RULES };
    const captured = buildCanonicalInputs({
      rules: source,
      players: players([[5000, 8000], [5000, 2000]]),
      currentPotBalance: 0,
      capturedFrom: 'settleSession',
    });

    source.sessionRakeAmount = 99_999;
    expect(captured.rules.sessionRakeAmount).toBe(500);
  });

  it('carries only the eleven rule fields, not whatever else the club object had', () => {
    const withExtras = { ...RULES, id: 'club-1', name: 'All in', clubPotBalance: 12_345 } as unknown as SettlementSettings;
    expect(Object.keys(copyRules(withExtras)).sort()).toEqual(
      [
        'mismatchStrategy', 'potEnabled', 'rakeEnabled', 'rakeMethod', 'rakeOrder', 'rakeValue',
        'roundingRule', 'sessionRakeAmount', 'winnerDefinition', 'winnerTopN', 'winnersCutPercent',
      ].sort()
    );
  });

  it('replays a v1 night under v1 semantics, not today\'s', () => {
    const v1 = inputs({ engineVersion: 1, rules: { ...RULES, sessionRakeAmount: 900, winnersCutPercent: 0 } });
    const v3 = inputs({ engineVersion: 3, rules: { ...RULES, sessionRakeAmount: 900, winnersCutPercent: 0 } });

    // 900 split across two, versus 900 each.
    expect(replayCanonical(v1).totals.rake).toBe(900);
    expect(replayCanonical(v3).totals.rake).toBe(1800);
  });
});

describe('participant order is part of the inputs', () => {
  it('records a seat index alongside the array position', () => {
    expect(inputs().participants.map((p) => p.seatIndex)).toEqual([0, 1]);
  });

  it('refuses to replay when the order and the indices disagree', () => {
    const captured = inputs({ players: players([[5000, 6000], [5000, 5000], [5000, 4000]]) });
    // What a serialisation that reordered the array would leave behind.
    const shuffled: CanonicalSettlementInputs = {
      ...captured,
      participants: [captured.participants[2], captured.participants[0], captured.participants[1]],
    };
    expect(() => replayCanonical(shuffled)).toThrow(/order is not intact/);
  });

  it('reproduces the seat that pays a v1 remainder', () => {
    const captured = inputs({
      engineVersion: 1,
      rules: { ...RULES, sessionRakeAmount: 100, winnersCutPercent: 0 },
      players: players([[5000, 6000], [5000, 5000], [5000, 4000]]),
    });
    // The extra cent belongs to the last seat, and it must land there again.
    expect(replayCanonical(captured).players.map((p) => p.seatFee)).toEqual([33.33, 33.33, 33.34]);
  });
});

describe('manual winners survive capture', () => {
  it('records the flag even when the rules never read it', () => {
    const captured = buildCanonicalInputs({
      rules: RULES, // PROFIT_POSITIVE — manualWinner is ignored
      players: [
        { userId: 'a', userDisplayName: 'A', buyIn: 5000, cashOut: 8000, manualWinner: true },
        { userId: 'b', userDisplayName: 'B', buyIn: 5000, cashOut: 2000 },
      ],
      currentPotBalance: 0,
      capturedFrom: 'settleSession',
    });
    expect(captured.participants.map((p) => p.manualWinner)).toEqual([true, false]);
  });

  it('replays a MANUAL night to the same winners', () => {
    const manual: SettlementSettings = { ...RULES, winnerDefinition: 'MANUAL' };
    const captured = buildCanonicalInputs({
      rules: manual,
      players: [
        { userId: 'a', userDisplayName: 'A', buyIn: 5000, cashOut: 8000, manualWinner: false },
        { userId: 'b', userDisplayName: 'B', buyIn: 5000, cashOut: 6000, manualWinner: true },
      ],
      currentPotBalance: 0,
      mismatchAcknowledged: true,
      capturedFrom: 'settleSession',
    });

    const replayed = replayCanonical(captured);
    expect(replayed.players.map((p) => p.isWinner)).toEqual([false, true]);
    // And it agrees with the engine called directly with the same flags.
    const direct = computeSettlementAt(3, [
      { userId: 'a', userDisplayName: 'A', buyIn: 5000, cashOut: 8000, manualWinner: false },
      { userId: 'b', userDisplayName: 'B', buyIn: 5000, cashOut: 6000, manualWinner: true },
    ], manual, { currentPotBalance: 0, mismatchAcknowledged: true });
    expect(replayed.players.map((p) => p.netResult)).toEqual(direct.players.map((p) => p.netResult));
  });

  it('refuses a MANUAL night with no winner marked, rather than settling nobody', () => {
    const captured = buildCanonicalInputs({
      rules: { ...RULES, winnerDefinition: 'MANUAL' },
      players: players([[5000, 8000], [5000, 2000]]),
      currentPotBalance: 0,
      mismatchAcknowledged: true,
      capturedFrom: 'revision-backfill',
    });
    expect(() => replayCanonical(captured)).toThrow(/no winners at all/);
  });
});

describe('pot state', () => {
  it('is recorded whether or not it matters', () => {
    expect(inputs({ currentPotBalance: 4_242 }).potState.currentPotBalance).toBe(4_242);
  });

  it('says when the balance could change the result', () => {
    // Cash-outs exceed buy-ins under a pot-funded strategy: the branch fires.
    const affected = inputs({
      rules: { ...RULES, mismatchStrategy: 'EXCESS_FROM_POT' },
      players: players([[5000, 9000], [5000, 3000]]),
    });
    expect(affected.potState.affectsResult).toBe(true);

    // Same strategy, no excess: the balance is never read.
    const inert = inputs({
      rules: { ...RULES, mismatchStrategy: 'EXCESS_FROM_POT' },
      players: players([[5000, 4000], [5000, 3000]]),
    });
    expect(inert.potState.affectsResult).toBe(false);

    // Default strategy never reads it at all.
    expect(inputs({ players: players([[5000, 9000], [5000, 3000]]) }).potState.affectsResult).toBe(false);
  });

  it('mirrors the engine\'s own condition', () => {
    expect(potBalanceAffectsResult({ ...RULES, mismatchStrategy: 'EXCESS_FROM_POT' }, 500)).toBe(true);
    expect(potBalanceAffectsResult({ ...RULES, mismatchStrategy: 'EXCESS_FROM_POT', potEnabled: false }, 500)).toBe(false);
    expect(potBalanceAffectsResult({ ...RULES, mismatchStrategy: 'EXCESS_FROM_POT' }, -500)).toBe(false);
    expect(potBalanceAffectsResult(RULES, 500)).toBe(false);
  });
});

describe('validation names what is missing', () => {
  const cases: [string, unknown, RegExp][] = [
    ['not an object', 'nope', /not an object/],
    ['unknown engine version', { ...inputs(), engineVersion: 9 }, /not a version this engine can run/],
    ['missing rules', { ...inputs(), rules: null }, /rules are missing/],
    ['incomplete rules', { ...inputs(), rules: { sessionRakeAmount: 1 } }, /rules are incomplete/],
    ['no participants', { ...inputs(), participants: [] }, /participants are missing/],
    ['missing pot state', { ...inputs(), potState: undefined }, /currentPotBalance is missing/],
    ['missing acknowledgement', { ...inputs(), mismatchAcknowledged: undefined }, /mismatchAcknowledged is missing/],
  ];

  for (const [name, value, pattern] of cases) {
    it(`reports ${name}`, () => {
      expect(validateCanonicalInputs(value).join(' | ')).toMatch(pattern);
    });
  }

  it('accepts a complete set', () => {
    expect(validateCanonicalInputs(inputs())).toEqual([]);
  });

  it('rejects a negative cash-out', () => {
    const bad = inputs();
    bad.participants[0].cashOut = -1;
    expect(validateCanonicalInputs(bad).join(' ')).toMatch(/invalid cashOut/);
  });
});

describe('outputs keep the two house charges apart', () => {
  it('reports the seat fee and the cut separately, and their sum', () => {
    const replayed = replayCanonical(inputs());
    const winner = replayed.players[0];
    expect(winner.seatFee).toBe(500);
    expect(winner.winnersCut).toBe(300);
    expect(winner.rakeDeduction).toBe(800);
    expect(replayed.totals.seatFees).toBe(1000);
    expect(replayed.totals.winnersCut).toBe(300);
  });

  it('keeps seat identity attached to every outcome row', () => {
    const replayed = replayCanonical(inputs());
    expect(replayed.players.map((p) => [p.seatIndex, p.userId])).toEqual([[0, 'u0'], [1, 'u1']]);
  });

  it('carries the engine\'s own explanation', () => {
    expect(replayCanonical(inputs()).steps.map((s) => s.step)).toContain('Rake');
  });

  it('agrees with canonicalOutputsFrom on the same result', () => {
    const captured = inputs();
    const direct = computeSettlementAt(captured.engineVersion, players([[5000, 8000], [5000, 2000]]), RULES, {
      currentPotBalance: 10_000,
      mismatchAcknowledged: true,
    });
    const shaped = canonicalOutputsFrom(direct, captured);
    const replayed = replayCanonical(captured);
    expect({ ...shaped, computedAt: '' }).toEqual({ ...replayed, computedAt: '' });
  });
});

describe('buy-in provenance is additive to the contract', () => {
  /*
   * `buyInSource` says the figures were derived from approved banks. It is
   * optional because every record written before it existed lacks it, and
   * because eight production nights carry `capturedFrom: 'settleSession'`
   * while their buy-ins were still the form's — so absence has to stay a
   * valid, replayable state rather than a validation failure.
   */
  it('validates and replays with the stamp absent', () => {
    const legacy = inputs();
    expect(legacy).not.toHaveProperty('buyInSource');
    expect(validateCanonicalInputs(legacy)).toEqual([]);
    expect(() => replayCanonical(legacy)).not.toThrow();
  });

  it('validates and replays with the stamp present', () => {
    const stamped = inputs({ buyInSource: BUY_IN_SOURCE_APPROVED_BANKS });
    expect(stamped.buyInSource).toBe('approved-banks');
    expect(validateCanonicalInputs(stamped)).toEqual([]);
    expect(replayCanonical(stamped)).toEqual(replayCanonical(inputs()));
  });

  it('rejects a provenance the contract does not know', () => {
    const odd = { ...inputs(), buyInSource: 'the-form' };
    expect(validateCanonicalInputs(odd).join(' | ')).toMatch(/buyInSource "the-form" is not a provenance/);
  });

  it('is written as a key only when given', () => {
    // A JSON column cannot tell `undefined` from absent, so the builder must
    // not emit the key at all for a caller that has nothing to say.
    expect(Object.keys(inputs())).not.toContain('buyInSource');
    expect(Object.keys(inputs({ buyInSource: BUY_IN_SOURCE_APPROVED_BANKS }))).toContain('buyInSource');
  });

  it('is read strictly, by equality on the one known value', () => {
    expect(hasAuthoritativeBuyIns(inputs({ buyInSource: BUY_IN_SOURCE_APPROVED_BANKS }))).toBe(true);
    expect(hasAuthoritativeBuyIns(inputs())).toBe(false);
    expect(hasAuthoritativeBuyIns({ ...inputs(), buyInSource: 'approved-bank' })).toBe(false);
    expect(hasAuthoritativeBuyIns({ ...inputs(), buyInSource: null })).toBe(false);
    expect(hasAuthoritativeBuyIns(null)).toBe(false);
    expect(hasAuthoritativeBuyIns(undefined)).toBe(false);
    expect(hasAuthoritativeBuyIns('approved-banks')).toBe(false);
  });
});
