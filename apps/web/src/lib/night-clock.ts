import { PokerSession } from '../types';

/**
 * The difference between the scheduled game and the actual poker night.
 *
 * The duration a host picks is a PLAN. The night does not have to end because
 * the plan ran out, and an app that settled the game at ten past eleven because
 * a dropdown said two hours would be running the evening rather than helping
 * with it.
 *
 * So the clock has four states and only one of them is an ending:
 *
 *   none      no limit was set, or one was lifted — nothing to count towards
 *   running   counting down to the scheduled end
 *   grace     the plan ran out five minutes ago or less; nothing is locked
 *   complete  nobody extended, and the host is asked what they want to do
 *
 * Nothing here ever locks anything. Through grace and complete alike, players
 * buy in, stand up and are approved exactly as before — the clock's only power
 * is to tell people what time it is.
 */

export const GRACE_MS = 5 * 60_000;
/** The point at which the countdown turns amber and says so, once. */
export const WARN_MS = 15 * 60_000;

export type ClockPhase = 'none' | 'running' | 'grace' | 'complete';

export interface NightClockState {
  phase: ClockPhase;
  /** Counting down to the scheduled end. Null unless running. */
  msRemaining: number | null;
  /** Counting down to the end of grace. Null unless in grace. */
  msOfGraceLeft: number | null;
  /** When the plan runs out, including every extension. Null when there is no plan. */
  endsAt: number | null;
  /** Running, and inside the last fifteen minutes. */
  ending: boolean;
  /** Total minutes the night is scheduled for, extensions included. */
  totalMinutes: number | null;
}

const NONE: NightClockState = {
  phase: 'none',
  msRemaining: null,
  msOfGraceLeft: null,
  endsAt: null,
  ending: false,
  totalMinutes: null,
};

/** Every extension, added to the original plan. Additive and unlimited by design. */
export function scheduledMinutes(session: PokerSession): number | null {
  if (!session.durationMinutes) return null;
  const added = (session.timeExtensions ?? []).reduce((sum, e) => sum + e.minutes, 0);
  return session.durationMinutes + added;
}

export function nightClock(session: PokerSession | null, now: number): NightClockState {
  if (!session) return NONE;
  // Lifting the limit is deliberately one-way for the rest of the night. It is
  // what stops a night that ran three hours over showing a grace period every
  // five minutes for the last two of them.
  if (session.timeLimitLiftedAt) return NONE;

  const startedAt = session.startedPlayingAt ? Date.parse(session.startedPlayingAt) : NaN;
  const total = scheduledMinutes(session);
  if (!Number.isFinite(startedAt) || total === null) return NONE;

  const endsAt = startedAt + total * 60_000;
  const left = endsAt - now;

  if (left > 0) {
    return {
      phase: 'running',
      msRemaining: left,
      msOfGraceLeft: null,
      endsAt,
      ending: left <= WARN_MS,
      totalMinutes: total,
    };
  }

  const graceLeft = endsAt + GRACE_MS - now;
  if (graceLeft > 0) {
    return {
      phase: 'grace',
      msRemaining: null,
      msOfGraceLeft: graceLeft,
      endsAt,
      ending: false,
      totalMinutes: total,
    };
  }

  return {
    phase: 'complete',
    msRemaining: null,
    msOfGraceLeft: null,
    endsAt,
    ending: false,
    totalMinutes: total,
  };
}

/**
 * "1h 12m remaining" while there is time, "04:59" once there is not.
 *
 * Two formats on purpose. An hour out, seconds are noise and nobody is reading
 * them; inside the grace period they are the whole point, because five minutes
 * is a decision window rather than a duration.
 */
export function coarseLabel(ms: number): string {
  const mins = Math.max(0, Math.ceil(ms / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function preciseLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** How a duration reads in a sentence: "2-hour", "30-minute". */
export function durationPhrase(minutes: number): string {
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return `${h}-hour`;
  }
  return `${minutes}-minute`;
}
