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
 * Three fields, and nothing else:
 *
 *   WHO      the face and the name
 *   HOW MUCH the figure, because that is what a decision turns on
 *   WHAT     one tag — "Join table", "More chips", "Cash out"
 *
 * No sentences. An earlier version wrote "Priya wants to join", which reads
 * well once and is read fifteen times a night. A tag scans: the eye takes the
 * name, the figure and the kind in one pass and never parses grammar. It also
 * sidesteps conjugation — an admin's own request lands in their own queue, and
 * "You needs more chips" is how a sentence announces it was assembled rather
 * than written.
 *
 * THE HEIGHT IS FIXED, and that is a table decision rather than a queue one.
 * Requests arrive while the host is looking at the felt, and a queue that grows
 * pushes the table down mid-glance — seats move under a thumb that was already
 * on its way to one (PRODUCT-BRIEF §2.5). So the region tops out at two cards
 * and scrolls inside itself. Beyond two, the only thing that moves is the list.
 *
 * Renders nothing when empty, deliberately. A permanent "0 waiting" header would
 * cost the table 100px to say nothing, and train the eye to skip the one region
 * that must never be skipped.
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

/** One card, and the region shows exactly two of them. Keep in step with the CSS. */
const CARD_H = 88;
const VISIBLE_CARDS = 2;

/** A tag, not a sentence. Same row in the database, different person to talk to. */
function tagOf(row: WaitingRow): string {
  if (row.kind === 'cash-out') return 'Cash out';
  if (row.kind === 'sit-in') return 'Join table';
  return row.joining ? 'Join table' : 'More chips';
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

  const scrolls = rows.length > VISIBLE_CARDS;

  return (
    <section
      // Announced when it changes: a host looking at the table should be told
      // someone is waiting rather than having to notice it.
      aria-live="polite"
      aria-label={`${rows.length} waiting for you`}
      className="furniture rounded-[var(--radius-lg)] overflow-hidden shrink-0"
    >
      <h2 className="px-4 pt-2.5 pb-1 text-[10px] uppercase tracking-[0.18em] text-text-muted">
        Waiting for you
      </h2>

      <ul
        // Two cards' worth, and the third onwards is reached by scrolling this
        // list rather than by moving the table.
        style={scrolls ? { maxHeight: CARD_H * VISIBLE_CARDS } : undefined}
        className={scrolls ? 'overflow-y-auto overscroll-contain' : undefined}
      >
        {rows.map((row) => {
          const left = countdown(row.msRemaining);
          const urgent = row.msRemaining !== null && row.msRemaining <= 60_000;

          return (
            <li
              key={row.id}
              style={{ height: CARD_H }}
              className="px-3 flex flex-col justify-center gap-1 border-t border-line/30 first:border-t-0"
            >
              <div className="flex items-center gap-2.5">
                <PlayerAvatar userId={row.userId} name={row.name} photoUrl={row.avatarUrl} size={30} />
                <p className="flex-1 min-w-0 text-[15px] font-semibold text-text truncate">
                  {row.name}
                </p>
                {row.amount !== undefined && (
                  <p className="text-[15px] text-accent tabular-nums shrink-0">
                    {formatAmount(row.amount)}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2">
                <p className="text-xs text-text-muted shrink-0">{tagOf(row)}</p>

                {/* The five-minute window, as time LEFT rather than time waited.
                    The server auto-rejects at zero and the request simply
                    vanishes, so this is the only warning anyone gets. */}
                {left && (
                  <p className={`text-xs tabular-nums shrink-0 ${urgent ? 'text-warning' : 'text-text-faint'}`}>
                    {left}
                  </p>
                )}

                {row.blockedReason ? (
                  <p className="ml-auto text-xs text-warning truncate">{row.blockedReason}</p>
                ) : (
                  /* Approve is affirmative and expected, so it leads and carries
                     the material. Dismissing is quieter and never the same
                     weight — a mis-tap there is socially expensive at a real
                     table, and the fix is hierarchy rather than an extra step. */
                  <div className="ml-auto flex items-center gap-1.5 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={row.pending}
                      onClick={row.onDismiss}
                      className="whitespace-nowrap"
                    >
                      Not now
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      loading={row.pending}
                      onClick={row.onApprove}
                      className="whitespace-nowrap"
                    >
                      Approve
                    </Button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
