import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { NightClock, clockLabel, msUntilEnd } from './NightClock';

/**
 * The clock informs. It never ends a night.
 *
 * Poker nights run over — that is what poker nights do — and an app that
 * settled the game at ten past eleven because a dropdown said two hours would
 * be running the evening rather than helping with it. Everything here follows
 * from that one decision.
 */

const START = Date.parse('2026-08-06T21:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => vi.useRealTimers());

describe('what it counts', () => {
  it('says nothing at all when no length was set', () => {
    // The common case. A night with no end has nothing to count towards, so it
    // is shown no clock rather than a clock reading zero.
    const { container } = render(
      <NightClock startedPlayingAt={new Date(START).toISOString()} durationMinutes={undefined} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('says nothing in the lobby, where the night has not started', () => {
    const { container } = render(<NightClock startedPlayingAt={null} durationMinutes={120} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('counts down from when play began, not from when the table opened', () => {
    render(
      <NightClock
        startedPlayingAt={new Date(START - 30 * 60_000).toISOString()}
        durationMinutes={120}
      />
    );
    expect(screen.getByText('Ends in')).toBeInTheDocument();
    expect(screen.getByText('1:30:00')).toBeInTheDocument();
  });

  it('keeps counting UP once the night runs over', () => {
    // Not "0:00" held forever, and not a night that ended itself.
    render(
      <NightClock
        startedPlayingAt={new Date(START - 150 * 60_000).toISOString()}
        durationMinutes={120}
      />
    );
    expect(screen.getByText('Playing on')).toBeInTheDocument();
    expect(screen.getByText('+30:00')).toBeInTheDocument();
  });
});

describe('reaching zero', () => {
  it('says so exactly once, however long the night carries on', () => {
    // Firing on every tick past zero would reopen the prompt every second of a
    // night that ran an hour over.
    const onTimeUp = vi.fn();
    render(
      <NightClock
        startedPlayingAt={new Date(START - 119.98 * 60_000).toISOString()}
        durationMinutes={120}
        onTimeUp={onTimeUp}
      />
    );
    expect(onTimeUp).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(5_000); });
    expect(onTimeUp).toHaveBeenCalledTimes(1);

    act(() => { vi.advanceTimersByTime(60_000); });
    expect(onTimeUp).toHaveBeenCalledTimes(1);
  });
});

describe('the label', () => {
  it('drops the hour when there is not one, because this is read at a glance', () => {
    expect(clockLabel(59_000)).toBe('00:59');
    expect(clockLabel(9 * 60_000 + 5_000)).toBe('09:05');
    expect(clockLabel(3 * 3_600_000 + 4 * 60_000)).toBe('3:04:00');
  });

  it('never goes negative — overtime is signed by the caller, not by the maths', () => {
    expect(clockLabel(-5_000)).toBe('00:00');
  });
});

describe('the arithmetic', () => {
  it('has no answer without both a start and a length', () => {
    expect(msUntilEnd(null, 120, START)).toBeNull();
    expect(msUntilEnd(new Date(START).toISOString(), undefined, START)).toBeNull();
    expect(msUntilEnd('not a date', 120, START)).toBeNull();
  });
});
