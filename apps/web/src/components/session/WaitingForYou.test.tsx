import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WaitingForYou, WaitingRow } from './WaitingForYou';

/**
 * One queue, and every row is a person.
 *
 * The database has three request types and the host has one question — who
 * needs me, and what do they need. These tests guard the phrasing, because the
 * phrasing IS the feature: "Priya wants to join" and "Buy-in request pending"
 * are the same row and not the same product.
 */

const fmt = (n: number) => n.toLocaleString();

function row(over: Partial<WaitingRow> = {}): WaitingRow {
  return {
    id: 'q1',
    kind: 'buy-in',
    userId: 'priya',
    joining: true,
    amount: 5000,
    requestedAt: new Date().toISOString(),
    msRemaining: 4 * 60_000,
    name: 'Priya',
    onApprove: vi.fn(),
    onDismiss: vi.fn(),
    ...over,
  };
}

describe('every row is a person', () => {
  it('says someone wants to join, not that a buy-in is pending', () => {
    render(<WaitingForYou rows={[row()]} formatAmount={fmt} />);
    expect(screen.getByText('Priya')).toBeInTheDocument();
    expect(screen.getByText(/wants to join/i)).toBeInTheDocument();
    expect(screen.getByText('5,000')).toBeInTheDocument();
    expect(screen.queryByText(/request/i)).not.toBeInTheDocument();
  });

  it('tells arriving apart from topping up, though the server cannot', () => {
    // Identical rows in the database; completely different people to talk to.
    const { unmount } = render(<WaitingForYou rows={[row({ joining: true })]} formatAmount={fmt} />);
    expect(screen.getByText(/wants to join/i)).toBeInTheDocument();
    unmount();

    render(<WaitingForYou rows={[row({ joining: false, amount: 3000 })]} formatAmount={fmt} />);
    expect(screen.getByText(/needs more chips/i)).toBeInTheDocument();
    expect(screen.queryByText(/wants to join/i)).not.toBeInTheDocument();
  });

  it('names the physical act for someone leaving, not the transition', () => {
    render(
      <WaitingForYou
        rows={[row({ kind: 'cash-out', joining: false, amount: 7200, name: 'Arjun' })]}
        formatAmount={fmt}
      />
    );
    expect(screen.getByText(/is ready to leave/i)).toBeInTheDocument();
    // "Count chips" is what the host does at the table. "Confirm cash-out" is
    // what the database does, and nobody at a table says it.
    expect(screen.getByRole('button', { name: /count chips/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cash.?out/i })).not.toBeInTheDocument();
  });
});

describe('when the person is the reader', () => {
  it('conjugates for second person', () => {
    // An admin's own request lands in their own queue, and "You needs more
    // chips" is how a sentence announces that it was assembled, not written.
    render(<WaitingForYou rows={[row({ name: 'You', joining: false })]} formatAmount={fmt} />);
    expect(screen.getByText(/need more chips/i)).toBeInTheDocument();
    expect(screen.queryByText(/needs more chips/i)).not.toBeInTheDocument();
  });
});

describe('the five-minute window', () => {
  it('shows time left rather than time waited', () => {
    render(<WaitingForYou rows={[row({ msRemaining: 61_000 })]} formatAmount={fmt} />);
    expect(screen.getByText('1:01')).toBeInTheDocument();
  });

  it('says nothing when there is no timestamp to count from', () => {
    render(<WaitingForYou rows={[row({ msRemaining: null })]} formatAmount={fmt} />);
    expect(screen.queryByText(/^\d+:\d\d$/)).not.toBeInTheDocument();
  });
});

describe('blocked actions', () => {
  it('shows the reason instead of a disabled control', () => {
    // A greyed button with no explanation costs the host three taps to learn
    // what a sentence tells them once.
    render(
      <WaitingForYou
        rows={[row({ blockedReason: 'Another admin needs to approve this one.' })]}
        formatAmount={fmt}
      />
    );
    expect(screen.getByText(/another admin needs to approve/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });
});

describe('the empty queue', () => {
  it('renders nothing at all, rather than reporting zero', () => {
    // A permanent "0 waiting" header would push the table down for no reason
    // and train the eye to skip the one region that must never be skipped.
    const { container } = render(<WaitingForYou rows={[]} formatAmount={fmt} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('acting on a row', () => {
  it('approves and dismisses the person it names', async () => {
    const onApprove = vi.fn();
    const onDismiss = vi.fn();
    render(<WaitingForYou rows={[row({ onApprove, onDismiss })]} formatAmount={fmt} />);

    await userEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(onApprove).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: /not now/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
