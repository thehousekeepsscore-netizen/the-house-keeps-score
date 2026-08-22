import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { SettlementPreview } from './SettlementPreview';
import { computeSettlement, SettlementSettings } from '../lib/settlementEngine';
import { Club } from '../types';

/**
 * The house take has to add up.
 *
 * This panel is the one place in the product where the total the house took and
 * the parts it is made of are both on screen, and its own comment said so. It
 * derived both parts instead of reading them, and both derivations were wrong:
 *
 *     winners' cut  =  totalRakeCollected − flatRake      ← one seat fee, of N
 *     session rake  =  flatRake × players.length          ← ignores capping
 *
 * At four players and a 1,000 seat fee the cut line overstated by 3,000, and the
 * two component lines came to 3,000 more than the House take printed directly
 * beneath them. Nobody noticed because this component had no test file at all —
 * the engine is thoroughly covered, and the gap was between the engine and the
 * eye.
 *
 * So these tests do not assert numbers I typed. They run the REAL engine, then
 * assert the panel shows what it returned and that the parts reconcile with the
 * whole. A future change to how the engine splits the two charges will keep
 * these passing; a change to how the panel reports them will not.
 */

const fmt = (n: number) => n.toLocaleString();
const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toLocaleString()}`;

const club = {
  id: 'c1',
  name: 'Friday Night',
  potEnabled: false,
  clubPotBalance: 0,
  sessionRakeAmount: 0,
  winnersCutPercent: 0,
} as unknown as Club;

/**
 * A seat fee on every chair, plus a percentage of each winner's profit.
 *
 * `potEnabled` must be true or the engine charges nothing at all: at v3,
 * `chargesRake` is `potEnabled && configuresCharge` — "a house take with
 * nowhere to go would leave the table without reaching anyone". A fixture with
 * the pot off produces a house take of zero and proves nothing here.
 */
const rules = (over: Partial<SettlementSettings> = {}): SettlementSettings =>
  ({
    sessionRakeAmount: 1000,
    winnersCutPercent: 5,
    rakeEnabled: false,
    rakeMethod: 'PERCENT_PROFIT',
    rakeValue: 0,
    potEnabled: true,
    mismatchStrategy: 'PROPORTIONAL_WINNERS',
    rakeOrder: 'MISMATCH_FIRST',
    winnerDefinition: 'PROFIT_POSITIVE',
    winnerTopN: 1,
    roundingRule: 'NONE',
    ...over,
  }) as SettlementSettings;

const player = (userId: string, buyIn: number, cashOut: number) => ({
  userId,
  userDisplayName: userId,
  buyIn,
  cashOut,
});

function show(settings: SettlementSettings, players: ReturnType<typeof player>[]) {
  const result = computeSettlement(players, settings, { currentPotBalance: 0 });
  render(
    <SettlementPreview
      result={result}
      club={club}
      settings={settings}
      formatAmount={fmt}
      formatSigned={signed}
    />
  );
  return result;
}

/**
 * The house-take block, scoped.
 *
 * Necessary rather than fussy: each player's own ladder carries a row labelled
 * "Winners' cut (5%)" too, so an unscoped query matches several. "House take"
 * is rendered exactly once, so the block is found from it.
 */
function houseTakeBlock(): HTMLElement {
  const total = screen.getByText(/^House take$/);
  const block = total.closest('div.space-y-1');
  expect(block, 'house-take block not found').not.toBeNull();
  return block as HTMLElement;
}

/** The value cell of the house-take row whose label matches `label`. */
function amountFor(label: RegExp): number {
  const cell = within(houseTakeBlock()).getByText(label);
  const shown = within(cell.parentElement as HTMLElement)
    .getAllByText(/^[\d,]+$/)
    .map((n) => Number(n.textContent!.replace(/,/g, '')));
  expect(shown, `no single amount beside ${label}`).toHaveLength(1);
  return shown[0];
}

describe('the house take reconciles with its parts', () => {
  /*
   * FOUR seat fees, which is where the old derivation broke.
   *
   * With one player the two implementations agree, which is why a smaller
   * fixture would have proved nothing. The error is flatRake × (N−1).
   */
  it('MULTIPLE SEAT FEES — the parts sum to the total', () => {
    const settings = rules();
    const result = show(settings, [
      player('Priya', 5000, 9000),
      player('Rahul', 5000, 8000),
      player('Tara', 5000, 2000),
      player('Arjun', 5000, 1000),
    ]);

    const cut = amountFor(/^Winners' cut/);
    const seat = amountFor(/^Session rake$/);
    const total = amountFor(/^House take$/);

    // Against the engine, not against numbers written here.
    expect(cut, "winners' cut is the engine's figure").toBe(result.totalWinnersCut);
    expect(seat, 'session rake is the engine\'s figure').toBe(result.totalSeatFees);
    expect(total, 'house take is the engine\'s figure').toBe(result.totalRakeCollected);

    // The property the panel exists for, and the one the old code broke.
    expect(cut + seat, 'the two parts must equal the whole').toBe(total);

    // And prove this fixture actually exercises the bug: the old expression
    // subtracted a single seat fee, so it disagreed by three of them.
    const oldCut = Math.max(0, result.totalRakeCollected - settings.sessionRakeAmount);
    expect(oldCut, 'fixture must be one the old code got wrong').not.toBe(result.totalWinnersCut);
    expect(oldCut - result.totalWinnersCut).toBe(settings.sessionRakeAmount * 3);
  });

  /*
   * The other half of the bug. The engine caps a seat fee at what the house
   * actually took from that player — `seatFee = min(seatFeeCharged,
   * rakeDeduction)` — because nobody can be charged more for the chair than
   * they were charged in total. `flatRake × players.length` cannot see that.
   */
  it('CAPPED SEAT FEES — the session rake line is not rate × heads', () => {
    // Winners only pay the cut; losers still owe the chair. A 5,000 seat fee
    // against small deductions forces the cap.
    const settings = rules({ sessionRakeAmount: 5000, winnersCutPercent: 5 });
    const result = show(settings, [
      player('Priya', 5000, 6000),
      player('Rahul', 5000, 4000),
      player('Tara', 5000, 5000),
    ]);

    const seat = amountFor(/^Session rake$/);
    const cut = amountFor(/^Winners' cut/);
    const total = amountFor(/^House take$/);

    expect(seat).toBe(result.totalSeatFees);
    expect(cut + seat).toBe(total);

    const oldSeat = settings.sessionRakeAmount * result.players.length;
    expect(oldSeat, 'fixture must exercise capping').not.toBe(result.totalSeatFees);
    expect(result.totalSeatFees).toBeLessThan(oldSeat);
  });

  /*
   * The degenerate case the old code got right, kept so the fix is shown to be
   * a no-op there rather than a change everywhere.
   *
   * Balanced deliberately. An unbalanced single player is not the clean case it
   * looks like: the mismatch takes the whole profit, the engine then refunds the
   * rake to keep the winner at break-even, and the house take falls to zero —
   * which the old code got wrong too, for a different reason.
   */
  it('single player, balanced — reconciles, and the old code agreed here', () => {
    const result = show(rules(), [player('Priya', 5000, 5000)]);
    expect(result.mismatchAmount, 'fixture is balanced').toBe(0);
    expect(amountFor(/^Winners' cut/) + amountFor(/^Session rake$/)).toBe(
      result.totalRakeCollected
    );
  });

  it('says nothing about the house when it took nothing', () => {
    show(rules({ sessionRakeAmount: 0, winnersCutPercent: 0 }), [
      player('Priya', 5000, 6000),
      player('Rahul', 5000, 4000),
    ]);
    expect(screen.queryByText(/^House take$/)).not.toBeInTheDocument();
  });
});

/**
 * Which way the difference runs, and three invariants the redesign must not break.
 *
 * The first two tests cover a real change: the panel said "the 300 difference"
 * and now says which side of it you are on. The rest assert properties that
 * ALREADY HOLD today, and that is deliberate — they are written before the
 * settlement screen is rebuilt so that the rebuild has to satisfy tests it did
 * not author. Three of them pass trivially at the moment, for reasons the
 * redesign removes:
 *
 *   - nothing is collapsible yet, so the mismatch steps cannot be hidden;
 *   - the acknowledgement is already gated on requiresManualResolution;
 *   - a blank cash-out cannot reach the panel, because Calculate is disabled
 *     until every figure is entered (that one lives in
 *     ClubDetailView.settlement.test.tsx, where the inputs are).
 *
 * A test that passes for a reason about to be deleted is exactly the test worth
 * writing down first.
 */
describe('the mismatch says which way it runs', () => {
  const manual = () => rules({ mismatchStrategy: 'MANUAL' });

  it('MORE OUT THAN IN — the club owes more than it collected', () => {
    // 10,000 in, 10,300 out.
    const result = show(manual(), [player('Priya', 5000, 8300), player('Rahul', 5000, 2000)]);
    expect(result.mismatchAmount, 'fixture must be an excess').toBeGreaterThan(0);

    expect(screen.getByText(/300 more out than in/)).toBeInTheDocument();
    expect(screen.queryByText(/more in than out/), 'must not invert').not.toBeInTheDocument();
  });

  it('MORE IN THAN OUT — chips nobody claimed', () => {
    // 10,000 in, 9,700 out. The opposite situation, and the one an unsigned
    // figure made indistinguishable from the case above.
    const result = show(manual(), [player('Priya', 5000, 7700), player('Rahul', 5000, 2000)]);
    expect(result.mismatchAmount, 'fixture must be a shortfall').toBeLessThan(0);

    expect(screen.getByText(/300 more in than out/)).toBeInTheDocument();
    expect(screen.queryByText(/more out than in/), 'must not invert').not.toBeInTheDocument();
  });

  it('names the engine\'s own figure, not one recomputed here', () => {
    const result = show(manual(), [player('Priya', 5000, 8300), player('Rahul', 5000, 2000)]);
    expect(
      screen.getByText(new RegExp(`${Math.abs(result.mismatchAmount)} more out than in`))
    ).toBeInTheDocument();
  });
});

describe('invariants the settlement redesign must not break', () => {
  /*
   * A9. The Mismatch steps name who was charged — whoPaid() in the engine puts
   * "Priya -900, Rahul -600" in the detail — and the engine's comment says why:
   * "Who actually paid for a mismatch is the first thing anyone asks when the
   * numbers don't look right."
   *
   * The redesign collapses "How this was worked out" behind a disclosure. These
   * steps must not go with it.
   */
  it('A9 — who paid for the mismatch is readable without opening anything', () => {
    const result = show(rules({ mismatchStrategy: 'PROPORTIONAL_WINNERS' }), [
      player('Priya', 5000, 8300),
      player('Rahul', 5000, 2000),
    ]);
    expect(result.mismatchAmount, 'fixture must produce a mismatch').not.toBe(0);

    const mismatchStep = result.steps.find((s) => s.step === 'Mismatch');
    expect(mismatchStep, 'engine must have written a Mismatch step').toBeDefined();

    // Present, and reachable with no interaction at all.
    expect(screen.getByText(mismatchStep!.detail)).toBeInTheDocument();
    expect(
      document.querySelector('details'),
      'nothing on this panel may be behind a disclosure'
    ).toBeNull();
  });

  /*
   * A2. requiresManualResolution is MANUAL-only by construction, and every other
   * strategy resolves the difference automatically — while still charging named
   * players. An acknowledgement offered there would invite somebody to tick away
   * a deduction they never agreed to.
   */
  it('A2 — no acknowledgement is offered when the strategy resolves it automatically', () => {
    const result = computeSettlement(
      [player('Priya', 5000, 8300), player('Rahul', 5000, 2000)],
      rules({ mismatchStrategy: 'PROPORTIONAL_WINNERS' }),
      { currentPotBalance: 0 }
    );
    expect(result.mismatchAmount, 'there IS a mismatch').not.toBe(0);
    expect(result.requiresManualResolution, 'but it does not need a human').toBe(false);

    render(
      <SettlementPreview
        result={result}
        club={club}
        settings={rules({ mismatchStrategy: 'PROPORTIONAL_WINNERS' })}
        formatAmount={fmt}
        formatSigned={signed}
        // Offered by the caller — the panel must still refuse to show it.
        mismatchAcknowledgement={{ checked: false, onChange: () => {} }}
      />
    );

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/manual mismatch resolution/i)).not.toBeInTheDocument();
  });

  it('A2 — and it IS offered when the night says MANUAL', () => {
    // The other half, so the test above cannot pass by the control having been
    // deleted outright.
    show(rules({ mismatchStrategy: 'MANUAL' }), [
      player('Priya', 5000, 8300),
      player('Rahul', 5000, 2000),
    ]);
    expect(screen.getByText(/manual mismatch resolution/i)).toBeInTheDocument();
  });
});
