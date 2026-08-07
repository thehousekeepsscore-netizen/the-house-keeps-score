import React, { useEffect, useState } from 'react';

/**
 * How long is left, when the host set a length.
 *
 * The clock INFORMS. It never ends a night: poker nights run over, that is what
 * poker nights do, and an app that settled the game at ten past eleven because
 * a dropdown said two hours would be dictating the evening rather than helping
 * with it. When it reaches zero it says so once, and the host decides.
 *
 * Absent entirely when no limit was set, which is the common case. A night with
 * no end time should not be shown a clock at all — there is nothing for it to
 * count towards.
 */

/** Whole seconds left, or null when this night has no end. */
export function msUntilEnd(
  startedPlayingAt: string | null,
  durationMinutes: number | undefined,
  now: number
): number | null {
  if (!startedPlayingAt || !durationMinutes) return null;
  const started = Date.parse(startedPlayingAt);
  if (!Number.isFinite(started)) return null;
  return started + durationMinutes * 60_000 - now;
}

/** mm:ss under an hour, h:mm:ss over it. Never a phrase — this is read at a glance. */
export function clockLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export const NightClock: React.FC<{
  startedPlayingAt: string | null;
  durationMinutes?: number;
  /** Fired once, when the clock first reaches zero. */
  onTimeUp?: () => void;
}> = ({ startedPlayingAt, durationMinutes, onTimeUp }) => {
  const [now, setNow] = useState(() => Date.now());

  // A real second, because this one counts down and a coarser tick would visibly
  // skip. It is the only per-second timer in the app, and it exists only while a
  // night actually has an end to count towards.
  useEffect(() => {
    if (!startedPlayingAt || !durationMinutes) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedPlayingAt, durationMinutes]);

  const left = msUntilEnd(startedPlayingAt, durationMinutes, now);

  // Announced once, on the crossing. Firing while `left <= 0` would reopen the
  // prompt every second of a night that carried on past its hour.
  const firedRef = React.useRef(false);
  useEffect(() => {
    if (left === null || left > 0 || firedRef.current) return;
    firedRef.current = true;
    onTimeUp?.();
  }, [left, onTimeUp]);

  if (left === null) return null;

  const over = left <= 0;
  return (
    <div className="mt-1 flex items-baseline gap-2">
      <span className="text-xs text-text-muted">{over ? 'Playing on' : 'Ends in'}</span>
      <span
        className={`ml-auto text-sm font-semibold tabular-nums ${
          over ? 'text-text-muted' : left <= 5 * 60_000 ? 'text-warning' : 'text-text'
        }`}
      >
        {over ? `+${clockLabel(-left)}` : clockLabel(left)}
      </span>
    </div>
  );
};
