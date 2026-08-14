/**
 * The classifier decides which nights may be overwritten. A false "replayable"
 * is the most expensive bug this feature can have: it authorises replacing a
 * settled result with figures derived from something we do not actually know.
 *
 * So each verdict is proved by a record that earns it, and the two rules that
 * matter most get their own tests — never infer rules from the club, and never
 * call a record replayable that the engine cannot reproduce.
 */

import { describe, expect, it } from 'vitest';
import { RecordUnderAudit, asRules, assess, evidenceFrom, summarise } from './replayability.js';
import { SettlementSettings, computeSettlement } from '../offlineSessions/settlementEngine.js';
import { computeSettlementAt } from './versionedEngine.js';

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
 * A record built the way settleSession builds one: run the engine, then store
 * what it produced. Anything the classifier calls replayable must have come
 * from here, or the fixture is lying about what the database contains.
 */
function settledRecord(
  pairs: [number, number][],
  rules: SettlementSettings = RULES,
  over: Partial<RecordUnderAudit> = {},
  overEvidence: Partial<RecordUnderAudit['evidence']> = {}
): RecordUnderAudit {
  const inputs = pairs.map(([buyIn, cashOut], i) => ({
    userId: `u${i}`,
    userDisplayName: `P${i}`,
    buyIn,
    cashOut,
  }));
  const result = computeSettlement(inputs, rules, { mismatchAcknowledged: true });

  return {
    id: 'rec-1',
    clubId: 'club-1',
    kind: 'cashout',
    isDeleted: false,
    sessionType: 'Offline Session',
    occurredAt: '2026-08-01T00:00:00.000Z',
    players: result.players.map((p) => ({
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
      rulesSource: 'session-snapshot',
      auditPlayerOrder: result.players.map((p) => p.userId),
      neverEngineSettled: false,
      editedSinceSettle: false,
      ...overEvidence,
    },
    ...over,
  };
}

describe('replayable', () => {
  it('accepts a record the engine reproduces, and says it verified it', () => {
    const a = assess(settledRecord([[5000, 8000], [5000, 2000]]));
    expect(a.verdict).toBe('replayable');
    expect(a.replay).toBe('matched');
    expect(a.blockers).toEqual([]);
    expect(a.worstDelta).toBe(0);
  });

  it('corroborates participant order against the audit copy', () => {
    expect(assess(settledRecord([[5000, 8000], [5000, 2000]])).orderCorroborated).toBe(true);
  });

  it('does not claim corroboration when the audit order disagrees', () => {
    const record = settledRecord([[5000, 8000], [5000, 2000]]);
    record.evidence.auditPlayerOrder = ['u1', 'u0'];
    expect(assess(record).orderCorroborated).toBe(false);
  });

  it('measures order sensitivity rather than assuming it', () => {
    // v3 divides nothing and this table has no tie, so seat order is inert.
    expect(assess(settledRecord([[5000, 8000], [5000, 2000]])).orderSensitive).toBe(false);

    // v1 hands the indivisible remainder to the last seat.
    const v1Rules = { ...RULES, sessionRakeAmount: 100 };
    const inputs = [
      { userId: 'u0', userDisplayName: 'P0', buyIn: 5000, cashOut: 6000 },
      { userId: 'u1', userDisplayName: 'P1', buyIn: 5000, cashOut: 5000 },
      { userId: 'u2', userDisplayName: 'P2', buyIn: 5000, cashOut: 4000 },
    ];
    const rec = settledRecord([[5000, 6000], [5000, 5000], [5000, 4000]], v1Rules, {}, { engineVersion: 1 });
    // Restore what v1 would actually have stored, so the replay can match.
    const v1 = computeSettlementAt(1, inputs, v1Rules, {});
    rec.players = v1.players.map((p: any) => ({
      userId: p.userId, name: p.userDisplayName, totalBuyIn: p.totalBuyIn, cashOut: p.cashOut, storedNet: p.netResult,
    }));
    rec.totals = { totalBuyIns: v1.totalBuyIns, totalCashOuts: v1.totalCashOuts };

    const a = assess(rec);
    expect(a.verdict).toBe('replayable');
    expect(a.orderSensitive).toBe(true);
  });
});

describe('partially recoverable — inputs survive, recomputation does not', () => {
  it('refuses a record with no engine version', () => {
    const a = assess(settledRecord([[5000, 8000], [5000, 2000]], RULES, {}, { engineVersion: null }));
    expect(a.verdict).toBe('partially-recoverable');
    expect(a.blockers).toContain('engine-version-unknown');
    expect(a.replay).toBe('not-attempted');
  });

  it('refuses a record with no rules — and NEVER falls back to the club', () => {
    const a = assess(settledRecord([[5000, 8000], [5000, 2000]], RULES, {}, { rules: null, rulesSource: null }));
    expect(a.verdict).toBe('partially-recoverable');
    expect(a.blockers).toContain('rules-unknown');
  });

  it('refuses a record whose winners were chosen by hand', () => {
    const manual: SettlementSettings = { ...RULES, winnerDefinition: 'MANUAL' };
    const a = assess(settledRecord([[5000, 8000], [5000, 2000]], manual));
    expect(a.verdict).toBe('partially-recoverable');
    expect(a.blockers).toContain('manual-winners-lost');
  });

  it('refuses a record whose result turned on a pot balance nobody stored', () => {
    const potFunded: SettlementSettings = { ...RULES, mismatchStrategy: 'EXCESS_FROM_POT' };
    // Cash-outs exceed buy-ins, so the pot-versus-winners branch actually fires.
    const a = assess(settledRecord([[5000, 9000], [5000, 3000]], potFunded));
    expect(a.blockers).toContain('pot-balance-unknown');
  });

  it('ignores the pot balance when the strategy never consults it', () => {
    const a = assess(settledRecord([[5000, 9000], [5000, 3000]]));
    expect(a.blockers).not.toContain('pot-balance-unknown');
  });

  it('catches a record that looks complete and still does not reproduce', () => {
    const record = settledRecord([[5000, 8000], [5000, 2000]]);
    record.players[0].storedNet = (record.players[0].storedNet as number) + 1;

    const a = assess(record);
    expect(a.verdict).toBe('partially-recoverable');
    expect(a.blockers).toContain('replay-mismatch');
    expect(a.replay).toBe('mismatched');
    expect(a.worstDelta).toBeCloseTo(1, 5);
  });
});

describe('unrecoverable — the record cannot even state what happened', () => {
  it('rejects a record with no players', () => {
    const record = settledRecord([[5000, 8000], [5000, 2000]]);
    record.players = [];
    expect(assess(record).blockers).toEqual(['inputs-missing']);
  });

  it('rejects a non-numeric buy-in', () => {
    const record = settledRecord([[5000, 8000], [5000, 2000]]);
    record.players[1].totalBuyIn = 'five thousand';
    const a = assess(record);
    expect(a.verdict).toBe('unrecoverable');
    expect(a.blockers).toEqual(['inputs-malformed']);
  });

  it('rejects players that do not sum to the record\'s own totals', () => {
    const record = settledRecord([[5000, 8000], [5000, 2000]]);
    record.totals.totalBuyIns = 99_999;
    const a = assess(record);
    expect(a.verdict).toBe('unrecoverable');
    expect(a.blockers).toEqual(['inputs-contradict-totals']);
  });

  it('stops at the inputs rather than reporting downstream blockers too', () => {
    const record = settledRecord([[5000, 8000], [5000, 2000]], RULES, {}, { engineVersion: null, rules: null });
    record.players = [];
    // One clear reason beats four, when three of them are consequences.
    expect(assess(record).blockers).toEqual(['inputs-missing']);
  });
});

describe('never engine-settled', () => {
  it('separates a Virtual Table record from a degraded settlement', () => {
    const a = assess(
      settledRecord([[5000, 8000], [5000, 2000]], RULES, { sessionType: 'Virtual Table Session' }, {
        neverEngineSettled: true,
        engineVersion: null,
        rules: null,
        rulesSource: null,
      })
    );
    expect(a.verdict).toBe('never-engine-settled');
    expect(a.blockers).toEqual([]);
    expect(a.notes.join(' ')).toMatch(/FIRST settlement wearing the word "correction"/);
  });
});

describe('reading the evidence off a row', () => {
  const settleAudit = (over: Record<string, unknown> = {}) => ({
    action: 'settle_session',
    changes: {
      meta: { auditSchemaVersion: 1, settlementEngineVersion: 3, settlementRules: RULES, ...over },
      players: [{ userId: 'u0' }, { userId: 'u1' }],
    },
  });

  it('takes the engine version and the rules out of the settle audit', () => {
    const e = evidenceFrom({ auditRows: [settleAudit()], sessionSnapshot: null, sessionType: 'Offline Session', kind: 'cashout' });
    expect(e.engineVersion).toBe(3);
    expect(e.rulesSource).toBe('audit');
    expect(e.auditPlayerOrder).toEqual(['u0', 'u1']);
  });

  it('prefers the session snapshot, because that is the object the engine was handed', () => {
    const e = evidenceFrom({ auditRows: [settleAudit()], sessionSnapshot: RULES, sessionType: 'Offline Session', kind: 'cashout' });
    expect(e.rulesSource).toBe('session-snapshot');
    expect(e.rulesDisagree).toBe(false);
  });

  it('reports a snapshot and an audit copy that disagree — which should be impossible', () => {
    const e = evidenceFrom({
      auditRows: [settleAudit()],
      sessionSnapshot: { ...RULES, sessionRakeAmount: 999 },
      sessionType: 'Offline Session',
      kind: 'cashout',
    });
    expect(e.rulesDisagree).toBe(true);
  });

  it('refuses a rules object that is missing even one field', () => {
    const { roundingRule, ...incomplete } = RULES;
    expect(asRules(incomplete)).toBeNull();
    expect(asRules(RULES)).not.toBeNull();
    expect(asRules(null)).toBeNull();
    expect(asRules('PROPORTIONAL_WINNERS')).toBeNull();
  });

  it('reads no rules from a back-dated record, because record_past_session never stored any', () => {
    // Verified against clubRecords.service.ts: the createPastSession audit meta
    // carries auditSchemaVersion, settlementEngineVersion and createdFrom — and
    // no settlementRules. The engine version survives; the rules do not.
    const e = evidenceFrom({
      auditRows: [{ action: 'record_past_session', changes: { meta: { auditSchemaVersion: 1, settlementEngineVersion: 3, createdFrom: 'createPastSession' } } }],
      sessionSnapshot: null,
      sessionType: 'Offline Session',
      kind: 'historical',
    });
    expect(e.engineVersion).toBe(3);
    expect(e.rules).toBeNull();
    expect(e.rulesSource).toBeNull();
  });

  it('flags a Virtual Table record with no creation audit as never engine-settled', () => {
    const e = evidenceFrom({ auditRows: [], sessionSnapshot: null, sessionType: 'Virtual Table Session', kind: 'cashout' });
    expect(e.neverEngineSettled).toBe(true);
  });

  it('does NOT flag a Virtual Table record that does have a settle audit', () => {
    const e = evidenceFrom({ auditRows: [settleAudit()], sessionSnapshot: null, sessionType: 'Virtual Table Session', kind: 'cashout' });
    expect(e.neverEngineSettled).toBe(false);
  });

  it('flags a PDF-transcribed historical record as never engine-settled', () => {
    const e = evidenceFrom({ auditRows: [], sessionSnapshot: null, sessionType: 'Offline Session', kind: 'historical', importedBy: 'system' });
    expect(e.neverEngineSettled).toBe(true);
  });

  it('does NOT flag a genuinely back-dated record, even without an audit', () => {
    // createPastSession stores the requesting user's id, and it DID run the
    // engine — it simply predates the audit that would say which version.
    const e = evidenceFrom({ auditRows: [], sessionSnapshot: null, sessionType: 'Offline Session', kind: 'historical', importedBy: 'cms6cot740000pf9m4k2ggwrr' });
    expect(e.neverEngineSettled).toBe(false);
  });

  it('does not read importedBy on a cash-out record', () => {
    const e = evidenceFrom({ auditRows: [], sessionSnapshot: null, sessionType: 'Offline Session', kind: 'cashout', importedBy: 'system' });
    expect(e.neverEngineSettled).toBe(false);
  });

  it('notices a record that has been edited since it was settled', () => {
    const e = evidenceFrom({
      auditRows: [settleAudit(), { action: 'edit_session', changes: null }],
      sessionSnapshot: null,
      sessionType: 'Offline Session',
      kind: 'cashout',
    });
    expect(e.editedSinceSettle).toBe(true);
  });

  it('returns nothing at all for a record with no audit and no snapshot', () => {
    const e = evidenceFrom({ auditRows: [], sessionSnapshot: null, sessionType: 'Offline Session', kind: 'cashout' });
    expect(e.engineVersion).toBeNull();
    expect(e.rules).toBeNull();
    expect(e.auditPlayerOrder).toBeNull();
    expect(e.neverEngineSettled).toBe(false);
  });
});

describe('summarise', () => {
  it('counts every verdict and every reason', () => {
    const rows = [
      assess(settledRecord([[5000, 8000], [5000, 2000]])),
      assess(settledRecord([[5000, 8000], [5000, 2000]], RULES, {}, { rules: null, rulesSource: null })),
      assess(settledRecord([[5000, 8000], [5000, 2000]], RULES, {}, { engineVersion: null })),
    ];
    const s = summarise(rows);
    expect(s.total).toBe(3);
    expect(s.byVerdict.replayable).toBe(1);
    expect(s.byVerdict['partially-recoverable']).toBe(2);
    expect(s.byBlocker['rules-unknown']).toBe(1);
    expect(s.byBlocker['engine-version-unknown']).toBe(1);
    expect(s.replayMatched).toBe(1);
  });
});
