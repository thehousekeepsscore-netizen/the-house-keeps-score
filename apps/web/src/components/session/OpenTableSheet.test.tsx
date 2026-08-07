import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OpenTableSheet } from './OpenTableSheet';

/**
 * Two verbs, two moments.
 *
 *   Open table    the room is ready — people can arrive, sit down and buy in
 *   Start playing the first hand is about to be dealt
 *
 * One tap used to do both, and the app claimed a poker night was under way
 * before anybody had joined, bought chips, or agreed to begin.
 */

function show(over: Partial<React.ComponentProps<typeof OpenTableSheet>> = {}) {
  const onOpenTable = vi.fn();
  render(
    <OpenTableSheet open onClose={vi.fn()} onOpenTable={onOpenTable} {...over} />
  );
  return { onOpenTable };
}

describe('it opens a table rather than starting a game', () => {
  it('says so, so the two moments are not confused', () => {
    show();
    expect(screen.getByRole('button', { name: /open table/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start playing/i })).not.toBeInTheDocument();
    expect(screen.getByText(/you start the game yourself/i)).toBeInTheDocument();
  });

  it('opens with no time limit, because that is what most nights are', () => {
    const { onOpenTable } = show();
    return userEvent.click(screen.getByRole('button', { name: /open table/i })).then(() => {
      expect(onOpenTable).toHaveBeenCalledWith({ durationMinutes: undefined, remindAtEnd: false });
    });
  });

  it('asks how long only once a night is timed', async () => {
    show();
    expect(screen.queryByText(/how long/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /timed game/i }));
    expect(screen.getByText(/how long/i)).toBeInTheDocument();
  });

  it('carries the length that was picked', async () => {
    const { onOpenTable } = show();
    await userEvent.click(screen.getByRole('radio', { name: /timed game/i }));
    await userEvent.click(screen.getByRole('button', { name: '1 hour' }));
    await userEvent.click(screen.getByRole('button', { name: /open table/i }));
    expect(onOpenTable).toHaveBeenCalledWith({ durationMinutes: 60, remindAtEnd: true });
  });
});

describe('the clock informs, it never dictates', () => {
  it('offers to TELL the host, not to end the night for them', () => {
    // Deliberately not "auto-end". Poker nights run over, and a timer that
    // settled the game would be running the evening rather than helping.
    show();
    expect(screen.queryByText(/auto.?end/i)).not.toBeInTheDocument();
  });

  it('says outright that nothing ends by itself', async () => {
    show();
    await userEvent.click(screen.getByRole('radio', { name: /timed game/i }));
    expect(screen.getByRole('checkbox', { name: /tell me when time is up/i })).toBeInTheDocument();
    expect(screen.getByText(/never ends the night/i)).toBeInTheDocument();
  });

  it('lets the host decline being told, and still keeps the length', async () => {
    const { onOpenTable } = show();
    await userEvent.click(screen.getByRole('radio', { name: /timed game/i }));
    await userEvent.click(screen.getByRole('checkbox', { name: /tell me when time is up/i }));
    await userEvent.click(screen.getByRole('button', { name: /open table/i }));
    expect(onOpenTable).toHaveBeenCalledWith({ durationMinutes: 120, remindAtEnd: false });
  });
});
