import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettlementPreview, MASKED_BALANCE } from './SettlementPreview';
import type { Club } from '../types';
import { computeSettlement, type SettlementSettings } from '../lib/settlementEngine';

/**
 * The preview's pot line, on its own.
 *
 * Whether a pot line appears is decided by the payload, not the caller: the
 * API sends a balance to the owner alone, so a club without one means "not
 * yours to see" and the line is left out entirely — contribution included.
 * With a balance, the figures are plain unless the caller wires the eye, in
 * which case they start masked and the eye reveals them.
 */

const club = {
  id: 'c1',
  name: 'All In Poker 2026',
  potEnabled: true,
  sessionRakeAmount: 1000,
  winnersCutPercent: 0,
  mismatchStrategy: 'PROPORTIONAL_WINNERS',
} as unknown as Club;

const rules = {
  sessionRakeAmount: 1000,
  winnersCutPercent: 0,
  rakeEnabled: false,
  rakeMethod: 'PERCENT_PROFIT',
  rakeValue: 0,
  potEnabled: true,
  mismatchStrategy: 'PROPORTIONAL_WINNERS',
  rakeOrder: 'MISMATCH_FIRST',
  winnerDefinition: 'PROFIT_POSITIVE',
  winnerTopN: 1,
  roundingRule: 'NONE',
} as SettlementSettings;

/** The real engine: two seats at 1,000 each, no mismatch, so the pot moves by exactly +2,000. */
const result = computeSettlement(
  [
    { userId: 'a', userDisplayName: 'A', buyIn: 5000, cashOut: 8000 },
    { userId: 'b', userDisplayName: 'B', buyIn: 5000, cashOut: 2000 },
  ],
  rules,
  { currentPotBalance: 0 }
);

const chips = (n: number) => `${n.toLocaleString()} Chips`;
const signed = (n: number) => `${n >= 0 ? '+' : '-'}${Math.abs(n).toLocaleString()} Chips`;

function draw(theClub: Club, extra: Partial<React.ComponentProps<typeof SettlementPreview>> = {}) {
  return render(
    <SettlementPreview result={result} club={theClub} settings={rules} formatAmount={chips} formatSigned={signed} {...extra} />
  );
}

describe('without a balance in the payload', () => {
  it('renders no pot line — not the contribution either', () => {
    draw(club);
    expect(screen.queryByText('Club Pot')).toBeNull();
    expect(document.body.textContent).not.toMatch(/club pot|pot share/i);
    // The rest of the preview is intact.
    expect(screen.getAllByText(/^Profit \/ loss$/i).length).toBeGreaterThan(0);
  });

  it('renders no pot share on the edit preview either', () => {
    draw(club, { potDisplay: 'share' });
    expect(document.body.textContent).not.toMatch(/pot share|club pot/i);
  });
});

describe('with a balance in the payload', () => {
  const owned = { ...club, clubPotBalance: 583_491 } as Club;

  it('shows the figures plainly when no eye is wired', () => {
    draw(owned);
    expect(screen.getByText('Club Pot')).toBeInTheDocument();
    expect(document.body.textContent).toContain('583,491 Chips');
    expect(document.body.textContent).toContain('585,491 Chips');
    expect(screen.queryByRole('button', { name: /club pot balance/i })).toBeNull();
  });

  it('starts masked when the eye is wired, and the eye reveals and re-masks', () => {
    const onToggle = vi.fn();
    const { rerender } = draw(owned, { potBalanceRevealed: false, onTogglePotBalance: onToggle });
    expect(document.body.textContent).not.toContain('583,491');
    expect(document.body.textContent).not.toContain('585,491');
    expect(document.body.textContent).toContain(MASKED_BALANCE);
    // The contribution is not the secret: it sits beside the label in the open.
    expect(screen.getByText('Club Pot').closest('div.p-3')?.textContent).toBe('Club Pot•••••• + 2,000 Chips••••••');

    fireEvent.click(screen.getByRole('button', { name: /show club pot balance/i }));
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <SettlementPreview result={result} club={owned} settings={rules} formatAmount={chips} formatSigned={signed} potBalanceRevealed onTogglePotBalance={onToggle} />
    );
    expect(document.body.textContent).toContain('583,491 Chips');
    expect(document.body.textContent).toContain('585,491 Chips');
    expect(document.body.textContent).not.toContain(MASKED_BALANCE);
    expect(screen.getByRole('button', { name: /hide club pot balance/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('treats an unset reveal as masked, not revealed, once the eye is wired', () => {
    draw(owned, { onTogglePotBalance: vi.fn() });
    expect(document.body.textContent).toContain(MASKED_BALANCE);
    expect(document.body.textContent).not.toContain('583,491');
  });

  it('offers no eye on the edit preview, which shows the share and never the balance', () => {
    draw(owned, { potDisplay: 'share', potBalanceRevealed: false, onTogglePotBalance: vi.fn() });
    expect(screen.getByText('Pot share')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /club pot balance/i })).toBeNull();
    expect(document.body.textContent).not.toContain('583,491');
  });
});
