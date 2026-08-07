import React from 'react';
import { QueuedRequest } from '../../lib/night-state';
import { PlayerAvatar } from './PlayerAvatar';
import { Button } from '../ui/Button';

/**
 * Things waiting for you.
 *
 * Not a buy-in queue, a sit-in queue and a cash-out queue — one list, and every
 * row is a person. The database has three request types; the host has one
 * question, asked repeatedly through the night: *who needs me, and what do they
 * need?*
 *
 * Every row answers exactly three things, in this order:
 *
 *   WHO           the face and the name first, because the host already knows
 *                 that someone asked — what they are looking for is who
 *   WHAT          a sentence about the person, never a noun about the
 *                 operation. "Priya wants to join", never "Buy-in request"
 *   NEXT ACTION   one control, worded as the thing the host will physically
 *                 do. "Count chips" is what happens at the table; "confirm
 *                 cash-out" is what happens in the database
 *
 * Renders nothing when empty, deliberately. A permanent "0 waiting" header
 * would push the table down for no reason and train the eye to skip the one
 * region that must never be skipped.
 *
 * Replaces ActionQueue, which is still wired to the old screen until cutover.
 */

export interface WaitingRow extends QueuedRequest {
  name: string;
  avatarUrl?: string;
  /** Blocks the action with a reason — e.g. an admin approving their own. */
  blockedReason?: string | null;
  onApprove: () => void;
  onDismiss: () => void;
  pending?: boolean;
}

/**
 * A tag, not a sentence.
 *
 * "Priya wants to join" reads well once and is read fifteen times a night. A
 * label scans: the eye takes the name, the figure and the kind in one pass and
 * never parses grammar. It also sidesteps conjugation entirely — an admin's own
 * request lands in their own queue, and "You needs more chips" is how a
 * sentence announces that it was assembled rather than written.
 */
function phrasing(row: WaitingRow, amount: (n: number) => string) {
  if (row.kind === 'cash-out') {
    return {
      tag: 'Standing up',
      detail: row.amount !== undefined ? amount(row.amount) : null,
      approve: 'Count chips',
      dismiss: 'Not yet',
    };
  }
  if (row.kind === 'sit-in') {
    return { tag: 'Join table', detail: null, approve: 'Seat them', dismiss: 'Not now' };
  }
  // Same row in the database, two entirely different people to talk to.
  return {
    tag: row.joining ? 'Join table' : 'More chips',
    detail: row.amount !== undefined ? amount(row.amount) : null,
    approve: 'Approve',
    dismiss: 'Not now',
  };
}

/** mm:ss. "4 min" asks the reader to do arithmetic against a deadline. */
function countdown(ms: number | null): string | null {
  if (ms === null) return null;
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export const WaitingForYou: React.FC<{
  rows: WaitingRow[];
  formatAmount: (n: number) => string;
}> = ({ rows, formatAmount }) => {
  if (rows.length === 0) return null;

  return (
    <section
      // Announced when it changes: a host looking at the table should be told
      // someone is waiting rather than having to notice it.
      aria-live="polite"
      aria-label={`${rows.length} waiting for you`}
      className="furniture rounded-[var(--radius-lg)] overflow-hidden"
    >
      <h2 className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-[0.18em] text-text-muted">
        Waiting for you
      </h2>

      <ul>
        {rows.map((row) => {
          const { tag, detail, approve, dismiss } = phrasing(row, formatAmount);
          const left = countdown(row.msRemaining);
          const urgent = row.msRemaining !== null && row.msRemaining <= 60_000;

          return (
            <li key={row.id} className="px-4 py-3 border-t border-line/30 first:border-t-0">
              <div className="flex items-center gap-3">
                <PlayerAvatar userId={row.userId} name={row.name} photoUrl={row.avatarUrl} size={38} />

                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold text-text leading-snug truncate">
                    {row.name}
                  </p>
                  {detail && <p className="text-sm text-accent tabular-nums leading-snug">{detail}</p>}
                </div>

                <div className="shrink-0 text-right">
                  <p className="text-xs text-text-muted leading-snug">{tag}</p>
                  {/* The five-minute window, as time LEFT rather than time
                      waited. The server auto-rejects at zero and the request
                      simply vanishes, so this countdown is the only warning
                      anyone gets that it is about to. */}
                  {left && (
                    <p className={`text-xs tabular-nums leading-snug ${urgent ? 'text-warning' : 'text-text-faint'}`}>
                      {left}
                    </p>
                  )}
                </div>
              </div>

              {row.blockedReason ? (
                <p className="mt-2.5 text-xs text-warning leading-relaxed">{row.blockedReason}</p>
              ) : (
                /* Approve is affirmative and expected, so it leads and carries
                   the material. Dismissing is quieter and never the same
                   weight — a mis-tap there is socially expensive at a real
                   table, and the fix is hierarchy rather than an extra step. */
                <div className="mt-2.5 flex items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    fullWidth
                    loading={row.pending}
                    onClick={row.onApprove}
                  >
                    {approve}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={row.pending}
                    onClick={row.onDismiss}
                    className="shrink-0 whitespace-nowrap"
                  >
                    {dismiss}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
