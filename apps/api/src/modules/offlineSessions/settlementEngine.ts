// Config-driven Cashout Engine.
//
// No rule in here is hardcoded to a specific percentage, strategy, or
// method — every behavior is selected by the group owner's Settlement
// Rules (a Club's rakeEnabled/rakeMethod/rakeValue/potEnabled/
// mismatchStrategy/rakeOrder/winnerDefinition/winnerTopN/roundingRule).
// Two clubs with different settings run through the exact same functions
// below and get different, independently-configured results.
//
// Pipeline (see computeSettlement): determine winners once, up front, from
// each player's untouched initial profit — then run the mismatch and rake
// steps in whichever order the group chose, each one operating on a
// running `remaining` profit figure. This is what lets "mismatch first"
// vs "rake first" produce genuinely different numbers: whichever step
// runs second sees the output of the one before it, not the raw profit.
//
// IMPORTANT: apps/web/src/lib/settlementEngine.ts mirrors this file
// exactly (same functions, same behavior) for the client-side live
// preview. If you change the rules here, change them there too.

export type RakeMethod = 'PERCENT_PROFIT' | 'PERCENT_CASHOUT' | 'FIXED_PER_WINNER' | 'FIXED_PER_SESSION' | 'CUSTOM';
export type MismatchStrategy =
  | 'PROPORTIONAL_WINNERS'
  | 'EQUAL_WINNERS'
  | 'EQUAL_ALL'
  | 'SHORTFALL_TO_POT'
  | 'EXCESS_FROM_POT'
  | 'MANUAL'
  | 'CUSTOM';
export type RakeOrder = 'MISMATCH_FIRST' | 'RAKE_FIRST';
export type WinnerDefinition = 'PROFIT_POSITIVE' | 'TOP_N' | 'MANUAL' | 'CUSTOM';
export type RoundingRule = 'NONE' | 'NEAREST_1' | 'NEAREST_5' | 'NEAREST_10';

/**
 * Bumped whenever a change here can alter the numbers this engine produces.
 * Stamped onto every settlement audit record, so a night settled two years
 * ago still says which engine decided it — otherwise a historical dispute
 * can't be told apart from a later behaviour change. Reconstructing this
 * after the fact is effectively impossible, so it is recorded at write time.
 *
 * History:
 *   1 — initial versioned release
 *   2 — sessionRakeAmount became a per-player seat fee. It was a total for the
 *       night split across whoever played, so the same setting produced
 *       different per-head charges depending on how many sat down. Nights
 *       settled under version 1 keep their figures; this only decides what a
 *       night settled from here on is charged.
 */
export const SETTLEMENT_ENGINE_VERSION = 2;

export interface SettlementSettings {
  /**
   * Seat fee, charged to EVERY player who sat down.
   *
   * A table of five with this at 1,000 collects 5,000. It was a total for the
   * night divided among the players until engine version 2 — see computeRake.
   */
  sessionRakeAmount?: number;
  /** Percentage of each winner's profit. */
  winnersCutPercent?: number;
  /** @deprecated superseded by sessionRakeAmount + winnersCutPercent */
  rakeEnabled: boolean;
  rakeMethod: RakeMethod;
  rakeValue: number;
  potEnabled: boolean;
  mismatchStrategy: MismatchStrategy;
  rakeOrder: RakeOrder;
  winnerDefinition: WinnerDefinition;
  winnerTopN: number;
  roundingRule: RoundingRule;
}

export interface SettlementPlayerInput {
  userId: string;
  userDisplayName: string;
  buyIn: number;
  cashOut: number;
  // Only consulted when winnerDefinition === 'MANUAL'.
  manualWinner?: boolean;
}

export interface SettlementPlayerResult {
  userId: string;
  userDisplayName: string;
  totalBuyIn: number;
  cashOut: number;
  grossProfit: number; // initial profit, untouched by any rule
  isWinner: boolean; // per winnerDefinition, fixed for the whole pipeline
  mismatchDeduction: number; // signed: positive = taken from this player, negative = given back to them (pot-funded excess)
  rakeDeduction: number;
  netResult: number; // grossProfit - mismatchDeduction - rakeDeduction
}

export type MismatchResolution =
  | 'none'
  | 'excess_from_players'
  | 'excess_from_pot'
  | 'shortfall_to_pot'
  | 'shortfall_unresolved'
  | 'manual_pending';

export interface SettlementStepLog {
  step: string;
  detail: string;
}

export interface SettlementResult {
  totalBuyIns: number;
  totalCashOuts: number;
  // Signed: positive = cashouts exceed buy-ins (excess), negative = buy-ins exceed cashouts (shortfall).
  mismatchAmount: number;
  mismatchResolution: MismatchResolution;
  requiresManualResolution: boolean;
  totalRakeCollected: number;
  potContribution: number; // net amount added to (negative = drawn from) the club pot; always 0 when potEnabled is false
  players: SettlementPlayerResult[];
  steps: SettlementStepLog[];
}

export interface ComputeSettlementOptions {
  // Group owner's current club pot balance — only consulted by pot-funded
  // mismatch strategies (EXCESS_FROM_POT) to decide whether the pot can
  // actually cover an excess.
  currentPotBalance?: number;
  // Required to unblock Save when mismatchStrategy === 'MANUAL'.
  mismatchAcknowledged?: boolean;
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
      // 2dp, not whole chips. A proportional split routinely lands on halves
      // (a 12.5% share of 300 is 37.50); forcing those to integers both
      // overcharges the player and breaks the guarantee that final cash-outs
      // sum back to total buy-ins.
      return Math.round(value * 100) / 100;
  }
}

interface WorkingPlayer extends SettlementPlayerResult {
  remaining: number; // running profit as it moves through the pipeline
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
      // Extension point: no custom rule registered yet, fall back to the
      // standard definition rather than silently doing nothing.
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
  if (mismatchAmount === 0) {
    return { resolution: 'none', potEffect: 0, requiresManualResolution: false };
  }

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

  // Shortfall (buy-ins > cashouts): unclaimed chips. Every strategy other
  // than MANUAL treats this the same way — it's a surplus, not a debt, so
  // there's nothing to "deduct" from any player.
  if (mismatchAmount < 0) {
    const shortfall = -mismatchAmount;
    if (settings.potEnabled) {
      steps.push({ step: 'Mismatch', detail: `Buy-ins exceed cash-outs by ${shortfall} — sent to the Club Pot.` });
      return { resolution: 'shortfall_to_pot', potEffect: shortfall, requiresManualResolution: false };
    }
    steps.push({ step: 'Mismatch', detail: `Buy-ins exceed cash-outs by ${shortfall}, but the Club Pot is disabled — untracked.` });
    return { resolution: 'shortfall_unresolved', potEffect: 0, requiresManualResolution: false };
  }

  // Excess (cashouts > buy-ins): the club owes more than it collected —
  // the configured strategy decides who covers it.
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

  if (settings.mismatchStrategy === 'EQUAL_WINNERS') {
    return applyExcessToWinners(players, excess, 'equal_winners', steps);
  }
  if (settings.mismatchStrategy === 'EQUAL_ALL') {
    return applyExcessToWinners(players, excess, 'equal_all', steps);
  }

  // PROPORTIONAL_WINNERS and CUSTOM (no custom rule registered yet) both
  // fall back to the proportional method.
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
  // Who actually paid for a mismatch is the first thing anyone asks when the
  // numbers don't look right, so each branch names the players and amounts
  // rather than just stating the rule it applied.
  const amount = (n: number) => {
    const rounded = Math.round(n * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
  };
  const whoPaid = (charged: WorkingPlayer[]) =>
    charged
      .filter((p) => p.mismatchDeduction !== 0)
      .map((p) => `${p.userDisplayName} -${amount(p.mismatchDeduction)}`)
      .join(', ');

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

  // Under RAKE_FIRST the rake can consume a winner's entire profit before the
  // mismatch runs. Splitting by what's left would then charge the phantom
  // chips to nobody while the rake still credited the pot — banking money the
  // table never held. Fall back to gross profit, which no earlier step has
  // touched; the refund pass in computeSettlement unwinds any rake that turns
  // out to have been charged on profit the mismatch reversed.
  const remainingProfit = winners.reduce((sum, p) => sum + p.remaining, 0);
  const byRemaining = remainingProfit > 0;
  const basisTotal = byRemaining
    ? remainingProfit
    : winners.reduce((sum, p) => sum + Math.max(0, p.grossProfit), 0);
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

function computeRake(players: WorkingPlayer[], settings: SettlementSettings, steps: SettlementStepLog[]): number {
  // Two independent charges, either or both of which may be zero:
  //   sessionRakeAmount — seat fee, charged to every player who sat down, so a
  //                       table of five collects five times it
  //   winnersCutPercent — % of each winner's profit *at this point in the
  //                       pipeline*, so a mismatch already applied is respected
  // Both fund the Club Pot. Legacy rakeMethod/rakeValue are no longer read;
  // existing clubs were back-filled into these two fields.
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
    steps.push({ step: "Rake", detail: `Winners' cut: ${cut}% of each winner's profit at this point in the pipeline.` });
  }

  const flat = settings.sessionRakeAmount ?? 0;
  if (flat > 0 && players.length > 0) {
    // PER PLAYER, not split. Everyone at the table pays the same seat fee,
    // winners and losers alike — it is the cost of a chair for the night, not a
    // tax on profit, so it does not scale down as more people sit down.
    //
    // This was a total for the night until engine version 2, divided among
    // however many played. A host who set 1,000 expecting each player to pay it
    // saw 1,000 come off the table in total, and 200 each once five people sat
    // down — the charge got cheaper the busier the game, which is backwards for
    // a seat fee.
    //
    // No remainder handling any more: nothing is divided, so nothing rounds.
    players.forEach((p) => {
      p.rakeDeduction = Math.round((p.rakeDeduction + flat) * 100) / 100;
    });
    total += flat * players.length;
    steps.push({
      step: 'Rake',
      detail: `Session rake: ${flat} per player from ${players.length} player(s) — ${flat * players.length} in total.`,
    });
  }

  return total;
}

export function computeSettlement(
  players: SettlementPlayerInput[],
  settings: SettlementSettings,
  opts: ComputeSettlementOptions = {}
): SettlementResult {
  const steps: SettlementStepLog[] = [];

  // Step 1: initial profit — untouched by any rule.
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

  // Winners are classified once, up front, from the untouched initial
  // profit — membership doesn't shift as later steps change `remaining`.
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

    // Rounding each share independently can leave the deductions summing to
    // slightly more or less than the excess, which would let total cash-outs
    // drift away from total buy-ins. Push the residual onto the largest
    // deduction (the biggest winner) so the books always reconcile exactly.
    if (mismatchAmount > 0 && requiresManualResolution === false) {
      const deducted = working.reduce((s, p) => s + p.mismatchDeduction, 0);
      const residual = Math.round((mismatchAmount - deducted) * 100) / 100;
      if (residual !== 0) {
        const target = working
          .filter((p) => p.mismatchDeduction > 0)
          .sort((a, b) => b.mismatchDeduction - a.mismatchDeduction)[0];
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
    computeRake(working, settings, steps);
    working.forEach((p) => {
      p.rakeDeduction = roundTo(p.rakeDeduction, settings.roundingRule);
      p.remaining -= p.rakeDeduction;
    });
    // Post-rounding resum. The flat session rake is already folded into each
    // player's rakeDeduction (charged per player in computeRake), so adding
    // sessionRakeAmount again here would double-count it in the pot.
    totalRakeCollected = working.reduce((s, p) => s + p.rakeDeduction, 0);
  };

  const chargesRake = (settings.sessionRakeAmount ?? 0) > 0 || (settings.winnersCutPercent ?? 0) > 0;
  if (settings.rakeOrder === 'RAKE_FIRST') {
    if (chargesRake) runRake();
    runMismatch();
  } else {
    runMismatch();
    if (chargesRake) runRake();
  }

  // Deductions must never push a winner below break-even. Under RAKE_FIRST a
  // winner could be raked on profit that the mismatch step then reversed
  // entirely — charging a cut of winnings that turned out not to exist, and
  // crediting the pot with money nobody actually held. Rake is refunded (not
  // the mismatch, which is a genuine claw-back of phantom chips) and the pot
  // is reduced by the same amount so the books stay balanced.
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

  const players_: SettlementPlayerResult[] = working.map((p) => ({
    userId: p.userId,
    userDisplayName: p.userDisplayName,
    totalBuyIn: p.totalBuyIn,
    cashOut: p.cashOut,
    grossProfit: p.grossProfit,
    isWinner: p.isWinner,
    mismatchDeduction: p.mismatchDeduction,
    rakeDeduction: p.rakeDeduction,
    netResult: p.netResult,
  }));

  return {
    totalBuyIns,
    totalCashOuts,
    mismatchAmount,
    mismatchResolution,
    requiresManualResolution,
    totalRakeCollected,
    potContribution,
    players: players_,
    steps,
  };
}
