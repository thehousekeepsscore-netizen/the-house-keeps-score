/**
 * The replay contract: everything the engine reads, and everything it returns.
 *
 * Step 3 of SETTLEMENT-HISTORY-DESIGN.md §12. One promise, and the rest of this
 * file exists to keep it:
 *
 *     inputs + rules + engineVersion  →  engine  →  outputs
 *
 * with **no dependency on the current Club configuration and no dependency on
 * any other mutable database state**. `replayCanonical` takes a single argument
 * and reads nothing else. That is not a convention to remember — it is the
 * signature, so a future edit that reaches for the club has nowhere to reach
 * from.
 *
 * WHY INPUTS AND OUTPUTS HAD TO BE SEPARATED
 *
 * `CashOutSettlement.playerSummaries` holds `totalBuyIn` and `cashOut` (inputs)
 * in the same JSON blob as `netResult` and `winnersCutDeduction` (outputs).
 * Rewriting the blob rewrites the replay basis along with the result. Today that
 * survives only because a rule change happens to write the same inputs back —
 * a coincidence of the current code, not a property, and not one to build a
 * financial ledger on (§13.1).
 *
 * WHAT COUNTS AS AN INPUT
 *
 * Everything `computeSettlement` reads, established by reading its signature
 * rather than by recalling it:
 *
 *   engineVersion            which semantics — an 8x rake difference across v1/v2
 *   rules                    all 11 fields, verbatim, never a club reference
 *   participants             identity, buy-in, cash-out, manualWinner
 *   participant ORDER        arithmetic, not presentation (see below)
 *   currentPotBalance        read by the two pot-funded mismatch strategies
 *   mismatchAcknowledged     gates MANUAL mismatch resolution
 *
 * ORDER IS DATA. Three mechanisms turn on position: TOP_N breaks ties by array
 * index, v1 hands the flat rake's rounding remainder to the LAST seat, and the
 * mismatch rounding residual goes to the largest deduction with ties broken by
 * position. One production record depends on the second of those. So each
 * participant carries an explicit `seatIndex` as well as sitting in an ordered
 * array — redundant on purpose, so a serialisation that loses array order is
 * detectable instead of silent.
 */

import {
  computeSettlementAt,
  CURRENT_ENGINE_VERSION,
  EngineVersion,
  isKnownEngineVersion,
  MismatchResolution,
  SettlementPlayerInput,
  SettlementResult,
  SettlementSettings,
  SettlementStepLog,
} from './settlementEngine.js';

/** The 11 rule fields, named once so validation and copying cannot drift apart. */
export const CANONICAL_RULE_FIELDS = [
  'sessionRakeAmount', 'winnersCutPercent', 'rakeEnabled', 'rakeMethod', 'rakeValue',
  'potEnabled', 'mismatchStrategy', 'rakeOrder', 'winnerDefinition', 'winnerTopN', 'roundingRule',
] as const;

/** Which code path captured a canonical record. Forensics, not behaviour. */
export type CanonicalOrigin =
  | 'settleSession'
  | 'createPastSession'
  | 'applySessionChange'
  | 'revision-backfill';

export interface CanonicalParticipant {
  /**
   * Position in the original array, recorded explicitly.
   *
   * Redundant with the array's own order, deliberately: if anything ever
   * reorders or re-serialises the array, a mismatch between index and position
   * is a detectable fault rather than a settlement that quietly moves money to
   * a different person.
   */
  seatIndex: number;
  /** `null` for an unlinked player — then seatIndex is the only identity. */
  userId: string | null;
  displayName: string;
  buyIn: number;
  cashOut: number;
  /**
   * Read by the engine only when `winnerDefinition === 'MANUAL'`, and recorded
   * always. It was persisted nowhere before, which is why a MANUAL-rules night
   * settled by the old code is unreplayable — the winner set is simply gone.
   */
  manualWinner: boolean;
}

export interface CanonicalPotState {
  /**
   * The club pot balance the engine was handed.
   *
   * Only the two pot-funded mismatch strategies consult it, and only on an
   * excess — but it is recorded unconditionally, because "we did not save it
   * because it did not matter" is indistinguishable afterwards from "we did not
   * save it".
   */
  currentPotBalance: number;
  /**
   * Whether the balance could have changed this result. Derived at capture time
   * from the rules and the figures, so a reader can tell a load-bearing value
   * from an incidental one without re-deriving the engine's branching.
   */
  affectsResult: boolean;
}

export interface CanonicalSettlementInputs {
  engineVersion: EngineVersion;
  /** A verbatim copy. Never a club id, never a lookup. */
  rules: SettlementSettings;
  /** Ordered. Position is arithmetic. */
  participants: CanonicalParticipant[];
  potState: CanonicalPotState;
  mismatchAcknowledged: boolean;
  capturedAt: string;
  capturedFrom: CanonicalOrigin;
}

/** Recorded on a player whose two house charges cannot be told apart. */
export const SPLIT_UNAVAILABLE_HISTORICAL =
  'Settled before the seat fee and winners cut were stored separately. The record ' +
  'holds only their sum (playerSummaries.winnersCutDeduction), and the parts cannot ' +
  'be derived from the total. Not manufactured.';

export interface CanonicalPlayerOutcome {
  seatIndex: number;
  userId: string | null;
  displayName: string;
  /** Echoed from the inputs so an outcome row is readable on its own. */
  buyIn: number;
  cashOut: number;
  grossProfit: number;
  isWinner: boolean;
  mismatchDeduction: number;
  /**
   * The two house charges, apart. `null` only on a historical record whose
   * stored figure fused them — never zero as a stand-in, because zero is a
   * real answer and "unknown" is not.
   */
  seatFee: number | null;
  winnersCut: number | null;
  /** Present exactly when seatFee/winnersCut are null. */
  splitUnavailableReason?: string;
  /** Their sum. Always known, because this is what was always stored. */
  rakeDeduction: number;
  netResult: number;
}

export interface CanonicalSettlementOutputs {
  /** Which engine produced these figures. Must equal the inputs' version. */
  engineVersion: EngineVersion;
  computedAt: string;
  players: CanonicalPlayerOutcome[];
  totals: {
    buyIns: number;
    cashOuts: number;
    mismatchAmount: number;
    seatFees: number | null;
    winnersCut: number | null;
    rake: number;
    potContribution: number;
  };
  mismatchResolution: MismatchResolution;
  requiresManualResolution: boolean;
  /** The engine's own explanation of what it did, in order. */
  steps: SettlementStepLog[];
}

/**
 * Does the club pot balance actually reach this result?
 *
 * Mirrors the engine's own condition in `resolveMismatch`: only the two
 * pot-funded strategies, only on an excess, only with the pot enabled.
 */
export function potBalanceAffectsResult(rules: SettlementSettings, mismatchAmount: number): boolean {
  return (
    (rules.mismatchStrategy === 'EXCESS_FROM_POT' || rules.mismatchStrategy === 'SHORTFALL_TO_POT') &&
    mismatchAmount > 0 &&
    rules.potEnabled === true
  );
}

/** A verbatim copy of the 11 fields, with nothing else carried along. */
export function copyRules(rules: SettlementSettings): SettlementSettings {
  const out = {} as Record<string, unknown>;
  for (const f of CANONICAL_RULE_FIELDS) out[f] = (rules as unknown as Record<string, unknown>)[f];
  return out as unknown as SettlementSettings;
}

/**
 * Captures the inputs for a settlement about to run, or one that just did.
 *
 * Takes the same arguments the engine takes, so there is no second place where
 * "what the engine reads" is decided.
 */
export function buildCanonicalInputs(args: {
  engineVersion?: EngineVersion;
  rules: SettlementSettings;
  players: SettlementPlayerInput[];
  currentPotBalance: number;
  mismatchAcknowledged?: boolean;
  capturedFrom: CanonicalOrigin;
  capturedAt?: Date;
}): CanonicalSettlementInputs {
  const participants: CanonicalParticipant[] = args.players.map((p, i) => ({
    seatIndex: i,
    userId: p.userId ?? null,
    displayName: p.userDisplayName,
    buyIn: p.buyIn,
    cashOut: p.cashOut,
    manualWinner: p.manualWinner === true,
  }));

  const mismatchAmount =
    participants.reduce((s, p) => s + p.cashOut, 0) - participants.reduce((s, p) => s + p.buyIn, 0);

  return {
    engineVersion: args.engineVersion ?? CURRENT_ENGINE_VERSION,
    rules: copyRules(args.rules),
    participants,
    potState: {
      currentPotBalance: args.currentPotBalance,
      affectsResult: potBalanceAffectsResult(args.rules, mismatchAmount),
    },
    mismatchAcknowledged: args.mismatchAcknowledged === true,
    capturedAt: (args.capturedAt ?? new Date()).toISOString(),
    capturedFrom: args.capturedFrom,
  };
}

/**
 * Runs the engine from canonical inputs and nothing else.
 *
 * The single argument IS the guarantee. There is no club parameter, no
 * transaction, no `prisma` import in this file — so a replay cannot pick up
 * today's settings for a night played under yesterday's, which is the failure
 * the whole design exists to prevent.
 *
 * Participant order is taken from the array, and `seatIndex` is checked against
 * it first: a serialisation that reordered the participants would otherwise
 * replay a different settlement without complaining.
 */
export function replayCanonical(inputs: CanonicalSettlementInputs): CanonicalSettlementOutputs {
  const problems = validateCanonicalInputs(inputs);
  if (problems.length > 0) {
    throw new Error(`Canonical inputs are not replayable: ${problems.join('; ')}`);
  }

  const result = computeSettlementAt(
    inputs.engineVersion,
    inputs.participants.map((p) => ({
      // An unlinked player still needs a stable key for the engine's own
      // bookkeeping (TOP_N builds a Set of ids). Derived from the seat, which
      // is the only identity such a player has.
      userId: p.userId ?? `seat:${p.seatIndex}`,
      userDisplayName: p.displayName,
      buyIn: p.buyIn,
      cashOut: p.cashOut,
      manualWinner: p.manualWinner,
    })),
    inputs.rules,
    {
      currentPotBalance: inputs.potState.currentPotBalance,
      mismatchAcknowledged: inputs.mismatchAcknowledged,
    }
  );

  return canonicalOutputsFrom(result, inputs);
}

/** Shapes an engine result as canonical outputs, keeping seat identity attached. */
export function canonicalOutputsFrom(
  result: SettlementResult,
  inputs: CanonicalSettlementInputs,
  computedAt: Date = new Date()
): CanonicalSettlementOutputs {
  return {
    engineVersion: inputs.engineVersion,
    computedAt: computedAt.toISOString(),
    players: result.players.map((p, i) => ({
      seatIndex: inputs.participants[i].seatIndex,
      userId: inputs.participants[i].userId,
      displayName: p.userDisplayName,
      buyIn: p.totalBuyIn,
      cashOut: p.cashOut,
      grossProfit: p.grossProfit,
      isWinner: p.isWinner,
      mismatchDeduction: p.mismatchDeduction,
      seatFee: p.seatFee,
      winnersCut: p.winnersCut,
      rakeDeduction: p.rakeDeduction,
      netResult: p.netResult,
    })),
    totals: {
      buyIns: result.totalBuyIns,
      cashOuts: result.totalCashOuts,
      mismatchAmount: result.mismatchAmount,
      seatFees: result.totalSeatFees,
      winnersCut: result.totalWinnersCut,
      rake: result.totalRakeCollected,
      potContribution: result.potContribution,
    },
    mismatchResolution: result.mismatchResolution,
    requiresManualResolution: result.requiresManualResolution,
    steps: result.steps,
  };
}

/**
 * Is this input set complete enough to replay?
 *
 * Returns the reasons it is not, so a caller can report them rather than
 * discover them as a wrong number. Deliberately strict about the rules: ten
 * fields plus a default for the eleventh is a guess wearing a snapshot's
 * clothes.
 */
export function validateCanonicalInputs(inputs: unknown): string[] {
  const problems: string[] = [];
  if (!inputs || typeof inputs !== 'object') return ['not an object'];
  const v = inputs as Partial<CanonicalSettlementInputs>;

  if (!isKnownEngineVersion(v.engineVersion)) {
    problems.push(`engineVersion ${String(v.engineVersion)} is not a version this engine can run`);
  }

  if (!v.rules || typeof v.rules !== 'object') {
    problems.push('rules are missing');
  } else {
    const r = v.rules as unknown as Record<string, unknown>;
    const missing = CANONICAL_RULE_FIELDS.filter((f) => r[f] === undefined || r[f] === null);
    if (missing.length > 0) problems.push(`rules are incomplete: ${missing.join(', ')}`);
  }

  if (!Array.isArray(v.participants) || v.participants.length === 0) {
    problems.push('participants are missing');
  } else {
    v.participants.forEach((p, i) => {
      if (p.seatIndex !== i) {
        problems.push(`participant at position ${i} claims seatIndex ${p.seatIndex} — order is not intact`);
      }
      if (!Number.isFinite(p.buyIn) || p.buyIn < 0) problems.push(`seat ${i} has an invalid buyIn`);
      if (!Number.isFinite(p.cashOut) || p.cashOut < 0) problems.push(`seat ${i} has an invalid cashOut`);
      if (typeof p.manualWinner !== 'boolean') problems.push(`seat ${i} is missing manualWinner`);
    });

    // MANUAL winners are the one rule that cannot survive a missing flag, and
    // the flag being absent is exactly what makes historical MANUAL nights
    // unreplayable. Caught here rather than replayed with nobody winning.
    if (v.rules && (v.rules as SettlementSettings).winnerDefinition === 'MANUAL') {
      const anyMarked = v.participants.some((p) => p.manualWinner === true);
      if (!anyMarked) {
        problems.push(
          'winnerDefinition is MANUAL and no participant is marked a winner — replaying this would settle the night with no winners at all'
        );
      }
    }
  }

  if (!v.potState || typeof v.potState.currentPotBalance !== 'number') {
    problems.push('potState.currentPotBalance is missing');
  }
  if (typeof v.mismatchAcknowledged !== 'boolean') {
    problems.push('mismatchAcknowledged is missing');
  }

  return problems;
}
