import React, { useEffect, useRef, useState } from 'react';
import { PokerSession } from '../../types';
import { Button } from '../ui/Button';
import {
  ClockPhase,
  NightClockState,
  coarseLabel,
  nightClock,
  preciseLabel,
} from '../../lib/night-clock';

/**
 * The scheduled game, which is not the same thing as the poker night.
 *
 * The duration a host picks is a plan. Poker nights run over — that is what
 * poker nights do — so the clock reaching zero starts a conversation rather
 * than ending anything. Through the grace period and past it, players buy in,
 * stand up and are approved exactly as before; the clock's only power is to say
 * what time it is.
 *
 * Nothing here is a modal. A dialog over the table at ten past eleven demands
 * that somebody deal with the app before they can deal with the room, which is
 * precisely backwards. Everything is a band that sits above the felt and can be
 * ignored.
 */

/** Ticks once a second only while a night actually has an end to count towards. */
function useClock(session: PokerSession | null): NightClockState {
  const [now, setNow] = useState(() => Date.now());
  const live = Boolean(session?.startedPlayingAt && session?.durationMinutes && !session?.timeLimitLiftedAt);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  return nightClock(session, now);
}

/**
 * The line in the header. Always visible once a night is timed.
 *
 * Coarse while there is time, because at an hour out the seconds are noise and
 * nobody is reading them. Amber inside the last fifteen minutes: a change of
 * colour is enough to notice without being told.
 */
export const NightClockLine: React.FC<{ clock: NightClockState }> = ({ clock }) => {
  // Only while it is counting. Once the plan has run out the band directly
  // below says the same words and more, and saying them twice a centimetre
  // apart is the on-screen-twice defect PRODUCT-BRIEF §14 exists to remove.
  if (clock.phase !== 'running') return null;

  return (
    <div className="mt-1 flex items-baseline gap-2">
      <span className="text-xs text-text-muted">Playing</span>
      <span
        className={`ml-auto text-sm font-semibold tabular-nums ${
          clock.ending ? 'text-warning' : 'text-text'
        }`}
      >
        {coarseLabel(clock.msRemaining ?? 0)} remaining
      </span>
    </div>
  );
};

/**
 * The band above the table: the fifteen-minute nudge, the grace countdown, and
 * the one decision at the end of it.
 *
 * Only an admin is offered a control. A player sees the same information and no
 * buttons, because none of these are theirs to decide.
 */
export const NightClockBanner: React.FC<{
  clock: NightClockState;
  isAdmin: boolean;
  onExtend?: () => void;
  onKeepPlaying?: () => void;
  onSettle?: () => void;
  busy?: boolean;
}> = ({ clock, isAdmin, onExtend, onKeepPlaying, onSettle, busy = false }) => {
  // The fifteen-minute nudge is shown once and then goes away on its own.
  // Standing there for the whole quarter of an hour would make it furniture.
  const [nudged, setNudged] = useState(false);
  const seenRef = useRef(false);
  useEffect(() => {
    if (!clock.ending || seenRef.current) return;
    seenRef.current = true;
    setNudged(true);
    const id = setTimeout(() => setNudged(false), 12_000);
    return () => clearTimeout(id);
  }, [clock.ending]);

  if (clock.phase === 'running') {
    if (!nudged) return null;
    return (
      <Band>
        <p className="text-sm text-warning">
          {coarseLabel(clock.msRemaining ?? 0)} remaining
        </p>
      </Band>
    );
  }

  if (clock.phase === 'grace') {
    return (
      <Band>
        <div className="flex items-baseline gap-2">
          <p className="text-sm text-text">Time limit reached</p>
          <p className="ml-auto text-sm font-semibold text-warning tabular-nums">
            {preciseLabel(clock.msOfGraceLeft ?? 0)}
          </p>
        </div>
        <p className="mt-0.5 text-xs text-text-faint">
          Grace period — nothing has stopped.
        </p>
        {isAdmin && onExtend && (
          <Button variant="secondary" size="sm" fullWidth className="mt-2" onClick={onExtend}>
            Extend session
          </Button>
        )}
      </Band>
    );
  }

  if (clock.phase === 'complete') {
    return (
      <Band>
        <p className="text-sm text-text">Session complete</p>
        <p className="mt-0.5 text-xs text-text-faint">The scheduled session has ended.</p>
        {isAdmin && (
          <div className="mt-2 flex items-center gap-2">
            <Button variant="ghost" size="sm" fullWidth loading={busy} onClick={onKeepPlaying}>
              Continue playing
            </Button>
            <Button variant="primary" size="sm" fullWidth onClick={onSettle}>
              Settle night
            </Button>
          </div>
        )}
      </Band>
    );
  }

  return null;
};

const Band: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="shrink-0 mx-3 mb-3 px-4 py-2.5 furniture rounded-[var(--radius-lg)]">
    {children}
  </div>
);

export { useClock };
export type { ClockPhase };
