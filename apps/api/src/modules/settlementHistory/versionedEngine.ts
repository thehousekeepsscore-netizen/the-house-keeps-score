/**
 * The settlement engine, at any version it has ever shipped.
 *
 * THIS IS A STEP 1 INVESTIGATION INSTRUMENT, NOT PRODUCTION CODE.
 *
 * Nothing in the running application imports it. It exists so the
 * replayability audit can answer "can this record be reproduced?" with a
 * replay rather than an assertion — a record whose stored figures come back
 * out of the engine that produced them is *proven* replayable, and one that
 * does not has an input we have not identified.
 *
 * Step 2 (`Extract + version the settlement engine`) replaces this with the
 * real dispatch, shared between client and server, locked by golden fixtures.
 * When it does, delete this file — do not grow a fourth copy of the engine.
 *
 * ---
 *
 * The divergences, read out of git rather than remembered:
 *
 *   v1  a865e06^  the flat session rake is a TOTAL for the night, split across
 *                 the table, with the rounding remainder given to the LAST
 *                 player in the array. `total += flat`.
 *   v2  a865e06   the flat rake became a per-player seat fee. Nothing is
 *                 divided, so nothing rounds. `total += flat * players.length`.
 *   v3  a8d7734   `chargesRake` gains `potEnabled &&` — a house take with
 *                 nowhere to go is no longer taken.
 *
 * Everything else — winners, mismatch, ordering, rounding, the refund pass —
 * is byte-identical across all three, which is why one file with two
 * conditionals is honest here and three frozen copies would not be.
 *
 * `versionedEngine.test.ts` pins both claims: v3 reproduces the live engine
 * exactly across a cross product of tables and settings, and each divergence
 * moves the number it is supposed to move.
 */

import {
  computeSettlement as computeSettlementV3,
  MismatchResolution,
  RoundingRule,
  SettlementPlayerInput,
  SettlementPlayerResult,
  SettlementResult,
  SettlementSettings,
  SettlementStepLog,
  ComputeSettlementOptions,
} from '../offlineSessions/settlementEngine.js';

export type EngineVersion = 1 | 2 | 3;
export const KNOWN_ENGINE_VERSIONS: EngineVersion[] = [1, 2, 3];

export function isKnownEngineVersion(v: unknown): v is EngineVersion {
  return v === 1 || v === 2 || v === 3;
}

function roundTo(value: number, rule: RoundingRule): number {
  switch (rule) {
    case 'NEAREST_5':
      return Math.round(value / 5) * 5;
    case 'NEAREST_10':
      return Math.round(value / 10) * 10;
    case 'NEAREST_1':
      return Math.round(value);
    case 'NONE':
    default:
      return Math.round(value * 100) / 100;
  }
}

interface WorkingPlayer extends SettlementPlayerResult {
  remaining: number;
  manualWinner?: boolean;
}

function determineWinners(players: WorkingPlayer[], settings: SettlementSettings, steps: SettlementStepLog[]) {
  switch (settings.winnerDefinition) {
    case 'TOP_N': {
      const ranked = [...players].filter((p) => p.grossProfit > 0).sort((a, b) => b.grossProfit - a.grossProfit);
      const topIds = new Set(ranked.slice(0, Math.max(0, settings.winnerTopN)).map((p) => p.userId));
      players.forEach((p) => (p.isWinner = topIds.has(p.userId)));
      steps.push({ step: 'Winner Definition', detail: `Top ${settings.winnerTopN} finisher(s) by profit are winners.` });
      break;
    }
    case 'MANUAL': {
      players.forEach((p) => (p.isWinner = !!p.manualWinner));
      steps.push({ step: 'Winner Definition', detail: 'Winners are exactly the players manually marked as winners.' });
      break;
    }
    case 'CUSTOM':
      players.forEach((p) => (p.isWinner = p.grossProfit > 0));
      steps.push({ step: 'Winner Definition', detail: 'Custom winner rule not implemented — used "profit > 0" as a fallback.' });
      break;
    case 'PROFIT_POSITIVE':
    default:
      players.forEach((p) => (p.isWinner = p.grossProfit > 0));
      steps.push({ step: 'Winner Definition', detail: 'Players with profit greater than zero are winners.' });
  }
}

function resolveMismatch(
  players: WorkingPlayer[],
  settings: SettlementSettings,
  mismatchAmount: number,
  opts: ComputeSettlementOptions,
  steps: SettlementStepLog[]
): { resolution: MismatchResolution; potEffect: number; requiresManualResolution: boolean } {
  if (mismatchAmount === 0) return { resolution: 'none', potEffect: 0, requiresManualResolution: false };

  if (settings.mismatchStrategy === 'MANUAL') {
    if (!opts.mismatchAcknowledged) {
      steps.push({
        step: 'Mismatch',
        detail: `Manual resolution required: ${mismatchAmount > 0 ? 'cash-outs exceed buy-ins' : 'buy-ins exceed cash-outs'} by ${Math.abs(mismatchAmount)}. Awaiting admin acknowledgement.`,
      });
      return { resolution: 'manual_pending', potEffect: 0, requiresManualResolution: true };
    }
    steps.push({ step: 'Mismatch', detail: 'Manual resolution acknowledged by admin — no automatic adjustment applied.' });
    return { resolution: 'manual_pending', potEffect: 0, requiresManualResolution: false };
  }

  if (mismatchAmount < 0) {
    const shortfall = -mismatchAmount;
    if (settings.potEnabled) {
      steps.push({ step: 'Mismatch', detail: `Buy-ins exceed cash-outs by ${shortfall} — sent to the Club Pot.` });
      return { resolution: 'shortfall_to_pot', potEffect: shortfall, requiresManualResolution: false };
    }
    steps.push({ step: 'Mismatch', detail: `Buy-ins exceed cash-outs by ${shortfall}, but the Club Pot is disabled — untracked.` });
    return { resolution: 'shortfall_unresolved', potEffect: 0, requiresManualResolution: false };
  }

  const excess = mismatchAmount;

  if (settings.mismatchStrategy === 'EXCESS_FROM_POT' || settings.mismatchStrategy === 'SHORTFALL_TO_POT') {
    if (settings.potEnabled && (opts.currentPotBalance ?? 0) >= excess) {
      steps.push({ step: 'Mismatch', detail: `Cash-outs exceed buy-ins by ${excess} — covered from the Club Pot.` });
      return { resolution: 'excess_from_pot', potEffect: -excess, requiresManualResolution: false };
    }
    steps.push({
      step: 'Mismatch',
      detail: `Cash-outs exceed buy-ins by ${excess}. Club Pot is ${settings.potEnabled ? 'insufficient' : 'disabled'} to cover it — falling back to proportional deduction from winners.`,
    });
    return applyExcessToWinners(players, excess, 'proportional', steps);
  }

  if (settings.mismatchStrategy === 'EQUAL_WINNERS') return applyExcessToWinners(players, excess, 'equal_winners', steps);
  if (settings.mismatchStrategy === 'EQUAL_ALL') return applyExcessToWinners(players, excess, 'equal_all', steps);

  if (settings.mismatchStrategy === 'CUSTOM') {
    steps.push({ step: 'Mismatch', detail: 'Custom mismatch rule not implemented — used proportional-from-winners as a fallback.' });
  }
  return applyExcessToWinners(players, excess, 'proportional', steps);
}

function applyExcessToWinners(
  players: WorkingPlayer[],
  excess: number,
  mode: 'proportional' | 'equal_winners' | 'equal_all',
  steps: SettlementStepLog[]
): { resolution: MismatchResolution; potEffect: number; requiresManualResolution: boolean } {
  const amount = (n: number) => {
    const rounded = Math.round(n * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
  };
  const whoPaid = (charged: WorkingPlayer[]) =>
    charged.filter((p) => p.mismatchDeduction !== 0).map((p) => `${p.userDisplayName} -${amount(p.mismatchDeduction)}`).join(', ');

  if (mode === 'equal_all') {
    const share = excess / players.length;
    players.forEach((p) => (p.mismatchDeduction = share));
    steps.push({ step: 'Mismatch', detail: `Cash-outs exceed buy-ins by ${excess} — split equally across all ${players.length} player(s): ${whoPaid(players)}.` });
    return { resolution: 'excess_from_players', potEffect: 0, requiresManualResolution: false };
  }

  const winners = players.filter((p) => p.isWinner);
  if (winners.length === 0) {
    steps.push({ step: 'Mismatch', detail: `Cash-outs exceed buy-ins by ${excess}, but there are no winners to deduct from — left unresolved.` });
    return { resolution: 'excess_from_players', potEffect: 0, requiresManualResolution: false };
  }

  if (mode === 'equal_winners') {
    const share = excess / winners.length;
    winners.forEach((p) => (p.mismatchDeduction = share));
    steps.push({ step: 'Mismatch', detail: `Cash-outs exceed buy-ins by ${excess} — split equally across ${winners.length} winner(s): ${whoPaid(winners)}.` });
    return { resolution: 'excess_from_players', potEffect: 0, requiresManualResolution: false };
  }

  const remainingProfit = winners.reduce((sum, p) => sum + p.remaining, 0);
  const byRemaining = remainingProfit > 0;
  const basisTotal = byRemaining ? remainingProfit : winners.reduce((sum, p) => sum + Math.max(0, p.grossProfit), 0);
  const shares: string[] = [];
  if (basisTotal > 0) {
    winners.forEach((p) => {
      const basis = byRemaining ? p.remaining : Math.max(0, p.grossProfit);
      const share = basis / basisTotal;
      p.mismatchDeduction = share * excess;
      shares.push(`${p.userDisplayName} -${amount(p.mismatchDeduction)} (${amount(share * 100)}% of winning profit)`);
    });
  }
  steps.push({
    step: 'Mismatch',
    detail: basisTotal > 0
      ? `Cash-outs exceed buy-ins by ${excess} — deducted from winners in proportion to profit: ${shares.join(', ')}.`
      : `Cash-outs exceed buy-ins by ${excess}, but no winner has profit left to deduct from — left unresolved.`,
  });
  return { resolution: 'excess_from_players', potEffect: 0, requiresManualResolution: false };
}

/**
 * DIVERGENCE ONE (v1 → v2). The only function whose body differs by version.
 *
 * Note what v1 does with the remainder: it goes to `players[length - 1]`. That
 * makes participant ORDER an arithmetic input for any v1 night whose flat rake
 * does not divide evenly — not merely a TOP_N tie-break. The audit treats
 * ordering as significant for exactly those records.
 */
function computeRake(
  players: WorkingPlayer[],
  settings: SettlementSettings,
  version: EngineVersion,
  steps: SettlementStepLog[]
): number {
  let total = 0;
  const winners = players.filter((p) => p.isWinner);

  const cut = settings.winnersCutPercent ?? 0;
  if (cut > 0) {
    winners.forEach((p) => {
      if (p.remaining > 0) {
        p.rakeDeduction = p.remaining * (cut / 100);
        total += p.rakeDeduction;
      }
    });
    steps.push({ step: 'Rake', detail: `Winners' cut: ${cut}% of each winner's profit at this point in the pipeline.` });
  }

  const flat = settings.sessionRakeAmount ?? 0;
  if (flat > 0 && players.length > 0) {
    if (version === 1) {
      const share = flat / players.length;
      let assigned = 0;
      players.forEach((p, i) => {
        const owed = i === players.length - 1
          ? Math.round((flat - assigned) * 100) / 100
          : Math.round(share * 100) / 100;
        assigned = Math.round((assigned + owed) * 100) / 100;
        p.rakeDeduction = Math.round((p.rakeDeduction + owed) * 100) / 100;
      });
      total += flat;
      steps.push({
        step: 'Rake',
        detail: `Session rake: flat ${flat} for the night, split equally across ${players.length} players (${Math.round(share * 100) / 100} each).`,
      });
    } else {
      players.forEach((p) => {
        p.rakeDeduction = Math.round((p.rakeDeduction + flat) * 100) / 100;
      });
      total += flat * players.length;
      steps.push({
        step: 'Rake',
        detail: `Session rake: ${flat} per player from ${players.length} player(s) — ${flat * players.length} in total.`,
      });
    }
  }

  return total;
}

/**
 * Replays a settlement at a specific engine version.
 *
 * v3 delegates to the live engine rather than reimplementing it, so the current
 * version can never silently drift from the version this file claims it is.
 */
export function computeSettlementAt(
  version: EngineVersion,
  players: SettlementPlayerInput[],
  settings: SettlementSettings,
  opts: ComputeSettlementOptions = {}
): SettlementResult {
  if (version === 3) return computeSettlementV3(players, settings, opts);

  const steps: SettlementStepLog[] = [];

  const working: WorkingPlayer[] = players.map((p) => {
    const grossProfit = p.cashOut - p.buyIn;
    return {
      userId: p.userId,
      userDisplayName: p.userDisplayName,
      totalBuyIn: p.buyIn,
      cashOut: p.cashOut,
      grossProfit,
      isWinner: false,
      mismatchDeduction: 0,
      rakeDeduction: 0,
      netResult: grossProfit,
      remaining: grossProfit,
      manualWinner: p.manualWinner,
    };
  });

  const totalBuyIns = working.reduce((s, p) => s + p.totalBuyIn, 0);
  const totalCashOuts = working.reduce((s, p) => s + p.cashOut, 0);
  const mismatchAmount = totalCashOuts - totalBuyIns;

  determineWinners(working, settings, steps);

  let totalRakeCollected = 0;
  let mismatchResolution: MismatchResolution = 'none';
  let potEffectFromMismatch = 0;
  let requiresManualResolution = false;

  const runMismatch = () => {
    const result = resolveMismatch(working, settings, mismatchAmount, opts, steps);
    mismatchResolution = result.resolution;
    potEffectFromMismatch = result.potEffect;
    requiresManualResolution = result.requiresManualResolution;
    working.forEach((p) => {
      p.mismatchDeduction = roundTo(p.mismatchDeduction, settings.roundingRule);
    });

    if (mismatchAmount > 0 && requiresManualResolution === false) {
      const deducted = working.reduce((s, p) => s + p.mismatchDeduction, 0);
      const residual = Math.round((mismatchAmount - deducted) * 100) / 100;
      if (residual !== 0) {
        const target = working.filter((p) => p.mismatchDeduction > 0).sort((a, b) => b.mismatchDeduction - a.mismatchDeduction)[0];
        if (target) {
          target.mismatchDeduction = Math.round((target.mismatchDeduction + residual) * 100) / 100;
          steps.push({
            step: 'Mismatch',
            detail: `Rounding residual of ${residual} applied to ${target.userDisplayName} so cash-outs reconcile to buy-ins exactly.`,
          });
        }
      }
    }

    working.forEach((p) => {
      p.remaining -= p.mismatchDeduction;
    });
  };

  const runRake = () => {
    computeRake(working, settings, version, steps);
    working.forEach((p) => {
      p.rakeDeduction = roundTo(p.rakeDeduction, settings.roundingRule);
      p.remaining -= p.rakeDeduction;
    });
    totalRakeCollected = working.reduce((s, p) => s + p.rakeDeduction, 0);
  };

  /** DIVERGENCE TWO (v2 → v3). v3 adds the `potEnabled &&` term. */
  const chargesRake = (settings.sessionRakeAmount ?? 0) > 0 || (settings.winnersCutPercent ?? 0) > 0;

  if (settings.rakeOrder === 'RAKE_FIRST') {
    if (chargesRake) runRake();
    runMismatch();
  } else {
    runMismatch();
    if (chargesRake) runRake();
  }

  working.forEach((p) => {
    if (p.grossProfit <= 0 || p.rakeDeduction <= 0) return;
    const over = p.mismatchDeduction + p.rakeDeduction - p.grossProfit;
    if (over <= 0) return;

    const refund = Math.min(over, p.rakeDeduction);
    p.rakeDeduction = Math.round((p.rakeDeduction - refund) * 100) / 100;
    totalRakeCollected = Math.round((totalRakeCollected - refund) * 100) / 100;
    steps.push({
      step: 'Rake',
      detail: `Rake on ${p.userDisplayName} reduced by ${Math.round(refund * 100) / 100} — the profit it was charged on was reversed by the mismatch adjustment.`,
    });
  });

  working.forEach((p) => {
    p.netResult = p.grossProfit - p.mismatchDeduction - p.rakeDeduction;
  });

  const potContribution = settings.potEnabled ? totalRakeCollected + potEffectFromMismatch : 0;
  if (!settings.potEnabled && (totalRakeCollected !== 0 || potEffectFromMismatch !== 0)) {
    steps.push({ step: 'Pot', detail: 'Club Pot is disabled — no balance was updated.' });
  }

  return {
    totalBuyIns,
    totalCashOuts,
    mismatchAmount,
    mismatchResolution,
    requiresManualResolution,
    totalRakeCollected,
    potContribution,
    players: working.map((p) => ({
      userId: p.userId,
      userDisplayName: p.userDisplayName,
      totalBuyIn: p.totalBuyIn,
      cashOut: p.cashOut,
      grossProfit: p.grossProfit,
      isWinner: p.isWinner,
      mismatchDeduction: p.mismatchDeduction,
      rakeDeduction: p.rakeDeduction,
      netResult: p.netResult,
    })),
    steps,
  };
}
