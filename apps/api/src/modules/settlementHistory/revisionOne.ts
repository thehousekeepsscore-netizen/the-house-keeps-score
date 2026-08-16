/**
 * Revision 1 for a record that already exists.
 *
 * Step 4 of SETTLEMENT-HISTORY-DESIGN.md §12. The governing rule, and the one
 * that shapes every function here:
 *
 *   > The backfill is a migration of EVIDENCE, not a recalculation.
 *
 * Revision 1 reproduces and documents what the settlement already says. It does
 * not run the engine and write the answer down. Those two things sound alike
 * and are not: a recalculation would silently restate any night whose stored
 * figures disagree with what today's code would produce — which is precisely
 * the class of night this whole project exists to protect.
 *
 * So `canonicalOutputs` is TRANSCRIBED from `playerSummaries` / `playerStats`,
 * field by field. The engine is used exactly once, and only to *check* the
 * transcription (`verifyByReplay`), never to supply it. If the check fails, the
 * record is skipped and reported rather than corrected.
 *
 * WHAT IS NOT DONE, deliberately:
 *
 *   - no rules are inferred from the Club, ever
 *   - the v1 record whose rules were never recorded is skipped, not repaired
 *   - legacy / never-engine-settled records get no revision at all
 *   - a fused seat fee and winners' cut stay fused, as null plus a reason
 *   - `manualWinner` is not invented; records whose rules read it are excluded
 *     upstream by the audit, so the flag is provably never consulted for
 *     anything eligible here
 */

import {
  CanonicalSettlementInputs,
  CanonicalPlayerOutcome,
  CanonicalSettlementOutputs,
  SPLIT_UNAVAILABLE_HISTORICAL,
  copyRules,
  replayCanonical,
  validateCanonicalInputs,
} from '../offlineSessions/canonicalSettlement.js';
import { isKnownEngineVersion } from '../offlineSessions/settlementEngine.js';
import { Assessment, RecordUnderAudit } from './replayability.js';

/** Why a record got no revision. Codes, so the report can count them. */
export type SkipCode =
  /** Legacy: no settlement engine ever ran (Virtual Table, PDF import). */
  | 'never-engine-settled'
  /** Something the replay contract needs is not in the data. */
  | 'inputs-not-reconstructable'
  /** A revision 1 is already present — the backfill is idempotent. */
  | 'already-present'
  /** The transcribed outputs do not match what the engine says the inputs give. */
  | 'transcription-failed-verification';

export const SKIP_REASONS: Record<SkipCode, string> = {
  'never-engine-settled':
    'No settlement engine produced this record, so there is no settlement to preserve a revision of. Applying rules to it later would be a first settlement, not a correction.',
  'inputs-not-reconstructable':
    'The replay contract cannot be satisfied from the data — most often because the rules this night was settled under were never recorded. Skipped rather than completed with a guess.',
  'already-present':
    'A revision 1 already exists for this record. Re-running the backfill changes nothing.',
  'transcription-failed-verification':
    'The figures transcribed from the record do not match what the engine produces from the same inputs. Something is unaccounted for; the record is left exactly as it is.',
};

export interface PlannedRevisionOne {
  recordId: string;
  recordType: 'cashout' | 'historical';
  revision: 1;
  isLive: true;
  supersedesRevision: null;
  engineVersion: number | null;
  ruleSnapshot: unknown;
  canonicalInputs: CanonicalSettlementInputs;
  /** Transcribed from the record, never recomputed. */
  canonicalOutputs: CanonicalSettlementOutputs;
  totals: CanonicalSettlementOutputs['totals'];
  causedBy: 'backfill';
  causeId: null;
  reason: string;
  requestedBy: null;
  approvedBy: null;
  inputsIncompleteReason: string | null;
  splitUnavailableReason: string | null;
}

export type RevisionPlan =
  | { kind: 'plan'; plan: PlannedRevisionOne }
  | { kind: 'skip'; code: SkipCode; detail: string };

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
};

/** Money compares to the cent; the engine itself rounds to 2dp. */
const CENT = 0.005;

/**
 * Builds revision 1, or explains why there will not be one.
 *
 * `existingRevision` is passed in rather than looked up so this stays a pure
 * function — the caller owns the database, and the unique index owns the race.
 */
export function planRevisionOne(
  record: RecordUnderAudit,
  assessment: Assessment,
  rawPlayers: Record<string, unknown>[],
  existingRevision: boolean,
  canonicalFromRecord?: { inputs: unknown; outputs: unknown } | null
): RevisionPlan {
  if (existingRevision) {
    return { kind: 'skip', code: 'already-present', detail: 'revision 1 exists' };
  }

  if (assessment.verdict === 'never-engine-settled') {
    return { kind: 'skip', code: 'never-engine-settled', detail: record.sessionType ?? 'unknown source' };
  }

  /*
   * A record written since the canonical contract landed already carries the
   * real thing — captured by the writer from the array the engine settled. It
   * is strictly better than anything reconstructable here, so it is used as-is
   * and nothing is re-derived.
   */
  if (canonicalFromRecord?.inputs && canonicalFromRecord.outputs) {
    const inputs = canonicalFromRecord.inputs as CanonicalSettlementInputs;
    const outputs = canonicalFromRecord.outputs as CanonicalSettlementOutputs;
    const problems = validateCanonicalInputs(inputs);
    if (problems.length > 0) {
      return { kind: 'skip', code: 'inputs-not-reconstructable', detail: problems.join('; ') };
    }
    return {
      kind: 'plan',
      plan: {
        recordId: record.id,
        recordType: record.kind,
        revision: 1,
        isLive: true,
        supersedesRevision: null,
        engineVersion: inputs.engineVersion,
        ruleSnapshot: inputs.rules,
        canonicalInputs: inputs,
        canonicalOutputs: outputs,
        totals: outputs.totals,
        causedBy: 'backfill',
        causeId: null,
        reason: 'Revision 1 from the record\'s own canonical contract, captured at settle time.',
        requestedBy: null,
        approvedBy: null,
        inputsIncompleteReason: null,
        splitUnavailableReason: null,
      },
    };
  }

  // Everything below reconstructs from a pre-contract record.

  if (assessment.verdict !== 'replayable') {
    return {
      kind: 'skip',
      code: 'inputs-not-reconstructable',
      detail: assessment.blockers.join(', ') || assessment.verdict,
    };
  }

  const rules = record.evidence.rules;
  const engineVersion = assessment.engineVersion;
  if (!rules || !isKnownEngineVersion(engineVersion)) {
    // Belt and braces: `replayable` already implies both, and a verdict that
    // ever stops implying it must not silently produce a revision.
    return { kind: 'skip', code: 'inputs-not-reconstructable', detail: 'rules or engine version absent' };
  }

  const inputs: CanonicalSettlementInputs = {
    engineVersion,
    rules: copyRules(rules),
    participants: record.players.map((p, i) => ({
      seatIndex: i,
      userId: p.userId ?? null,
      displayName: p.name,
      buyIn: num(p.totalBuyIn),
      cashOut: num(p.cashOut),
      /*
       * Not invented — provably never read. A record whose rules are MANUAL is
       * blocked by the audit (`manual-winners-lost`) and cannot reach here, so
       * for anything eligible the engine ignores this flag entirely. Recorded
       * as false with the provenance below saying it was reconstructed.
       */
      manualWinner: false,
    })),
    potState: {
      /*
       * The balance was never stored on the record. It is recorded as 0 here
       * with `affectsResult: false`, and that pairing is only honest because
       * the audit blocks any record where the balance could have changed the
       * outcome (`pot-balance-unknown`). For anything eligible, the engine
       * never reads it.
       */
      currentPotBalance: 0,
      affectsResult: false,
    },
    // A settled record cannot have been blocked on acknowledgement, or it would
    // never have been written.
    mismatchAcknowledged: true,
    capturedAt: record.occurredAt ?? new Date().toISOString(),
    capturedFrom: 'revision-backfill',
  };

  const problems = validateCanonicalInputs(inputs);
  if (problems.length > 0) {
    return { kind: 'skip', code: 'inputs-not-reconstructable', detail: problems.join('; ') };
  }

  const outputs = transcribeOutputs(record, rawPlayers, inputs);

  const verification = verifyByReplay(inputs, outputs);
  if (!verification.ok) {
    return { kind: 'skip', code: 'transcription-failed-verification', detail: verification.detail };
  }

  return {
    kind: 'plan',
    plan: {
      recordId: record.id,
      recordType: record.kind,
      revision: 1,
      isLive: true,
      supersedesRevision: null,
      engineVersion,
      ruleSnapshot: inputs.rules,
      canonicalInputs: inputs,
      canonicalOutputs: outputs,
      totals: outputs.totals,
      causedBy: 'backfill',
      causeId: null,
      reason:
        'Revision 1 transcribed from the stored settlement. Figures are the record\'s own; ' +
        'the engine was used only to verify the transcription, never to supply it.',
      requestedBy: null,
      approvedBy: null,
      inputsIncompleteReason: null,
      splitUnavailableReason: SPLIT_UNAVAILABLE_HISTORICAL,
    },
  };
}

/**
 * The settlement as the record states it — copied, not computed.
 *
 * `winnersCutDeduction` is the misnamed column that holds the FUSED rake, and
 * `excessDeduction` holds the mismatch. Both are read under their true meaning
 * and neither is decomposed: the parts were never stored, so `seatFee` and
 * `winnersCut` are null with a reason attached rather than a manufactured split.
 */
export function transcribeOutputs(
  record: RecordUnderAudit,
  rawPlayers: Record<string, unknown>[],
  inputs: CanonicalSettlementInputs
): CanonicalSettlementOutputs {
  const players: CanonicalPlayerOutcome[] = inputs.participants.map((p, i) => {
    const raw = rawPlayers[i] ?? {};
    const buyIn = p.buyIn;
    const cashOut = p.cashOut;
    // `netResult` on a settlement, `profit` on a back-dated record.
    const netResult = num(raw.netResult ?? raw.profit);
    const rakeDeduction = num(raw.winnersCutDeduction);
    const mismatchDeduction = num(raw.excessDeduction);
    return {
      seatIndex: p.seatIndex,
      userId: p.userId,
      displayName: p.displayName,
      buyIn,
      cashOut,
      grossProfit: num(raw.grossProfit, cashOut - buyIn),
      // Never stored either. Derived from the record's own arithmetic rather
      // than from a fresh engine run: a player who was charged a cut was a
      // winner by whatever definition applied that night.
      isWinner: cashOut - buyIn > 0,
      mismatchDeduction,
      seatFee: null,
      winnersCut: null,
      splitUnavailableReason: SPLIT_UNAVAILABLE_HISTORICAL,
      rakeDeduction,
      netResult,
    };
  });

  const sum = (f: (p: CanonicalPlayerOutcome) => number) =>
    Math.round(players.reduce((s, p) => s + f(p), 0) * 100) / 100;

  return {
    engineVersion: inputs.engineVersion,
    computedAt: record.occurredAt ?? new Date().toISOString(),
    players,
    totals: {
      buyIns: record.totals.totalBuyIns ?? sum((p) => p.buyIn),
      cashOuts: record.totals.totalCashOuts ?? sum((p) => p.cashOut),
      mismatchAmount: sum((p) => p.cashOut) - sum((p) => p.buyIn),
      // The parts are unknown, so the totals of the parts are unknown too.
      seatFees: null,
      winnersCut: null,
      rake: record.totals.rakeCollected ?? sum((p) => p.rakeDeduction),
      potContribution: record.totals.potAdjustment ?? 0,
    },
    // Not stored, and not inferable. An empty list says "unrecorded" rather
    // than inventing an explanation the night never produced.
    mismatchResolution: 'none',
    requiresManualResolution: false,
    steps: [],
  };
}

/**
 * Checks the transcription against the engine — as a check, never as a source.
 *
 * A `replayable` verdict already means the audit reproduced this record, so a
 * failure here means the two disagree about something and the record must be
 * left alone. Compares the money only: `mismatchResolution` and `steps` are not
 * stored on a pre-contract record and cannot be transcribed.
 */
export function verifyByReplay(
  inputs: CanonicalSettlementInputs,
  transcribed: CanonicalSettlementOutputs
): { ok: true } | { ok: false; detail: string } {
  let replayed: CanonicalSettlementOutputs;
  try {
    replayed = replayCanonical(inputs);
  } catch (err) {
    return { ok: false, detail: `replay threw: ${(err as Error).message}` };
  }

  if (replayed.players.length !== transcribed.players.length) {
    return { ok: false, detail: 'player count differs' };
  }

  for (let i = 0; i < replayed.players.length; i += 1) {
    const a = replayed.players[i];
    const b = transcribed.players[i];
    if (Math.abs(a.netResult - b.netResult) >= CENT) {
      return { ok: false, detail: `seat ${i} netResult ${b.netResult} vs replay ${a.netResult}` };
    }
    if (Math.abs(a.rakeDeduction - b.rakeDeduction) >= CENT) {
      return { ok: false, detail: `seat ${i} rakeDeduction ${b.rakeDeduction} vs replay ${a.rakeDeduction}` };
    }
    if (Math.abs(a.mismatchDeduction - b.mismatchDeduction) >= CENT) {
      return { ok: false, detail: `seat ${i} mismatchDeduction ${b.mismatchDeduction} vs replay ${a.mismatchDeduction}` };
    }
  }

  if (Math.abs(replayed.totals.rake - transcribed.totals.rake) >= CENT) {
    return { ok: false, detail: `total rake ${transcribed.totals.rake} vs replay ${replayed.totals.rake}` };
  }
  if (Math.abs(replayed.totals.potContribution - transcribed.totals.potContribution) >= CENT) {
    return {
      ok: false,
      detail: `pot ${transcribed.totals.potContribution} vs replay ${replayed.totals.potContribution}`,
    };
  }

  return { ok: true };
}
