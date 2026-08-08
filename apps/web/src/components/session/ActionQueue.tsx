import React from 'react';
import { Check, X, LogIn, LogOut, Coins } from 'lucide-react';
import { Button } from '../ui/Button';

/**
 * Everything waiting on the admin, at the top of the session screen.
 *
 * This is the whole point of the Admin-first layout. Approving a buy-in happens
 * five to fifteen times a night, mid-conversation, while someone stands there
 * waiting — and it used to take about seven seconds and a scroll, because the
 * request sat below a decorative table graphic occupying roughly 40% of the
 * first viewport. The app already knew the request was urgent; the screen just
 * did not say so.
 *
 * Three rules from PRODUCT-PRINCIPLES.md are load-bearing here:
 *
 *   lead with what needs a decision — if something is waiting, it is the screen
 *   read top, act bottom — the request reads at the top of its card, the
 *     buttons sit at the bottom of it, so the hand never follows the eye upward
 *   pending state never masquerades as settled state — a waiting player is
 *     described as "waiting", never as a chip count
 *
 * Deliberately renders nothing when the queue is empty. A permanent "0 pending"
 * header would push the table down for no reason and train the eye to skip the
 * one region that must never be skipped.
 */

export type QueueKind = 'buy-in' | 'sit-in' | 'cash-out';

export interface QueueItem {
  id: string;
  kind: QueueKind;
  playerName: string;
  /** Chips, for buy-ins and cash-outs. Sit-ins have no amount. */
  amount?: number;
  /** ISO timestamp. Rendered relative — a clock time is not glanceable. */
  requestedAt?: string;
  /** Blocks approval with a reason, e.g. an admin's own buy-in. */
  blockedReason?: string;
  onApprove: () => void;
  onReject: () => void;
  pending?: boolean;
}

const KIND: Record<QueueKind, { icon: React.ElementType; verb: string; approve: string }> = {
  'buy-in': { icon: Coins, verb: 'wants chips', approve: 'Approve' },
  'sit-in': { icon: LogIn, verb: 'wants to sit in', approve: 'Seat' },
  'cash-out': { icon: LogOut, verb: 'is cashing out', approve: 'Confirm' },
};

/** "just now" / "4 min" — a glance answers "how long have they been waiting?" */
function waitedFor(iso?: string): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export const ActionQueue: React.FC<{
  items: QueueItem[];
  formatAmount: (n: number) => string;
}> = ({ items, formatAmount }) => {
  if (items.length === 0) return null;

  return (
    <section
      // Announced when it changes: an admin looking at the table should be told
      // a request arrived, not have to notice it.
      aria-live="polite"
      aria-label={`${items.length} action${items.length === 1 ? '' : 's'} waiting on you`}
      className="bg-surface border border-warning/40 rounded-3xl overflow-hidden shadow-xl"
    >
      <header className="flex items-center gap-2.5 px-5 py-3.5 bg-warning/10 border-b border-warning/25">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full rounded-full bg-warning opacity-60 animate-ping" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-warning" />
        </span>
        <h2 className="text-sm font-medium text-text">
          {items.length} {items.length === 1 ? 'action needs' : 'actions need'} you
        </h2>
      </header>

      <ul className="divide-y divide-line">
        {items.map((item) => {
          const { icon: Icon, verb, approve } = KIND[item.kind];
          const waited = waitedFor(item.requestedAt);

          return (
            <li key={item.id} className="p-4 space-y-3">
              <div className="flex items-start gap-3">
                <Icon className="w-4 h-4 text-warning mt-0.5 shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  {/*
                    The sentence is the information: "Arjun wants chips · 3,000".
                    The previous screen showed this player at the table as
                    "Arjun · 0 Chips", which is true and useless — settled-state
                    vocabulary describing an unsettled situation.
                  */}
                  <p className="text-base text-text leading-snug">
                    <span className="font-semibold">{item.playerName}</span>{' '}
                    <span className="text-text-muted">{verb}</span>
                    {item.amount !== undefined && (
                      <>
                        {' · '}
                        <span className="font-semibold tabular-nums">{formatAmount(item.amount)}</span>
                      </>
                    )}
                  </p>
                  {waited && <p className="text-xs text-text-muted mt-0.5">waiting {waited}</p>}
                  {item.blockedReason && (
                    <p className="text-xs text-warning mt-1.5 leading-relaxed">{item.blockedReason}</p>
                  )}
                </div>
              </div>

              {/* Actions at the bottom of the card, in the thumb's path. */}
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  size="md"
                  fullWidth
                  loading={item.pending}
                  disabled={!!item.blockedReason}
                  onClick={item.onApprove}
                >
                  <Check className="w-4 h-4" aria-hidden="true" />
                  {approve}
                </Button>
                <Button
                  variant="secondary"
                  size="md"
                  fullWidth
                  disabled={item.pending}
                  onClick={item.onReject}
                >
                  <X className="w-4 h-4" aria-hidden="true" />
                  Reject
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
