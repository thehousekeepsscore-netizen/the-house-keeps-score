import React from 'react';
import { FeedEvent } from '../../lib/night-feed';
import { HistoryEntry, clockTime, dayLabel, historyEntry } from '../../lib/night-history';

/**
 * The night as a ledger, newest first.
 *
 * The felt tells the story; this answers the argument. Every entry carries the
 * time it happened, what it was, how much, and every hand that touched it —
 * because the questions this screen exists for are "when did that go in" and
 * "who approved that", and neither is answerable from a story.
 *
 * Timestamps are on the left in a fixed column so the eye can run down them
 * without reading the lines, which is how anyone actually uses a timeline. They
 * are rendered in the reader's own zone: a table is one room, but the people at
 * it are increasingly not, and 20:11 means nothing if it is somebody else's.
 *
 * A step with no time renders without one rather than borrowing the entry's.
 * Rows decided before approval times were recorded genuinely do not have one,
 * and inventing it would put a number in an audit trail that nobody can vouch
 * for — see the migration note.
 */

const TONE: Record<NonNullable<HistoryEntry['steps'][number]['tone']>, string> = {
  normal: 'text-text-muted',
  muted: 'text-text-faint',
  warning: 'text-warning',
};

export const NightHistory: React.FC<{
  events: FeedEvent[];
  nameOf: (userId: string) => string;
  formatAmount: (n: number) => string;
  /** Admin-only affordances hang off this; players get a read-only ledger. */
  isAdmin?: boolean;
  onEdit?: (event: FeedEvent) => void;
  onDelete?: (event: FeedEvent) => void;
}> = ({ events, nameOf, formatAmount, isAdmin, onEdit, onDelete }) => {
  if (events.length === 0) {
    return (
      <p className="px-5 py-10 text-center text-sm text-text-muted">
        Nothing has happened yet tonight.
      </p>
    );
  }

  const entries = events.map((e) => ({ event: e, entry: historyEntry(e, nameOf, formatAmount) }));
  let lastDay = '';

  return (
    <ol className="pb-2">
      {entries.map(({ event, entry }) => {
        const day = dayLabel(entry.at);
        // A night that runs past midnight is one night. The date appears only
        // where it changes, so it reads as a seam rather than a column.
        const newDay = day !== lastDay;
        lastDay = day;

        return (
          <li key={entry.id}>
            {newDay && (
              <div className="flex items-center gap-3 px-5 pt-4 pb-1.5">
                <span className="h-px flex-1 bg-line" />
                <span className="text-[10px] uppercase tracking-[0.18em] text-text-faint">{day}</span>
                <span className="h-px flex-1 bg-line" />
              </div>
            )}

            <div className="flex gap-3 px-5 py-3 border-b border-line/60">
              <time
                dateTime={entry.at}
                className="shrink-0 w-11 pt-0.5 text-xs font-mono tabular-nums text-text-faint"
              >
                {clockTime(entry.at)}
              </time>

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm text-text min-w-0">{entry.title}</span>
                  {entry.amount !== undefined && (
                    <span
                      className={`ml-auto shrink-0 text-sm font-semibold tabular-nums ${
                        entry.withdrawn ? 'text-text-faint line-through' : 'text-text'
                      }`}
                    >
                      {formatAmount(entry.amount)}
                    </span>
                  )}
                </div>

                {entry.steps.map((step, i) => (
                  <div key={i} className="mt-1 flex items-baseline gap-2 text-xs">
                    <span className={TONE[step.tone ?? 'normal']}>{step.label}</span>
                    {step.at && (
                      <time
                        dateTime={step.at}
                        className="ml-auto shrink-0 font-mono tabular-nums text-text-faint"
                      >
                        {clockTime(step.at)}
                      </time>
                    )}
                  </div>
                ))}

                {/* Corrections go through the same approval workflow as the
                    original — see requestEntryChange on the server. Offered
                    only where there is something to correct: the clock running
                    out is not an entry anybody can edit. */}
                {isAdmin && isMoney(event) && !event.deletedAt && (
                  <div className="mt-2 flex gap-3">
                    {onEdit && (
                      <button
                        type="button"
                        onClick={() => onEdit(event)}
                        className="text-xs text-accent hover:underline cursor-pointer"
                      >
                        Correct
                      </button>
                    )}
                    {onDelete && (
                      <button
                        type="button"
                        onClick={() => onDelete(event)}
                        className="text-xs text-text-muted hover:text-warning cursor-pointer"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
};

/** Only entries that moved chips can be corrected or withdrawn. */
function isMoney(e: FeedEvent): boolean {
  return e.kind === 'bought-in' || e.kind === 'topped-up';
}
