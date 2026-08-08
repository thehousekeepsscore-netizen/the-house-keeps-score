import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlayerSheet, PlayerSheetProps } from './PlayerSheet';
import { Seat } from '../../lib/night-state';

/**
 * One subject, at most one primary action.
 *
 * The sheet is where every action originates, so these tests are mostly about
 * what it refuses to offer: a second primary, a control for someone else's
 * seat, or a way to reach the money without passing through the queue.
 */

const fmt = (n: number) => n.toLocaleString();

function seat(over: Partial<Seat> = {}): Seat {
  return {
    userId: 'priya',
    state: 'inPlay',
    totalBuyIn: 5000,
    buyInCount: 1,
    pendingBuyIn: null,
    pendingCashOut: null,
    confirmedCashOut: null,
    ...over,
  };
}

function show(over: Partial<PlayerSheetProps> = {}) {
  const props: PlayerSheetProps = {
    open: true,
    onClose: vi.fn(),
    name: 'Priya',
    userId: 'priya',
    seat: seat(),
    isSelf: false,
    isAdmin: true,
    formatAmount: fmt,
    bankOptions: [1000, 3000, 5000],
    ceiling: 5000,
    onJoin: vi.fn(),
    onBuyMore: vi.fn(),
    onStandUp: vi.fn(),
    onConfirmCount: vi.fn(),
    onSitBackDown: vi.fn(),
    ...over,
  };
  render(<PlayerSheet {...props} />);
  return props;
}

/**
 * The entry point is "Stand up", never "Cash out".
 *
 * Cashing out is not something anyone does at a table — standing up is, and the
 * cash-out is its consequence. Once someone is actually counting, the button is
 * allowed to name what it submits, because at that point that is precisely what
 * the person is doing.
 */
describe('standing up is the verb', () => {
  const states: Seat['state'][] = [
    'waitingToSit', 'seatedNoChips', 'inPlay', 'countingOut', 'cashedOut',
  ];
  for (const state of states) {
    it(`offers no way to start a cash-out when ${state}`, () => {
      show({ seat: seat({ state, confirmedCashOut: 7200, pendingCashOut: 7200 }) });
      // "Approve cash out" is a confirmation of one already submitted, which is
      // the admin's job and a different act entirely.
      const starters = screen
        .queryAllByRole('button', { name: /cash.?out/i })
        .filter((b) => !/approve/i.test(b.textContent ?? ''));
      expect(starters).toHaveLength(0);
      document.body.innerHTML = '';
    });
  }
});

describe('one state, one thing to do', () => {
  it('opens straight into the bank for someone who is not in the night', () => {
    // The sheet opening IS the "Join table" step. Making people tap a button
    // called Join table to reach a screen headed Join table was the same word
    // twice for one decision.
    show({ seat: null, isSelf: true });
    expect(screen.getByText(/choose your starting bank/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^join table$/i })).not.toBeInTheDocument();
  });

  it('offers nothing to someone pulling up a chair — they have already asked', () => {
    show({ seat: seat({ state: 'waitingToSit', totalBuyIn: 0, pendingBuyIn: 5000 }), isSelf: true });
    expect(screen.getByText(/pulling up a chair with 5,000/i)).toBeInTheDocument();
    expect(screen.getByText(/waiting for the host/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /join|buy|stand/i })).not.toBeInTheDocument();
  });

  it('leads a playing seat with more chips, and stands up quietly beneath it', () => {
    show({ seat: seat() });
    expect(screen.getByText('Playing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /buy more chips/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stand up/i })).toBeInTheDocument();
  });

  it('invites someone who stood up to come back', () => {
    show({ seat: seat({ state: 'cashedOut', confirmedCashOut: 7200 }) });
    expect(screen.getByText(/stood up with 7,200/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sit back down with 7,200/i })).toBeInTheDocument();
  });
});

/**
 * You cannot come back short of what you left with.
 *
 * The table-stakes rule every home game already plays by. Standing up with
 * 7,200 and sitting back down with 1,000 takes 6,200 out of the night while
 * everyone else's money is still on the felt — poker calls it going south, and
 * it is the one move that changes the economics of an evening without anybody
 * losing a hand.
 */
describe('sitting back down', () => {
  it('brings back exactly the stack they left with', async () => {
    const { onSitBackDown, onBuyMore, onJoin } = show({
      seat: seat({ state: 'cashedOut', confirmedCashOut: 7200 }),
      isSelf: true,
    });
    await userEvent.click(screen.getByRole('button', { name: /sit back down with 7,200/i }));
    expect(onSitBackDown).toHaveBeenCalledTimes(1);
    // Not a buy-in. Those chips are already theirs and already counted, so
    // treating the return as new money would add 7,200 to what they have put in
    // and settle them 7,200 down.
    expect(onBuyMore).not.toHaveBeenCalled();
    expect(onJoin).not.toHaveBeenCalled();
  });

  it('offers no way to come back with a smaller stack', () => {
    show({ seat: seat({ state: 'cashedOut', confirmedCashOut: 7200 }), isSelf: true });
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/other amount/i)).not.toBeInTheDocument();
  });

  it('says that more chips come after sitting, not instead of it', () => {
    show({ seat: seat({ state: 'cashedOut', confirmedCashOut: 7200 }), isSelf: true });
    expect(screen.getByText(/buy more once you're sitting/i)).toBeInTheDocument();
  });
});

describe('what they have put in', () => {
  it('says how many trips a total took, because that is the context for asking again', () => {
    show({ seat: seat({ totalBuyIn: 8000, buyInCount: 3 }) });
    expect(screen.getByText(/8,000/)).toBeInTheDocument();
    expect(screen.getByText(/across 3 buy-ins/i)).toBeInTheDocument();
  });

  it('stays quiet about the count when there has only been one', () => {
    // "across 1 buy-ins" is how a sentence announces it was assembled.
    show({ seat: seat({ totalBuyIn: 5000, buyInCount: 1 }) });
    expect(screen.queryByText(/across/i)).not.toBeInTheDocument();
  });
});

/**
 * Arriving from the brass stud, which already means chips.
 *
 * Tapping your own seat is a general-purpose question — chips, or standing up?
 * Tapping the stud is not: you have already said what you want, and a sheet
 * offering "Buy more chips" would be asking it twice.
 */
describe('when the stud is the way in', () => {
  it('opens a seated player straight on the amount', () => {
    show({ seat: seat(), isSelf: true, isAdmin: false, askForChips: true });
    expect(screen.getByText(/how many chips/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /buy more chips/i })).not.toBeInTheDocument();
  });

  it('still offers the menu when the seat was the way in', () => {
    show({ seat: seat(), isSelf: true, isAdmin: false });
    expect(screen.getByRole('button', { name: /buy more chips/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stand up/i })).toBeInTheDocument();
  });

  it('changes nothing for somebody who has no seat yet', () => {
    // They were already opening on the bank chooser — the stud is just a
    // second door into the same room.
    show({ seat: null, isSelf: true, askForChips: true });
    expect(screen.getByText(/choose your starting bank/i)).toBeInTheDocument();
  });
});

describe('choosing a bank', () => {
  it('states the ceiling as a limit and refuses the options above it', () => {
    show({ seat: null, isSelf: true, ceiling: 3000 });
    expect(screen.getByRole('radio', { name: /1,000/ })).toBeEnabled();
    // Never offered as a target — it drifts upward all night under
    // MATCH_HIGHEST and would end up proposing an absurd default.
    expect(screen.getByText(/table maximum 3,000/i)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /5,000/ })).toBeDisabled();
  });

  it('picks then confirms, rather than committing money on first touch', async () => {
    const { onJoin } = show({ seat: null, isSelf: true });

    const cont = screen.getByRole('button', { name: /continue/i });
    expect(cont).toBeDisabled();

    await userEvent.click(screen.getByRole('radio', { name: /3,000/ }));
    expect(onJoin).not.toHaveBeenCalled();

    await userEvent.click(cont);
    expect(onJoin).toHaveBeenCalledWith(3000);
  });

  it('lets a typed amount win over a tapped one', async () => {
    const { onJoin } = show({ seat: null, isSelf: true, ceiling: null });
    await userEvent.click(screen.getByRole('radio', { name: /3,000/ }));
    await userEvent.type(screen.getByPlaceholderText(/other amount/i), '4500');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(onJoin).toHaveBeenCalledWith(4500);
  });
});

describe('standing up', () => {
  it('requires a typed count from the player themselves', async () => {
    // A buy-in is a round number someone chooses; a count is a figure read off
    // a stack, and it locks the settlement number. No presets, ever.
    const { onStandUp } = show({ seat: seat(), isSelf: true, isAdmin: false });
    await userEvent.click(screen.getByRole('button', { name: /stand up/i }));
    expect(screen.getByText(/count your chips/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit cash out/i })).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText('0'), '7200');
    await userEvent.click(screen.getByRole('button', { name: /submit cash out/i }));
    expect(onStandUp).toHaveBeenCalledWith(7200);
  });

  it('leaves the player waiting once it is submitted', () => {
    show({ seat: seat({ state: 'countingOut', pendingCashOut: 7200 }), isAdmin: false, isSelf: true });
    expect(screen.getByText(/standing up — pending approval/i)).toBeInTheDocument();
    expect(screen.getByText(/waiting for the host to confirm/i)).toBeInTheDocument();
  });
});

describe('confirming a count', () => {
  it('starts from what the player submitted, so agreeing is one tap', async () => {
    const { onConfirmCount } = show({ seat: seat({ state: 'countingOut', pendingCashOut: 7200 }) });
    expect(screen.getByLabelText(/counted chips/i)).toHaveValue('7200');

    await userEvent.click(screen.getByRole('button', { name: /approve cash out/i }));
    expect(onConfirmCount).toHaveBeenCalledWith(7200);
  });

  it('lets the admin correct a miscount rather than rejecting it', async () => {
    // Both people are standing over the same stack. Rejecting would ask the
    // player to re-count something the admin has already counted.
    const { onConfirmCount } = show({ seat: seat({ state: 'countingOut', pendingCashOut: 7200 }) });
    const field = screen.getByLabelText(/counted chips/i);
    await userEvent.clear(field);
    await userEvent.type(field, '7500');
    await userEvent.click(screen.getByRole('button', { name: /approve cash out/i }));
    expect(onConfirmCount).toHaveBeenCalledWith(7500);
  });

  it('is not offered to the player whose chips they are', () => {
    show({ seat: seat({ state: 'countingOut', pendingCashOut: 7200 }), isAdmin: false, isSelf: true });
    expect(screen.queryByLabelText(/counted chips/i)).not.toBeInTheDocument();
  });
});

describe('someone else’s seat', () => {
  it('has no action blocks at all, rather than greyed ones', () => {
    show({ seat: seat(), isSelf: false, isAdmin: false });
    expect(screen.getByText(/nothing to do here/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /buy|stand|join/i })).not.toBeInTheDocument();
  });
});
