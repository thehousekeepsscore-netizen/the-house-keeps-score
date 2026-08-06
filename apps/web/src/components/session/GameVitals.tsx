import React, { useEffect, useState } from 'react';

/**
 * The state of the night, in one row.
 *
 * The session screen could say a session was running and who was seated, but
 * not how the night was going. Three of the six questions in the three-second
 * test — how many are playing, how much is on the table, how long has this been
 * going — had no answer anywhere on the screen.
 *
 * One line rather than a card, deliberately. It sits above the action queue, and
 * anything taller would push the decisions down and defeat the point of putting
 * them first.
 *
 * It does NOT show the pot. The felt does, in the middle of the table, which is
 * where a poker player looks for it — and saying it twice on one screen taught
 * the eye that neither instance mattered.
 *
 * Figures are tabular so they do not jitter as they change — a number that
 * shifts sideways while you are reading it reads as instability, which is
 * exactly wrong for money.
 */

export interface GameVitalsProps {
  playersIn: number;
  /** Total chips bought in and still on the table. */
  chipsInPlay: number;
  /** ISO timestamp the session started. */
  startedAt?: string;
}

/** "3h 20m" / "45m" — duration, not a clock reading. */
function elapsed(from?: string): string | null {
  if (!from) return null;
  const ms = Date.now() - new Date(from).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex-1 min-w-0">
    <div className="text-xs text-text-muted truncate">{label}</div>
    {/* No truncation on the value. A money figure showing "13,000 …" is worse
        than a slightly smaller one — an ellipsis in the middle of an amount is
        the one place this row must never economise. */}
    <div className="text-base font-semibold text-text tabular-nums whitespace-nowrap">{value}</div>
  </div>
);

export const GameVitals: React.FC<GameVitalsProps> = ({ playersIn, chipsInPlay, startedAt }) => {
  // Ticks once a minute, not once a second. A duration that changes every second
  // draws the eye to the least important thing on the screen, and re-rendering
  // this row 60x more often buys nothing at minute resolution.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const running = elapsed(startedAt);

  return (
    <div className="flex items-center gap-4 px-5 py-3 bg-surface border border-line rounded-2xl">
      <Stat label="Playing" value={String(playersIn)} />
      {running && (
        <>
          <div className="w-px h-8 bg-line shrink-0" aria-hidden="true" />
          <Stat label="Running" value={running} />
        </>
      )}
    </div>
  );
};
