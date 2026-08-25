/**
 * Revision 1 preserves a settlement. It must never restate one.
 *
 * The acceptance criterion for step 4, in one line:
 *
 *     before: settlement = X
 *     after:  settlement = X, revision 1 = X, canonical inputs = the original
 *
 * The test that matters most is the one where the engine and the record
 * DISAGREE. A backfill that recalculates would quietly write the engine's
 * answer; this one has to refuse and report, because the record is the
 * financial fact and the engine is not.
 */

import { describe, expect, it } from 'vitest';
import { planRevisionOne, transcribeOutputs, verifyByReplay, PlannedRevisionOne } from './revisionOne.js';
import { assess, RecordUnderAudit } from './replayability.js';
import { computeSettlement, SettlementSettings } from '../offlineSessions/settlementEngine.js';
import { buildCanonicalInputs, canonicalOutputsFrom } from '../offlineSessions/canonicalSettlement.js';

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

/**
 * A pre-contract record, built the way `settleSession` built one before the
 * canonical columns existed: run the engine, store the fused figures under the
 * misleading column names, keep no rules on the row.
 */
function legacyRecord(
  pairs: [number, number][],
  rules: SettlementSettings = RULES,
  overrideEvidence: Partial<RecordUnderAudit['evidence']> = {}
) {
  const engineInputs = pairs.map(([buyIn, cashOut], i) => ({
    userId: `u${i}`,
    userDisplayName: `P${i}`,
    buyIn,
    cashOut,
  }));
  const result = computeSettlement(engineInputs, rules, { mismatchAcknowledged: true });

  const rawPlayers = result.players.map((p) => ({
    userId: p.userId,
    userDisplayName: p.userDisplayName,
    totalBuyIn: p.totalBuyIn,
    cashOut: p.cashOut,
    grossProfit: p.grossProfit,
    excessDeduction: p.mismatchDeduction,
    winnersCutDeduction: p.rakeDeduction, // the fused figure, misnamed
    netResult: p.netResult,
  }));

  const record: RecordUnderAudit = {
    id: 'rec-1',
    clubId: 'club-1',
    kind: 'cashout',
    isDeleted: false,
    sessionType: 'Offline Session',
    occurredAt: '2026-08-01T00:00:00.000Z',
    players: rawPlayers.map((p) => ({
      userId: p.userId,
      name: p.userDisplayName,
      totalBuyIn: p.totalBuyIn,
      cashOut: p.cashOut,
      storedNet: p.netResult,
    })),
    totals: {
      totalBuyIns: result.totalBuyIns,
      totalCashOuts: result.totalCashOuts,
      rakeCollected: result.totalRakeCollected,
      potAdjustment: result.potContribution,
    },
    evidence: {
      engineVersion: 3,
      rules,
      rulesSource: 'audit',
      auditPlayerOrder: result.players.map((p) => p.userId),
      neverEngineSettled: false,
      editedSinceSettle: false,
      ...overrideEvidence,
    },
  };

  return { record, rawPlayers, result };
}

const planFor = (r: ReturnType<typeof legacyRecord>, existing = false) =>
  planRevisionOne(r.record, assess(r.record), r.rawPlayers, existing);

describe('revision 1 reproduces the settlement exactly', () => {
  const fixture = legacyRecord([[5000, 8000], [5000, 2000]]);

  it('transcribes every figure the record holds', () => {
    const out = planFor(fixture);
    expect(out.kind).toBe('plan');
    const plan = (out as { plan: PlannedRevisionOne }).plan;

    fixture.rawPlayers.forEach((raw, i) => {
      const p = plan.canonicalOutputs.players[i];
      expect(p.netResult).toBe(raw.netResult);
      expect(p.rakeDeduction).toBe(raw.winnersCutDeduction);
      expect(p.mismatchDeduction).toBe(raw.excessDeduction);
      expect(p.buyIn).toBe(raw.totalBuyIn);
      expect(p.cashOut).toBe(raw.cashOut);
    });

    expect(plan.totals.buyIns).toBe(fixture.record.totals.totalBuyIns);
    expect(plan.totals.cashOuts).toBe(fixture.record.totals.totalCashOuts);
    expect(plan.totals.rake).toBe(fixture.record.totals.rakeCollected);
    expect(plan.totals.potContribution).toBe(fixture.record.totals.potAdjustment);
  });

  it('captures the original inputs, in the original order', () => {
    const plan = (planFor(fixture) as { plan: PlannedRevisionOne }).plan;
    expect(plan.canonicalInputs.participants.map((p) => [p.seatIndex, p.userId, p.buyIn, p.cashOut])).toEqual([
      [0, 'u0', 5000, 8000],
      [1, 'u1', 5000, 2000],
    ]);
  });

  it('records the rules and the engine version it was settled under', () => {
    const plan = (planFor(fixture) as { plan: PlannedRevisionOne }).plan;
    expect(plan.engineVersion).toBe(3);
    expect(plan.ruleSnapshot).toEqual(RULES);
  });

  it('marks itself live, first, and superseding nothing', () => {
    const plan = (planFor(fixture) as { plan: PlannedRevisionOne }).plan;
    expect(plan.revision).toBe(1);
    expect(plan.isLive).toBe(true);
    expect(plan.supersedesRevision).toBeNull();
    expect(plan.causedBy).toBe('backfill');
  });
});

describe('it preserves rather than recalculates', () => {
  it('REFUSES a record whose figures the engine cannot reproduce', () => {
    /*
     * The heart of step 4, and there are two gates in front of it.
     *
     * FIRST GATE: the audit. A record whose stored figures do not match what
     * the engine produces from the same inputs never reaches `replayable`, so
     * it is turned away before a revision is even planned.
     */
    const fixture = legacyRecord([[5000, 8000], [5000, 2000]]);
    fixture.rawPlayers[0].netResult += 250;
    fixture.record.players[0].storedNet = fixture.rawPlayers[0].netResult;

    const verdict = assess(fixture.record);
    expect(verdict.verdict).toBe('missing-required-input');
    expect(verdict.blockers).toContain('replay-mismatch');

    const out = planRevisionOne(fixture.record, verdict, fixture.rawPlayers, false);
    expect(out.kind).toBe('skip');
    expect((out as { code: string }).code).toBe('inputs-not-reconstructable');
  });

  it('has a SECOND gate that catches a corrupt transcription on its own', () => {
    /*
     * SECOND GATE: `verifyByReplay`, which does not depend on the audit having
     * been right. Here the audit sees a clean record — `record.players` is
     * untouched, so the verdict is `replayable` — while the raw row the
     * transcription copies from has been corrupted. Only the verification can
     * catch that, and it must, because a backfill that trusted the transcription
     * would write figures no engine ever produced.
     */
    const fixture = legacyRecord([[5000, 8000], [5000, 2000]]);
    const verdict = assess(fixture.record);
    expect(verdict.verdict).toBe('replayable');

    fixture.rawPlayers[0].netResult += 250;
    fixture.rawPlayers[0].winnersCutDeduction = 999;

    const out = planRevisionOne(fixture.record, verdict, fixture.rawPlayers, false);
    expect(out.kind).toBe('skip');
    expect((out as { code: string }).code).toBe('transcription-failed-verification');
    expect((out as { detail: string }).detail).toMatch(/netResult|rakeDeduction/);
  });

  it('writes the record\'s figures even where they are the ones under suspicion', () => {
    // Nothing in the plan is sourced from a fresh engine run: swapping the
    // engine's answer in would change these, and it must not.
    const fixture = legacyRecord([[5000, 9000], [5000, 3000], [5000, 3500]]);
    const plan = (planFor(fixture) as { plan: PlannedRevisionOne }).plan;
    plan.canonicalOutputs.players.forEach((p, i) => {
      expect(p.netResult).toBe(fixture.rawPlayers[i].netResult);
    });
  });

  it('verifyByReplay compares, and does not overwrite', () => {
    const fixture = legacyRecord([[5000, 8000], [5000, 2000]]);
    const inputs = buildCanonicalInputs({
      rules: RULES,
      players: [
        { userId: 'u0', userDisplayName: 'P0', buyIn: 5000, cashOut: 8000 },
        { userId: 'u1', userDisplayName: 'P1', buyIn: 5000, cashOut: 2000 },
      ],
      currentPotBalance: 0,
      mismatchAcknowledged: true,
      capturedFrom: 'revision-backfill',
    });
    const transcribed = transcribeOutputs(fixture.record, fixture.rawPlayers, inputs);
    const before = JSON.stringify(transcribed);
    expect(verifyByReplay(inputs, transcribed).ok).toBe(true);
    expect(JSON.stringify(transcribed)).toBe(before);
  });
});

describe('what it will not do', () => {
  it('skips a legacy record no engine ever settled', () => {
    const fixture = legacyRecord([[5000, 8000], [5000, 2000]], RULES, {
      neverEngineSettled: true,
      rules: null,
      rulesSource: null,
      engineVersion: null,
    });
    const out = planFor(fixture);
    expect(out.kind).toBe('skip');
    expect((out as { code: string }).code).toBe('never-engine-settled');
  });

  it('skips a record whose rules were never recorded, and does not repair it', () => {
    // The Texas Holdem night in production: engine version known, rules gone.
    const fixture = legacyRecord([[5000, 8000], [5000, 2000]], RULES, {
      rules: null,
      rulesSource: null,
    });
    const out = planFor(fixture);
    expect(out.kind).toBe('skip');
    expect((out as { code: string }).code).toBe('inputs-not-reconstructable');
  });

  it('skips a record with no engine version', () => {
    const fixture = legacyRecord([[5000, 8000], [5000, 2000]], RULES, { engineVersion: null });
    expect(planFor(fixture).kind).toBe('skip');
  });

  it('never manufactures the seat fee / winners cut split', () => {
    const plan = (planFor(legacyRecord([[5000, 8000], [5000, 2000]])) as { plan: PlannedRevisionOne }).plan;
    for (const p of plan.canonicalOutputs.players) {
      expect(p.seatFee).toBeNull();
      expect(p.winnersCut).toBeNull();
      expect(p.splitUnavailableReason).toMatch(/cannot be derived from the total/);
    }
    expect(plan.totals.seatFees).toBeNull();
    expect(plan.totals.winnersCut).toBeNull();
    expect(plan.splitUnavailableReason).toBeTruthy();
  });
});

describe('it is idempotent', () => {
  const fixture = legacyRecord([[5000, 8000], [5000, 2000]]);

  it('skips a record that already has a revision 1', () => {
    const out = planFor(fixture, true);
    expect(out.kind).toBe('skip');
    expect((out as { code: string }).code).toBe('already-present');
  });

  it('produces an identical plan every time it runs', () => {
    const a = (planFor(fixture) as { plan: PlannedRevisionOne }).plan;
    const b = (planFor(fixture) as { plan: PlannedRevisionOne }).plan;
    // capturedAt comes from the record's own timestamp, not from the clock, so
    // two runs are byte-identical rather than merely equivalent.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.canonicalInputs.capturedAt).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('a record written since the canonical contract landed', () => {
  it('uses its captured contract rather than reconstructing one', () => {
    const players = [
      { userId: 'u0', userDisplayName: 'P0', buyIn: 5000, cashOut: 8000 },
      { userId: 'u1', userDisplayName: 'P1', buyIn: 5000, cashOut: 2000 },
    ];
    const inputs = buildCanonicalInputs({
      rules: RULES,
      players,
      currentPotBalance: 4242,
      mismatchAcknowledged: true,
      capturedFrom: 'settleSession',
    });
    const outputs = canonicalOutputsFrom(
      computeSettlement(players, RULES, { currentPotBalance: 4242, mismatchAcknowledged: true }),
      inputs
    );

    const fixture = legacyRecord([[5000, 8000], [5000, 2000]]);
    const out = planRevisionOne(fixture.record, assess(fixture.record), fixture.rawPlayers, false, {
      inputs,
      outputs,
    });

    const plan = (out as { plan: PlannedRevisionOne }).plan;
    expect(plan.canonicalInputs).toBe(inputs);
    expect(plan.canonicalOutputs).toBe(outputs);
    // The real thing knows the split and the pot balance; a reconstruction
    // could not have supplied either.
    expect(plan.splitUnavailableReason).toBeNull();
    expect(plan.canonicalInputs.potState.currentPotBalance).toBe(4242);
    expect(plan.canonicalOutputs.players[0].seatFee).toBe(500);
  });
});
