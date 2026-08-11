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

/**
 * The tag and how long they have waited share one line — "More chips • 2m" —
 * so matching the tag means matching within a node rather than the whole of it.
 */
const tagLine = (re: RegExp) =>
  screen.getByText((_, el) => el?.tagName === 'P' && re.test(el.textContent ?? ''));
const noTagLine = (re: RegExp) =>
  screen.queryByText((_, el) => el?.tagName === 'P' && re.test(el.textContent ?? ''));

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
  it('is scannable — a name, a figure and a tag, never a sentence', () => {
    render(<WaitingForYou rows={[row()]} formatAmount={fmt} />);
    expect(screen.getByText('Priya')).toBeInTheDocument();
    expect(screen.getByText('5,000')).toBeInTheDocument();
    expect(tagLine(/^Join table •/)).toBeInTheDocument();
    // Nothing to parse, and nothing that reads as a database operation.
    expect(screen.queryByText(/wants to|request|pending/i)).not.toBeInTheDocument();
  });

  it('tells arriving apart from topping up, though the server cannot', () => {
    // Identical rows in the database; completely different people to talk to.
    const { unmount } = render(<WaitingForYou rows={[row({ joining: true })]} formatAmount={fmt} />);
    expect(tagLine(/^Join table •/)).toBeInTheDocument();
    unmount();

    render(<WaitingForYou rows={[row({ joining: false, amount: 3000 })]} formatAmount={fmt} />);
    expect(tagLine(/^More chips •/)).toBeInTheDocument();
    expect(noTagLine(/Join table/)).not.toBeInTheDocument();
  });

  it('tags someone leaving with the kind of request, and the figure they counted', () => {
    render(
      <WaitingForYou
        rows={[row({ kind: 'cash-out', joining: false, amount: 7200, name: 'Arjun' })]}
        formatAmount={fmt}
      />
    );
    expect(tagLine(/^Cash out •/)).toBeInTheDocument();
    expect(screen.getByText('7,200')).toBeInTheDocument();
    // One verb across all three kinds. The host is answering the same question
    // every time — yes or not yet — and three different words for "yes" made
    // them read the card to find out which button they were about to press.
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeInTheDocument();
  });
});

/**
 * The region is a fixed size, and that is a decision about the TABLE.
 *
 * Requests arrive while the host is looking at the felt. A queue that grows
 * with its contents pushes the table down mid-glance, which moves seats under
 * a thumb already travelling towards one — PRODUCT-BRIEF §2.5.
 */
describe('the queue never moves the table', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      row({ id: `r${i}`, userId: `u${i}`, name: `Player ${i}`, amount: 5000 })
    );

  it('scrolls inside itself once there are more than two', () => {
    const { container } = render(<WaitingForYou rows={rows(5)} formatAmount={fmt} />);
    const list = container.querySelector('ul')!;
    expect(list.className).toMatch(/overflow-y-auto/);
    // Two cards' worth, and no more, whatever arrives. 64 a row since the
    // queue was compacted — the padding went, the type sizes did not.
    expect(list.style.maxHeight).toBe('128px');
  });

  it('does not cap itself when everything already fits', () => {
    // A two-card window drawn around one card is a hole in the screen.
    const { container } = render(<WaitingForYou rows={rows(2)} formatAmount={fmt} />);
    const list = container.querySelector('ul')!;
    expect(list.className).not.toMatch(/overflow-y-auto/);
    expect(list.style.maxHeight).toBe('');
  });
});

describe('when the person is the reader', () => {
  it('needs no conjugation, because there is no verb', () => {
    // An admin's own request lands in their own queue. A sentence would have
    // to say "You needs more chips"; a tag simply does not have the problem.
    render(<WaitingForYou rows={[row({ name: 'You', joining: false })]} formatAmount={fmt} />);
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(tagLine(/^More chips •/)).toBeInTheDocument();
  });
});

/**
 * How long they have been waiting, and — only at the end — how long is left.
 *
 * Age is the social fact, and it is the right reading for almost the whole life
 * of a request: "Arjun asked two minutes ago". A deadline ticking on every row
 * would make an ordinary queue look like an emergency.
 *
 * The last minute is the exception, because the server auto-rejects at five and
 * the request simply disappears. That is the one moment the honest reading is
 * that it is about to.
 */
describe('the five-minute window', () => {
  it('reads as how long they have been waiting', () => {
    render(<WaitingForYou rows={[row({ msRemaining: 3 * 60_000 })]} formatAmount={fmt} />);
    expect(tagLine(/• 2m$/)).toBeInTheDocument();
  });

  it('says "just now" rather than "0m" for someone who has only asked', () => {
    render(<WaitingForYou rows={[row({ msRemaining: 4.6 * 60_000 })]} formatAmount={fmt} />);
    expect(tagLine(/• just now$/)).toBeInTheDocument();
  });

  it('switches to the deadline in the final minute, and marks it', () => {
    render(<WaitingForYou rows={[row({ msRemaining: 30_000 })]} formatAmount={fmt} />);
    const warning = screen.getByText('expires in 30s');
    expect(warning).toBeInTheDocument();
    expect(warning.className).toMatch(/text-warning/);
  });

  it('says nothing when there is no timestamp to count from', () => {
    render(<WaitingForYou rows={[row({ msRemaining: null })]} formatAmount={fmt} />);
    expect(noTagLine(/•/)).not.toBeInTheDocument();
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

    await userEvent.click(screen.getByRole('button', { name: /later/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
