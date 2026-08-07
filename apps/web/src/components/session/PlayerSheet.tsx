import React, { useState } from 'react';
import { Seat } from '../../lib/night-state';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import { PlayerAvatar } from './PlayerAvatar';

/**
 * Everything you can do with a person, and usually that is one thing.
 *
 * Not a menu. The sheet has one subject and at most one primary action — if it
 * ever needs two primaries, the state model is wrong rather than the sheet.
 *
 * There is deliberately NO "Cash out" control anywhere in here. Cashing out is
 * not something anyone does at a table; standing up is, and the cash-out is the
 * consequence. The app's own vocabulary should match the room's.
 *
 * Every state, and the one thing it offers:
 *
 *   not at the table   Join table
 *   pulling up a chair nothing — they have asked, and are waiting
 *   playing            Buy more chips  (Stand up, quieter)
 *   standing up        Count chips     (admin only; the player waits)
 *   stood up           Join again
 */

export interface PlayerSheetProps {
  open: boolean;
  onClose: () => void;
  name: string;
  userId: string;
  avatarUrl?: string;
  /** Null when this person is not part of the night at all yet. */
  seat: Seat | null;
  isSelf: boolean;
  isAdmin: boolean;
  formatAmount: (n: number) => string;
  /** Bank options, from the club's own configuration. */
  bankOptions: number[];
  /** Stated as a limit, never offered as a button — it drifts upward all night. */
  ceiling: number | null;
  onJoin: (amount: number) => void;
  onBuyMore: (amount: number) => void;
  onStandUp: (amount: number) => void;
  onConfirmCount: () => void;
  busy?: boolean;
}

/** One line, in the vocabulary of the state. Never a figure standing in for a
 *  situation — that is the "Arjun · 0 Chips" defect, restated. */
function situation(seat: Seat | null, amount: (n: number) => string): string {
  if (!seat) return 'Not at the table';
  if (seat.state === 'waitingToSit') {
    return seat.pendingBuyIn !== null
      ? `Pulling up a chair with ${amount(seat.pendingBuyIn)}`
      : 'Pulling up a chair';
  }
  if (seat.state === 'countingOut') return 'Standing up';
  if (seat.state === 'cashedOut') return `Stood up with ${amount(seat.confirmedCashOut ?? 0)}`;
  if (seat.pendingBuyIn !== null) return `Asked for ${amount(seat.pendingBuyIn)} more`;
  if (seat.state === 'seatedNoChips') return 'At the table, no chips yet';
  return 'Playing';
}

export const PlayerSheet: React.FC<PlayerSheetProps> = ({
  open,
  onClose,
  name,
  userId,
  avatarUrl,
  seat,
  isSelf,
  isAdmin,
  formatAmount,
  bankOptions,
  ceiling,
  onJoin,
  onBuyMore,
  onStandUp,
  onConfirmCount,
  busy = false,
}) => {
  const [mode, setMode] = useState<'idle' | 'bank' | 'count'>('idle');
  const [custom, setCustom] = useState('');

  const close = () => {
    setMode('idle');
    setCustom('');
    onClose();
  };

  const state = seat?.state ?? null;
  const mayAct = isSelf || isAdmin;

  return (
    <Sheet open={open} onClose={close} title={name} description={situation(seat, formatAmount)}>
      <div className="flex flex-col items-center gap-4 pb-2">
        <PlayerAvatar
          userId={userId}
          name={name}
          photoUrl={avatarUrl}
          size={64}
          dim={
            state === 'cashedOut' ? 'gone' : state === 'countingOut' ? 'leaving'
              : state === 'waitingToSit' ? 'arriving' : 'here'
          }
        />

        {seat && seat.totalBuyIn > 0 && (
          <p className="text-sm text-text-muted">
            Bought in{' '}
            <span className="text-accent tabular-nums">{formatAmount(seat.totalBuyIn)}</span>
          </p>
        )}

        {/* Choosing a bank — for joining and for topping up. Presets come from
            the club's own minimum and maximum; the ceiling is stated as a limit
            and never offered as a button, because under MATCH_HIGHEST it drifts
            up all night and would end up proposing an absurd default. */}
        {mode === 'bank' && (
          <div className="w-full space-y-2">
            <p className="text-xs text-text-muted text-center">
              {state ? 'How many chips?' : 'Choose your bank'}
            </p>
            <div className="grid grid-cols-3 gap-2">
              {bankOptions.map((n) => (
                <Button
                  key={n}
                  variant="secondary"
                  size="md"
                  disabled={busy || (ceiling !== null && n > ceiling)}
                  onClick={() => (state ? onBuyMore(n) : onJoin(n))}
                >
                  {formatAmount(n)}
                </Button>
              ))}
            </div>
            <input
              inputMode="decimal"
              value={custom}
              onChange={(e) => setCustom(e.target.value.replace(/[^\d]/g, ''))}
              placeholder="Other amount"
              className="w-full min-h-[48px] px-3 rounded-[var(--radius-sm)] bg-bg text-base text-text placeholder:text-text-faint outline-none focus-visible:ring-1 focus-visible:ring-accent"
            />
            {ceiling !== null && (
              <p className="text-xs text-text-faint text-center">
                Table maximum {formatAmount(ceiling)}
              </p>
            )}
            {custom && (
              <Button
                variant="primary"
                size="lg"
                fullWidth
                loading={busy}
                onClick={() => (state ? onBuyMore(Number(custom)) : onJoin(Number(custom)))}
              >
                {state ? 'Buy' : 'Join with'} {formatAmount(Number(custom))}
              </Button>
            )}
          </div>
        )}

        {/* Counting up. Typed and confirmed, never a preset — a buy-in is a
            round number someone chooses, a count is a figure someone reads off
            a stack, and it locks the settlement number. */}
        {mode === 'count' && (
          <div className="w-full space-y-2">
            <p className="text-xs text-text-muted text-center">Count the chips</p>
            <input
              autoFocus
              inputMode="decimal"
              value={custom}
              onChange={(e) => setCustom(e.target.value.replace(/[^\d]/g, ''))}
              placeholder="0"
              className="w-full min-h-[56px] px-3 rounded-[var(--radius-sm)] bg-bg text-center text-2xl tabular-nums text-text placeholder:text-text-faint outline-none focus-visible:ring-1 focus-visible:ring-accent"
            />
            <Button
              variant="primary"
              size="lg"
              fullWidth
              disabled={!custom}
              loading={busy}
              onClick={() => onStandUp(Number(custom))}
            >
              Stand up with {formatAmount(Number(custom) || 0)}
            </Button>
          </div>
        )}

        {mode === 'idle' && mayAct && (
          <div className="w-full space-y-2">
            {/* Not in the night at all. */}
            {!seat && (
              <Button variant="primary" size="lg" fullWidth onClick={() => setMode('bank')}>
                {isSelf ? 'Join table' : `Bring ${name} in`}
              </Button>
            )}

            {/* Asked, and waiting. Nothing to do — the countdown is the content. */}
            {state === 'waitingToSit' && (
              <p className="text-sm text-text-muted text-center leading-relaxed">
                {isSelf ? 'Waiting for the host to approve.' : 'Waiting on your approval above.'}
              </p>
            )}

            {(state === 'inPlay' || state === 'seatedNoChips') && (
              <>
                <Button variant="primary" size="lg" fullWidth onClick={() => setMode('bank')}>
                  Buy more chips
                </Button>
                <Button variant="ghost" size="md" fullWidth onClick={() => setMode('count')}>
                  Stand up
                </Button>
              </>
            )}

            {state === 'countingOut' && isAdmin && (
              <Button variant="primary" size="lg" fullWidth loading={busy} onClick={onConfirmCount}>
                Count chips
              </Button>
            )}
            {state === 'countingOut' && !isAdmin && (
              <p className="text-sm text-text-muted text-center">
                Waiting for the host to check the count.
              </p>
            )}

            {state === 'cashedOut' && (
              <Button variant="primary" size="lg" fullWidth onClick={() => setMode('bank')}>
                Join again
              </Button>
            )}
          </div>
        )}

        {/* Someone else's seat, viewed by a player. The action blocks are
            absent rather than present and greyed. */}
        {mode === 'idle' && !mayAct && seat && (
          <p className="text-sm text-text-muted text-center">Nothing to do here.</p>
        )}
      </div>
    </Sheet>
  );
};
