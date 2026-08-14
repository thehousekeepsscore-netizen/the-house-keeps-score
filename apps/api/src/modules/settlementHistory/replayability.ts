/**
 * Can this settled night be recomputed from what we stored about it?
 *
 * Step 1 of the settlement-history work (SETTLEMENT-HISTORY-DESIGN.md §12).
 * Investigation only: nothing here is imported by the running application, and
 * nothing here writes.
 *
 * The question matters because the design overwrites settled nights. A record
 * that cannot be replayed must never be selected for correction — replaying a
 * guess would not add a questionable column beside the original, it would
 * *replace* the only figures anyone has.
 *
 * THE GOVERNING RULE, and the one that decides most of the verdicts below:
 *
 *   > Never infer a night's settlement rules from the club's current rules.
 *
 * The club's settings are frozen today (IMMUTABLE_CLUB_RULES), which makes the
 * inference *probably* right and therefore especially dangerous: it would be
 * right until the freeze is lifted in step 9, at which point every record
 * backfilled by inference silently starts claiming rules it never used. So a
 * record whose rules cannot be read out of its own data is not replayable, and
 * says so.
 *
 * Four verdicts, and the line between them is what survives in the data:
 *
 *   replayable
 *     Engine-settled, every input present, and a replay reproduces the stored
 *     figures to the cent. Correctable.
 *
 *   missing-required-input
 *     Engine-settled, and the inputs (who played, in and out) are intact and
 *     consistent with the record's own totals — but something needed to
 *     RECOMPUTE is absent. Revision 1 can be written and the night stays
 *     visible and correct; it cannot be corrected.
 *
 *   never-engine-settled
 *     No settlement engine ever ran (see VIRTUAL_TABLE_SESSION_TYPE and
 *     TRANSCRIBED_IMPORTER). Applying rules would be a FIRST settlement
 *     wearing the word "correction", so this is its own category rather than
 *     a degraded one. Legacy: visible, unchanged, and never correctable.
 *
 *   fundamentally-unrecoverable
 *     The record's own inputs are missing, malformed, or contradict its stored
 *     totals. Not even a faithful revision 1 can be written without a human
 *     stating what happened.
 *
 * EVERY record lands in exactly one of the four. Deleted records are assessed
 * like any other and reported as a cross-cut rather than filtered out — an
 * audit that quietly drops the hard rows is not an audit.
 */

import {
  SettlementSettings,
  SettlementResult,
  computeSettlementAt,
  EngineVersion,
  isKnownEngineVersion,
} from '../offlineSessions/settlementEngine.js';

export type RecordKind = 'cashout' | 'historical';

export type Verdict = 'replayable' | 'missing-required-input' | 'fundamentally-unrecoverable' | 'never-engine-settled';

/**
 * Every reason a record can fail to be replayable. Codes rather than prose so
 * the audit can count them and the report can quote them without drift.
 */
export type BlockerCode =
  /** No AuditLog row carries `changes.meta.settlementEngineVersion` for this record. */
  | 'engine-version-unknown'
  /** Neither the session snapshot nor the audit carries the rules this night used. */
  | 'rules-unknown'
  /** The stored player array is absent or empty — there is nothing to replay. */
  | 'inputs-missing'
  /** A player row has a non-numeric or negative buy-in/cash-out. */
  | 'inputs-malformed'
  /** Σ stored buy-ins or cash-outs disagrees with the record's own totals. */
  | 'inputs-contradict-totals'
  /** Rules say winners were chosen by hand, and the choice was never stored. */
  | 'manual-winners-lost'
  /** Rules consult the club pot balance at settle time, which was never stored. */
  | 'pot-balance-unknown'
  /** A player row has no userId, so seat position is its only identity. */
  | 'participant-identity-missing'
  /** Everything appeared present, and the replay still disagreed with the record. */
  | 'replay-mismatch';

export const BLOCKER_REASONS: Record<BlockerCode, string> = {
  'engine-version-unknown':
    'No audit row records which engine version produced this record. Settled before provenance was stamped (PR #12), or by a path that writes no audit at all.',
  'rules-unknown':
    'The rules this night was settled under are not in the data. The session carries no settlementRules snapshot and no audit row preserves them. The club\'s current rules are NOT an acceptable substitute.',
  'inputs-missing':
    'The record stores no player rows, so there are no buy-ins or cash-outs to replay.',
  'inputs-malformed':
    'A player row has a buy-in or cash-out that is not a finite, non-negative number.',
  'inputs-contradict-totals':
    'The stored player rows do not sum to the record\'s own stored totals, so at least one of the two is wrong and the data cannot say which.',
  'manual-winners-lost':
    'winnerDefinition is MANUAL, so the winners were chosen by hand — and manualWinner is not persisted in playerSummaries or playerStats. The winner set cannot be reconstructed.',
  'pot-balance-unknown':
    'The mismatch strategy consults the club pot balance at settle time to decide whether the pot covers an excess. That balance is not stored on the record, and the pot ledger cannot pin it to the instant the engine ran.',
  'participant-identity-missing':
    'One or more player rows carry no userId (an unlinked player). Seat position is then the only thing identifying them, so a reordering is both undetectable and uncorrectable — and TOP_N ties and the v1 seat-fee remainder both turn on position.',
  'replay-mismatch':
    'Every input appeared to be present, but replaying the record did not reproduce its stored figures. An input we have not identified is missing, or the record was written by a path that did not use the engine.',
};

/** A player row as it survives on the record, before any interpretation. */
export interface StoredPlayer {
  userId?: string | null;
  name: string;
  totalBuyIn: unknown;
  cashOut: unknown;
  /** netResult (cashout) or profit (historical) — what the record claims it paid. */
  storedNet: unknown;
}

export interface StoredTotals {
  totalBuyIns?: number | null;
  totalCashOuts?: number | null;
  rakeCollected?: number | null;
  potAdjustment?: number | null;
}

export interface RecordEvidence {
  /** From AuditLog.changes.meta.settlementEngineVersion, or null. */
  engineVersion: number | null;
  /** From PokerSession.engineState.settlementRules or AuditLog.changes.meta.settlementRules. */
  rules: SettlementSettings | null;
  rulesSource: 'session-snapshot' | 'audit' | null;
  /**
   * `changes.players[].userId` from the settle audit, written from the same
   * array as the record in the same transaction. Where both exist and agree,
   * participant ORDER is corroborated by a second copy rather than assumed.
   */
  auditPlayerOrder: string[] | null;
  /** True when the record came from a path that never ran the engine. */
  neverEngineSettled: boolean;
  /** True when an edit_session / delete_session / restore audit exists for it. */
  editedSinceSettle: boolean;
}

export interface RecordUnderAudit {
  id: string;
  clubId: string;
  kind: RecordKind;
  isDeleted: boolean;
  sessionType: string | null;
  occurredAt: string | null;
  players: StoredPlayer[];
  totals: StoredTotals;
  evidence: RecordEvidence;
}

export interface Assessment {
  id: string;
  clubId: string;
  kind: RecordKind;
  isDeleted: boolean;
  verdict: Verdict;
  blockers: BlockerCode[];
  notes: string[];
  playerCount: number;
  engineVersion: EngineVersion | null;
  rulesSource: RecordEvidence['rulesSource'];
  /** Did a replay reproduce the record? Only attempted when nothing else blocks. */
  replay: 'matched' | 'mismatched' | 'not-attempted';
  /** Largest per-player difference between replay and record, when attempted. */
  worstDelta: number | null;
  /**
   * Does the participant order change the arithmetic for THIS record? Measured
   * by replaying permutations, not reasoned about — so it catches mechanisms
   * nobody enumerated. `null` when no replay was possible.
   */
  orderSensitive: boolean | null;
  /** Order corroborated by a second stored copy (the settle audit). */
  orderCorroborated: boolean;
}

// ---------- Reading the evidence off a row ----------
//
// These live here rather than in the script so they can be tested. The script
// does I/O and nothing else; every judgement about what a stored row *means* is
// in this file, under test.

/** The 11 settlement fields, and only those. A partial object is not a rule set. */
export const RULE_FIELDS = [
  'sessionRakeAmount', 'winnersCutPercent', 'rakeEnabled', 'rakeMethod', 'rakeValue',
  'potEnabled', 'mismatchStrategy', 'rakeOrder', 'winnerDefinition', 'winnerTopN', 'roundingRule',
] as const;

/** The sessionType `sessions.service.endSession` stamps on records no engine touched. */
export const VIRTUAL_TABLE_SESSION_TYPE = 'Virtual Table Session';

/**
 * `importedBy` on the two nights `seed-history.ts` transcribed from a PDF.
 *
 * `createPastSession` — the real back-dating path — always stores the
 * requesting user's id here, so the literal string is unambiguous. Those two
 * records store `profit = cashOut - totalBuyIn` with no rule ever applied, so
 * they belong with the Virtual Table records rather than with nights whose
 * rules merely went unrecorded.
 */
export const TRANSCRIBED_IMPORTER = 'system';

export const CREATION_ACTIONS = ['settle_session', 'record_past_session'];
export const EDIT_ACTIONS = ['edit_session', 'delete_session', 'restore_session'];

/**
 * A rules object, or nothing.
 *
 * Deliberately all-or-nothing: eleven fields decide the money, and ten of them
 * plus a default for the eleventh is a guess wearing a snapshot's clothes.
 */
export function asRules(value: unknown): SettlementSettings | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (RULE_FIELDS.some((f) => v[f] === undefined || v[f] === null)) return null;
  return v as unknown as SettlementSettings;
}

export function ruleKey(r: SettlementSettings | null): string {
  return r ? RULE_FIELDS.map((f) => `${f}=${(r as unknown as Record<string, unknown>)[f]}`).join(',') : '';
}

export interface AuditRowLike {
  action: string;
  changes: unknown;
}

/**
 * What an audit row and a session snapshot together say about one record.
 *
 * The snapshot wins where both exist: it is the object settleSession actually
 * handed the engine, and the audit copy was serialised from it. They should be
 * identical, and `rulesDisagree` reports it when they are not — that would mean
 * one of the two was written by something other than the settle path.
 */
export function evidenceFrom(args: {
  auditRows: AuditRowLike[];
  sessionSnapshot: unknown;
  sessionType: string | null;
  kind: RecordKind;
  /** `HistoricalSessionRecord.importedBy`. Ignored for cash-out records. */
  importedBy?: string | null;
}): RecordEvidence & { rulesDisagree: boolean } {
  const creation = args.auditRows.find((r) => CREATION_ACTIONS.includes(r.action));
  const changes = (creation?.changes ?? null) as Record<string, unknown> | null;
  const meta =
    changes && typeof changes.meta === 'object' && changes.meta
      ? (changes.meta as Record<string, unknown>)
      : null;

  const fromSnapshot = asRules(args.sessionSnapshot);
  const fromAudit = asRules(meta?.settlementRules);

  const auditPlayers = changes?.players;
  const auditPlayerOrder = Array.isArray(auditPlayers)
    ? auditPlayers.map((p) => String((p as Record<string, unknown>).userId ?? ''))
    : null;

  return {
    engineVersion:
      typeof meta?.settlementEngineVersion === 'number' ? (meta.settlementEngineVersion as number) : null,
    rules: fromSnapshot ?? fromAudit,
    rulesSource: fromSnapshot ? 'session-snapshot' : fromAudit ? 'audit' : null,
    auditPlayerOrder,
    // Two paths write a record without ever running the engine, and neither
    // writes an audit row. The absence of a creation audit is required in both
    // cases, so a record that some future path DID settle properly is never
    // misread as transcribed.
    //
    //   endSession        Virtual Table nights — every deduction 0, net = raw profit
    //   seed-history.ts   the two PDF-transcribed nights — profit = cashOut - buyIn
    neverEngineSettled:
      !creation &&
      (args.kind === 'cashout'
        ? args.sessionType === VIRTUAL_TABLE_SESSION_TYPE
        : args.importedBy === TRANSCRIBED_IMPORTER),
    editedSinceSettle: args.auditRows.some((r) => EDIT_ACTIONS.includes(r.action)),
    rulesDisagree: Boolean(fromSnapshot && fromAudit && ruleKey(fromSnapshot) !== ruleKey(fromAudit)),
  };
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** Money is compared to the cent — the engine itself rounds to 2dp. */
const CENT = 0.005;
const same = (a: number, b: number) => Math.abs(a - b) < CENT;

/**
 * Does this record's rules make the club pot balance an input?
 *
 * Only the two pot-funded strategies consult it, only on an excess, and only
 * with the pot enabled. Everywhere else the missing balance is irrelevant and
 * flagging it would be noise.
 */
function needsPotBalance(rules: SettlementSettings, mismatchAmount: number): boolean {
  return (
    (rules.mismatchStrategy === 'EXCESS_FROM_POT' || rules.mismatchStrategy === 'SHORTFALL_TO_POT') &&
    mismatchAmount > 0 &&
    rules.potEnabled === true
  );
}

function fingerprint(result: SettlementResult): string {
  return result.players
    .map((p) => `${p.userId}:${p.netResult.toFixed(2)}:${p.rakeDeduction.toFixed(2)}:${p.mismatchDeduction.toFixed(2)}`)
    .join('|');
}

/**
 * Replays the same table in a different seat order and asks whether the money
 * moved. Reversal and a single rotation between them exercise both known
 * mechanisms — v1's remainder-to-the-last-player, and every "first match wins"
 * tie-break — without pretending to be an exhaustive permutation search.
 */
function measureOrderSensitivity(
  version: EngineVersion,
  players: { userId: string; userDisplayName: string; buyIn: number; cashOut: number }[],
  rules: SettlementSettings,
  baseline: SettlementResult
): boolean {
  if (players.length < 2) return false;

  const byId = (r: SettlementResult) =>
    [...r.players].sort((a, b) => a.userId.localeCompare(b.userId));
  const canonical = (r: SettlementResult) =>
    byId(r).map((p) => `${p.userId}:${p.netResult.toFixed(2)}:${p.rakeDeduction.toFixed(2)}`).join('|');

  const base = canonical(baseline);
  const permutations = [
    [...players].reverse(),
    [...players.slice(1), players[0]],
  ];

  return permutations.some((perm) => canonical(computeSettlementAt(version, perm, rules, {})) !== base);
}

/**
 * The verdict for one record.
 *
 * Deliberately does no I/O and takes no club: everything it needs has already
 * been read, so the rule about never consulting current club rules is
 * structural rather than a thing to remember.
 */
export function assess(record: RecordUnderAudit): Assessment {
  const blockers: BlockerCode[] = [];
  const notes: string[] = [];

  const base: Assessment = {
    id: record.id,
    clubId: record.clubId,
    kind: record.kind,
    isDeleted: record.isDeleted,
    verdict: 'fundamentally-unrecoverable',
    blockers,
    notes,
    playerCount: record.players.length,
    engineVersion: isKnownEngineVersion(record.evidence.engineVersion) ? record.evidence.engineVersion : null,
    rulesSource: record.evidence.rulesSource,
    replay: 'not-attempted',
    worstDelta: null,
    orderSensitive: null,
    orderCorroborated: false,
  };

  if (record.evidence.neverEngineSettled) {
    notes.push(
      record.kind === 'cashout'
        ? 'Written by sessions.service.endSession (Virtual Table). No engine ran: every deduction is 0, netResult is raw profit, and no audit row exists.'
        : 'Transcribed by seed-history.ts from a PDF ledger. No engine ran: profit is cashOut - totalBuyIn, and no audit row exists.'
    );
    notes.push(
      'Applying rules to this record would be a FIRST settlement wearing the word "correction". It is not a degraded settlement and must not be offered as a correctable one.'
    );
    return { ...base, verdict: 'never-engine-settled' };
  }

  // ---- Inputs first. Without them nothing else is worth checking. ----

  if (record.players.length === 0) {
    blockers.push('inputs-missing');
    return { ...base, verdict: 'fundamentally-unrecoverable' };
  }

  const parsed = record.players.map((p) => ({
    userId: p.userId,
    name: p.name,
    buyIn: num(p.totalBuyIn),
    cashOut: num(p.cashOut),
    storedNet: num(p.storedNet),
  }));

  if (parsed.some((p) => p.buyIn === null || p.cashOut === null || p.buyIn! < 0 || p.cashOut! < 0)) {
    blockers.push('inputs-malformed');
    return { ...base, verdict: 'fundamentally-unrecoverable' };
  }

  const sumBuyIn = parsed.reduce((s, p) => s + p.buyIn!, 0);
  const sumCashOut = parsed.reduce((s, p) => s + p.cashOut!, 0);

  if (record.totals.totalBuyIns != null && !same(sumBuyIn, record.totals.totalBuyIns)) {
    blockers.push('inputs-contradict-totals');
    notes.push(`Σ buy-ins ${sumBuyIn} vs stored totalBuyIns ${record.totals.totalBuyIns}.`);
  }
  if (record.totals.totalCashOuts != null && !same(sumCashOut, record.totals.totalCashOuts)) {
    if (!blockers.includes('inputs-contradict-totals')) blockers.push('inputs-contradict-totals');
    notes.push(`Σ cash-outs ${sumCashOut} vs stored totalCashOuts ${record.totals.totalCashOuts}.`);
  }
  if (blockers.includes('inputs-contradict-totals')) {
    return { ...base, verdict: 'fundamentally-unrecoverable' };
  }

  // ---- Now the things needed to RECOMPUTE. Inputs are known good from here. ----

  const version = base.engineVersion;
  if (version === null) {
    blockers.push('engine-version-unknown');
    if (record.evidence.engineVersion !== null) {
      notes.push(`Audit recorded engine version ${record.evidence.engineVersion}, which is not a version this codebase knows how to run.`);
    }
  }

  const rules = record.evidence.rules;
  if (!rules) blockers.push('rules-unknown');

  if (rules && rules.winnerDefinition === 'MANUAL') {
    blockers.push('manual-winners-lost');
  }

  // Identity, which is what makes ORDER checkable at all. A row with no userId
  // is identified by nothing but its position, so nothing can ever confirm the
  // position is the original one.
  if (parsed.some((p) => !p.userId)) {
    blockers.push('participant-identity-missing');
    const n = parsed.filter((p) => !p.userId).length;
    notes.push(`${n} of ${parsed.length} player row(s) have no userId — identified by seat position alone.`);
  }

  const mismatchAmount = sumCashOut - sumBuyIn;
  if (rules && needsPotBalance(rules, mismatchAmount)) {
    blockers.push('pot-balance-unknown');
    notes.push(
      `Excess of ${mismatchAmount} under ${rules.mismatchStrategy}: whether the pot covered it or the winners did turns on a balance nobody recorded.`
    );
  }

  if (record.evidence.editedSinceSettle) {
    notes.push(
      'Edited after settlement. applySessionChange re-ran the engine WITHOUT manualWinner and against the club pot balance as it stood at edit time, so the stored figures may not correspond to the original settle inputs.'
    );
  }

  // ---- Replay, where everything needed is present. ----

  if (blockers.length > 0 || !rules || version === null) {
    return { ...base, verdict: 'missing-required-input', orderCorroborated: corroborated(record, parsed) };
  }

  const inputs = parsed.map((p, i) => ({
    userId: p.userId || `unlinked:${i}:${p.name}`,
    userDisplayName: p.name,
    buyIn: p.buyIn!,
    cashOut: p.cashOut!,
  }));

  const replayed = computeSettlementAt(version, inputs, rules, { mismatchAcknowledged: true });

  let worst = 0;
  replayed.players.forEach((p, i) => {
    const stored = parsed[i].storedNet;
    if (stored === null) return;
    worst = Math.max(worst, Math.abs(p.netResult - stored));
  });

  const matched = replayed.players.every((p, i) => {
    const stored = parsed[i].storedNet;
    return stored !== null && same(p.netResult, stored);
  });

  const orderSensitive = measureOrderSensitivity(version, inputs, rules, replayed);

  if (!matched) {
    blockers.push('replay-mismatch');
    notes.push(`Worst per-player difference between replay and record: ${worst.toFixed(2)}.`);
    return {
      ...base,
      verdict: 'missing-required-input',
      replay: 'mismatched',
      worstDelta: worst,
      orderSensitive,
      orderCorroborated: corroborated(record, parsed),
    };
  }

  if (orderSensitive) {
    notes.push(
      'Participant order changes this record\'s arithmetic. Order must be preserved verbatim into revision 1 — it is data, not presentation.'
    );
  }

  return {
    ...base,
    verdict: 'replayable',
    replay: 'matched',
    worstDelta: worst,
    orderSensitive,
    orderCorroborated: corroborated(record, parsed),
  };
}

/**
 * Is the stored participant order backed by a second, independently written
 * copy? The settle audit writes `changes.players[]` from the same array in the
 * same transaction, so agreement is evidence and disagreement is a finding.
 */
function corroborated(record: RecordUnderAudit, parsed: { userId?: string | null }[]): boolean {
  const audit = record.evidence.auditPlayerOrder;
  if (!audit || audit.length !== parsed.length) return false;
  return audit.every((uid, i) => uid === (parsed[i].userId ?? undefined));
}

export interface AuditSummary {
  total: number;
  byVerdict: Record<Verdict, number>;
  byBlocker: Record<string, number>;
  deleted: number;
  orderSensitive: number;
  orderCorroborated: number;
  replayMatched: number;
  replayMismatched: number;
}

export function summarise(assessments: Assessment[]): AuditSummary {
  const byVerdict: Record<Verdict, number> = {
    replayable: 0,
    'missing-required-input': 0,
    'fundamentally-unrecoverable': 0,
    'never-engine-settled': 0,
  };
  const byBlocker: Record<string, number> = {};

  for (const a of assessments) {
    byVerdict[a.verdict] += 1;
    for (const b of a.blockers) byBlocker[b] = (byBlocker[b] ?? 0) + 1;
  }

  return {
    total: assessments.length,
    byVerdict,
    byBlocker,
    deleted: assessments.filter((a) => a.isDeleted).length,
    orderSensitive: assessments.filter((a) => a.orderSensitive === true).length,
    orderCorroborated: assessments.filter((a) => a.orderCorroborated).length,
    replayMatched: assessments.filter((a) => a.replay === 'matched').length,
    replayMismatched: assessments.filter((a) => a.replay === 'mismatched').length,
  };
}
