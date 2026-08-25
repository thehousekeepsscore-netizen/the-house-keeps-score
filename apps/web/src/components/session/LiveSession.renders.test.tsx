import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { LiveSession } from './LiveSession';
import type { Club, PokerSession } from '../../types';
import type { Night } from '../../lib/night-state';

/**
 * How often the live session re-renders while a night is running.
 *
 * This was a hypothesis in an earlier audit — `useClock` ticks once a second and
 * lives inside LiveSession, and there is no memoisation anywhere in this
 * directory, so the whole subtree was assumed to re-render every second. It was
 * never measured, and an assumption about render cost is exactly the kind of
 * thing that gets "optimised" into a pile of useMemo nobody can justify.
 *
 * So this counts. It measures render *frequency*, which is a real number the
 * test environment can give honestly. It does not measure render *cost* in
 * milliseconds — jsdom timings say nothing about a phone — so the question of
 * whether the frequency is expensive stays open and belongs to a profiler on a
 * real device.
 */

let renderCount = 0;

/**
 * Counts commits of the LiveSession subtree.
 *
 * React's own Profiler, not a wrapper component: the clock state lives *inside*
 * LiveSession, so a counting wrapper never re-renders and reports zero — which
 * is exactly the false negative this measurement started with. Profiler fires
 * on every commit of the tree it wraps, including state updates originating
 * within it.
 */
const Counted: React.FC<React.ComponentProps<typeof LiveSession>> = (props) => (
  <React.Profiler id="live" onRender={() => { renderCount += 1; }}>
    <LiveSession {...props} />
  </React.Profiler>
);

const club = {
  id: 'c1',
  name: 'Club',
  code: '0007',
  currency: 'INR',
  ownerUid: 'host',
  adminUids: ['host'],
  memberUids: ['host'],
} as unknown as Club;

const night = {
  phase: 'running',
  startedPlayingAt: new Date(Date.now() - 60_000).toISOString(),
  settling: false,
  readyCount: 2,
  lobbyCount: 2,
  canStartPlaying: true,
  seats: [],
  room: [],
  queue: [],
  chipsInPlay: 0,
  playersAtTable: 0,
  settlementUids: [],
  canSettle: false,
  settleBlockedReason: null,
  mySeat: null,
} as unknown as Night;

function makeSession(overrides: Partial<PokerSession> = {}): PokerSession {
  return {
    id: 's1',
    clubId: 'c1',
    status: 'active',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  } as unknown as PokerSession;
}

function renderLive(session: PokerSession) {
  renderCount = 0;
  return render(
    <Counted
      club={club}
      session={session}
      night={night}
      currentUserId="host"
      isAdmin
      users={{}}
      connection="live"
      onStartSession={vi.fn()}
      onSelectPlayer={vi.fn()}
      waiting={[]}
      formatAmount={(n) => String(n)}
      ceiling={null}
      feed={[]}
    />
  );
}

/**
 * One second at a time, each in its own act().
 *
 * Advancing ten seconds in a single act() lets React batch all ten state
 * updates into one commit and reports "1 render for 10 seconds", which is an
 * artefact of the harness rather than what a phone does. Real ticks arrive a
 * second apart and each commits on its own.
 */
function advanceSeconds(n: number) {
  for (let i = 0; i < n; i += 1) {
    act(() => {
      vi.advanceTimersByTime(1000);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('render frequency during a live night', () => {
  it('does not re-render on a timer when the night is untimed', () => {
    // No durationMinutes: `useClock` returns early and never starts an interval.
    renderLive(makeSession());
    const afterMount = renderCount;

    advanceSeconds(10);

    // Not zero: LiveFeed keeps its own 10s timer for relative timestamps, which
    // fires once here. The claim is that the per-second clock is not running —
    // ten seconds must not cost ten renders.
    expect(renderCount - afterMount).toBeLessThanOrEqual(1);
  });

  it('re-renders once per second while the night is timed', () => {
    // The measured claim. A timed night starts the 1s clock, and every tick is
    // a state update in LiveSession itself, so the whole subtree re-renders.
    renderLive(
      makeSession({
        startedPlayingAt: new Date(Date.now() - 60_000).toISOString(),
        durationMinutes: 240,
      } as Partial<PokerSession>)
    );
    const afterMount = renderCount;

    advanceSeconds(10);

    const ticks = renderCount - afterMount;
    // Ten seconds of a timed night costs ten renders of the whole screen.
    expect(ticks).toBe(10);
  });

  it('stops re-rendering once the time limit is lifted', () => {
    // The clock is already gated on this, and the gate is worth protecting:
    // removing it would put the whole screen back on a permanent 1s timer for
    // nights that have no end to count towards.
    renderLive(
      makeSession({
        startedPlayingAt: new Date(Date.now() - 60_000).toISOString(),
        durationMinutes: 240,
        timeLimitLiftedAt: new Date().toISOString(),
      } as Partial<PokerSession>)
    );
    const afterMount = renderCount;

    advanceSeconds(10);

    expect(renderCount - afterMount).toBeLessThanOrEqual(1);
  });
});
