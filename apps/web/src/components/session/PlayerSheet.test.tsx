import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlayerSheet, PlayerSheetProps } from './PlayerSheet';
import { Seat } from '../../lib/night-state';

/**
 * One subject, at most one primary action.
 *
 * The load-bearing claim these tests guard is a negative one: there is no
 * "Cash out" control anywhere in the sheet, in any state, for any viewer.
 * Cashing out is not something a person does at a table — standing up is, and
 * the cash-out is its consequence.
 */

const fmt = (n: number) => n.toLocaleString();

function seat(over: Partial<Seat> = {}): Seat {
  return {
    userId: 'priya',
    state: 'inPlay',
    totalBuyIn: 5000,
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
    ...over,
  };
  render(<PlayerSheet {...props} />);
  return props;
}

describe('there is no cash-out button, ever', () => {
  const states: Seat['state'][] = [
    'waitingToSit', 'seatedNoChips', 'inPlay', 'countingOut', 'cashedOut',
  ];
  for (const state of states) {
    it(`not when ${state}`, () => {
      show({ seat: seat({ state, confirmedCashOut: 7200, pendingCashOut: 7200 }) });
      expect(screen.queryByRole('button', { name: /cash.?out/i })).not.toBeInTheDocument();
      document.body.innerHTML = '';
    });
  }
});

describe('one state, one thing to do', () => {
  it('offers joining to someone who is not in the night at all', () => {
    show({ seat: null, isSelf: true });
    expect(screen.getByText(/not at the table/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /join table/i })).toBeInTheDocument();
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

  it('lets a host check a count, and asks a player to wait', () => {
    const { onConfirmCount } = show({ seat: seat({ state: 'countingOut', pendingCashOut: 7200 }) });
    expect(screen.getByRole('button', { name: /count chips/i })).toBeInTheDocument();
    document.body.innerHTML = '';

    show({ seat: seat({ state: 'countingOut', pendingCashOut: 7200 }), isAdmin: false, isSelf: true });
    expect(screen.getByText(/waiting for the host to check/i)).toBeInTheDocument();
    expect(onConfirmCount).not.toHaveBeenCalled();
  });

  it('invites someone who stood up to come back', () => {
    show({ seat: seat({ state: 'cashedOut', confirmedCashOut: 7200 }) });
    expect(screen.getByText(/stood up with 7,200/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /join again/i })).toBeInTheDocument();
  });
});

describe('choosing a bank', () => {
  it('offers the club’s own amounts and states the ceiling as a limit', () => {
    show({ seat: null, isSelf: true, ceiling: 3000 });
    return userEvent.click(screen.getByRole('button', { name: /join table/i })).then(() => {
      expect(screen.getByRole('button', { name: '1,000' })).toBeEnabled();
      // Never offered as a button — it drifts upward all night under
      // MATCH_HIGHEST and would end up proposing an absurd default.
      expect(screen.getByText(/table maximum 3,000/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '5,000' })).toBeDisabled();
    });
  });

  it('joins with the amount that was tapped', async () => {
    const { onJoin } = show({ seat: null, isSelf: true });
    await userEvent.click(screen.getByRole('button', { name: /join table/i }));
    await userEvent.click(screen.getByRole('button', { name: '3,000' }));
    expect(onJoin).toHaveBeenCalledWith(3000);
  });
});

describe('standing up', () => {
  it('requires a typed count and reads it back before committing', async () => {
    // A buy-in is a round number someone chooses; a count is a figure read off
    // a stack, and it locks the settlement number. No presets, ever.
    const { onStandUp } = show({ seat: seat(), isSelf: true });
    await userEvent.click(screen.getByRole('button', { name: /stand up/i }));
    expect(screen.getByRole('button', { name: /stand up with 0/i })).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText('0'), '7200');
    await userEvent.click(screen.getByRole('button', { name: /stand up with 7,200/i }));
    expect(onStandUp).toHaveBeenCalledWith(7200);
  });
});

describe('someone else’s seat', () => {
  it('has no action blocks at all, rather than greyed ones', () => {
    show({ seat: seat(), isSelf: false, isAdmin: false });
    expect(screen.getByText(/nothing to do here/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /buy|stand|join/i })).not.toBeInTheDocument();
  });
});
