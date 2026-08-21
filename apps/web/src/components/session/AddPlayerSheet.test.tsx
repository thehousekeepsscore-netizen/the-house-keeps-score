import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddPlayerSheet, AddPlayerSheetProps } from './AddPlayerSheet';

/**
 * Choosing a person, and nothing else.
 *
 * The load-bearing claim is a negative one: this sheet never asks how many
 * chips. The moment it did there would be two implementations of that question
 * — one for a player joining themselves, one for a host seating them — and the
 * one nobody looked at would drift. Picking a name here hands off to that
 * person's own sheet, which already opens on the bank chooser for anyone with
 * no seat.
 */

const people = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, name: `Player ${i}` }));

function show(over: Partial<AddPlayerSheetProps> = {}) {
  const props: AddPlayerSheetProps = {
    open: true,
    onClose: vi.fn(),
    candidates: [
      { userId: 'priya', name: 'Priya' },
      { userId: 'arjun', name: 'Arjun' },
    ],
    onSelect: vi.fn(),
    ...over,
  };
  render(<AddPlayerSheet {...props} />);
  return props;
}

describe('it picks a person, not an amount', () => {
  it('offers no way to choose chips here', () => {
    show();
    expect(screen.queryByText(/bank|chips|amount/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^request/i })).not.toBeInTheDocument();
  });

  it('hands the person off, so the one bank chooser does the rest', async () => {
    const { onSelect } = show();
    await userEvent.click(screen.getByRole('button', { name: /priya/i }));
    expect(onSelect).toHaveBeenCalledWith('priya');
  });
});

describe('who it lists', () => {
  it('says so plainly when everybody is already in the night', () => {
    // Not an empty sheet. "Nothing here" and "everyone is already playing" are
    // the same screen and not the same answer.
    show({ candidates: [] });
    expect(screen.getByText(/already in the night/i)).toBeInTheDocument();
  });

  it('leaves search out of a list short enough to read', () => {
    show();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('brings search in once the list is long enough to need it', () => {
    show({ candidates: people(12) });
    expect(screen.getByLabelText(/search members/i)).toBeInTheDocument();
  });

  it('filters by name, and says when nothing matches', async () => {
    show({ candidates: [...people(11), { userId: 'x', name: 'Meera' }] });
    const box = screen.getByLabelText(/search members/i);

    await userEvent.type(box, 'meer');
    expect(screen.getByRole('button', { name: /meera/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /player 3/i })).not.toBeInTheDocument();

    await userEvent.clear(box);
    await userEvent.type(box, 'zzz');
    expect(screen.getByText(/nobody by that name/i)).toBeInTheDocument();
  });
});
