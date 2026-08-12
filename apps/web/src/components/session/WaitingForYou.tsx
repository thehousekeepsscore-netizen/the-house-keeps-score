import React from 'react';
import { QueuedRequest, REQUEST_TTL_MS } from '../../lib/night-state';
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

/** One row, and the region shows exactly two of them. Keep in step with the CSS. */
/*
 * A row's height, and the queue's whole vertical cost.
 *
 * 76 with the caption above it put a single pending request over 100px on the
 * felt's doorstep — and the felt is what people are looking at. 64 keeps both
 * lines at their existing sizes (15px name and figure, 12px tag) and takes the
 * padding instead, which is what was actually spare.
 */
const CARD_H = 56;
const VISIBLE_CARDS = 2;

/** A tag, not a sentence. Same row in the database, different person to talk to. */
function tagOf(row: WaitingRow): string {
  if (row.kind === 'cash-out') return 'Cash out';
  if (row.kind === 'sit-in') return 'Join table';
  return row.joining ? 'Join table' : 'More chips';
}

/**
 * How long they have been waiting.
 *
 * Age, and only age. There used to be a countdown for the last minute before a
 * five-minute auto-reject — that deadline is gone, so a request that has been
 * sitting a while is a social fact, not an emergency: somebody asked, and
 * nobody has answered yet.
 *
 * It stops counting up at an hour. Past that the number stops being
 * information and starts being an accusation, and the row already says the
 * only thing that matters — this is still waiting.
 */
function waited(row: WaitingRow): { text: string; urgent: boolean } | null {
  if (row.waitingMs === null) return null;

  const mins = Math.floor(row.waitingMs / 60_000);
  if (mins < 1) return { text: 'just now', urgent: false };
  if (mins < 60) return { text: `${mins}m`, urgent: mins >= 10 };
  return { text: 'over an hour', urgent: true };
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
      <h2 className="px-3 pt-1.5 pb-0.5 text-[10px] uppercase tracking-[0.18em] text-text-muted">
        Waiting for you
      </h2>

      <ul
        // Two cards' worth, and the third onwards is reached by scrolling this
        // list rather than by moving the table.
        style={scrolls ? { maxHeight: CARD_H * VISIBLE_CARDS } : undefined}
        className={scrolls ? 'overflow-y-auto overscroll-contain' : undefined}
      >
        {rows.map((row) => {
          const age = waited(row);

          return (
            <li
              key={row.id}
              style={{ height: CARD_H }}
              className="px-3 flex items-center gap-2 border-t border-line/30 first:border-t-0"
            >
              <PlayerAvatar userId={row.userId} name={row.name} photoUrl={row.avatarUrl} size={30} />

              <div className="min-w-0 flex-1">
                {/*
                  The name gets the room, and the figure gets out of its way.
                
                  Both sat on one flex line with the amount shrink-0, so a wide
                  figure ate the name's width and "Rajen Shah" came back as
                  "Raje". The amount is a fixed shape — it is always short and
                  always tabular — so it belongs beside the TAG on the line
                  below, where nothing competes with it, and the name gets the
                  whole width to itself.
                
                  title carries the full name for anyone who still meets the
                  ellipsis on a very narrow screen.
                */}
                <p
                  title={row.name}
                  className="text-[15px] font-semibold text-text truncate leading-tight"
                >
                  {row.name}
                </p>

                <p className="mt-0.5 flex items-baseline gap-2 text-xs text-text-muted leading-tight">
                  {row.amount !== undefined && (
                    <span className="text-[13px] font-semibold text-accent tabular-nums shrink-0">
                      {formatAmount(row.amount)}
                    </span>
                  )}
                  {/* The tag gives way before the age does. "More chips" is
                      guessable from context and the figure beside it; how long
                      somebody has been waiting is the part a host cannot
                      reconstruct, so it never truncates. */}
                  <span className="min-w-0 truncate">{tagOf(row)}</span>
                  {age && (
                    <span
                      className={`shrink-0 tabular-nums ${age.urgent ? 'text-warning' : ''}`}
                    >
                      • {age.text}
                    </span>
                  )}
                </p>
              </div>

              {row.blockedReason ? (
                <p className="max-w-[132px] shrink-0 text-right text-xs text-warning leading-tight">
                  {row.blockedReason}
                </p>
              ) : (
                /* Approve is affirmative and expected, so it leads and carries
                   the material. Dismissing is quieter and never the same
                   weight — a mis-tap there is socially expensive at a real
                   table, and the fix is hierarchy rather than an extra step. */
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={row.pending}
                    onClick={row.onDismiss}
                    className="whitespace-nowrap"
                  >
                    Later
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
            </li>
          );
        })}
      </ul>
    </section>
  );
};
