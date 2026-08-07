import React, { useEffect, useState } from 'react';
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
 *   not at the table   choose a bank — the sheet opens straight into it
 *   pulling up a chair nothing — they have asked, and are waiting
 *   playing            Buy more chips  (Stand up, quieter)
 *   standing up        the count, editable, for an admin to confirm
 *   stood up           Join again
 *
 * The sheet opening IS the "Join table" step. An earlier version made you tap a
 * button called Join table to reach a screen headed Join table; the sheet now
 * opens on the only question that step ever asked.
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
  /** The confirmed figure, which an admin may correct from what was submitted. */
  onConfirmCount: (amount: number) => void;
  /**
   * Skip the menu and open on the bank chooser.
   *
   * Set by the brass stud on the felt, which already means "chips": a seated
   * player who taps it has said what they want, and showing them a sheet with
   * "Buy more chips" on it asks the question twice.
   */
  askForChips?: boolean;
  busy?: boolean;
}

type Mode = 'idle' | 'bank' | 'count';

/** One line, in the vocabulary of the state. Never a figure standing in for a
 *  situation — that is the "Arjun · 0 Chips" defect, restated. */
function situation(seat: Seat | null, amount: (n: number) => string): string {
  if (!seat) return 'Not at the table';
  if (seat.state === 'waitingToSit') {
    return seat.pendingBuyIn !== null
      ? `Pulling up a chair with ${amount(seat.pendingBuyIn)}`
      : 'Pulling up a chair';
  }
  if (seat.state === 'countingOut') return 'Standing up — pending approval';
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
  askForChips = false,
  busy = false,
}) => {
  const state = seat?.state ?? null;

  // Somebody with no seat has exactly one thing to decide, so the sheet opens on
  // it rather than on a button that leads to it.
  const [mode, setMode] = useState<Mode>(() => (seat && !askForChips ? 'idle' : 'bank'));
  const [choice, setChoice] = useState<number | null>(null);
  const [custom, setCustom] = useState('');
  // The count an admin is confirming starts at what the player submitted, so
  // agreeing is one tap and correcting is an edit rather than a re-entry.
  const [count, setCount] = useState('');

  // Keyed on the person, not on the seat: a seat appearing means they just
  // joined, and resetting on that would throw away what they are looking at.
  useEffect(() => {
    setMode(seat && !askForChips ? 'idle' : 'bank');
    setChoice(null);
    setCustom('');
    setCount(seat?.pendingCashOut != null ? String(seat.pendingCashOut) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, askForChips]);

  const close = () => {
    onClose();
  };

  const mayAct = isSelf || isAdmin;
  const overCeiling = (n: number) => ceiling !== null && n > ceiling;

  const chosen = custom ? Number(custom) : choice;
  const chosenValid = chosen !== null && chosen > 0 && !overCeiling(chosen);
  const submitBank = () => {
    if (!chosenValid) return;
    (seat ? onBuyMore : onJoin)(chosen);
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title={name}
      description={situation(seat, formatAmount)}
    >
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

        {/* What they have put in, and how many trips it took. The count is the
            context that makes the total mean something when someone is asking
            for more — "8,000" and "8,000 across 3 buy-ins" are the same money
            and a different evening. */}
        {seat && seat.totalBuyIn > 0 && (
          <p className="text-sm text-text-muted text-center">
            Bought in{' '}
            <span className="text-accent tabular-nums">{formatAmount(seat.totalBuyIn)}</span>
            {seat.buyInCount > 1 && (
              <span className="text-text-faint"> across {seat.buyInCount} buy-ins</span>
            )}
          </p>
        )}

        {/* Choosing a bank — for joining and for topping up. Presets come from
            the club's own configuration; the ceiling is stated as a limit and
            never offered as a button, because under MATCH_HIGHEST it drifts up
            all night and would end up proposing an absurd default.

            Picked then confirmed, rather than tapped to submit. A figure that
            commits money on first touch is the wrong shape for a control held
            one-handed at a table. */}
        {mode === 'bank' && (
          <div className="w-full space-y-2">
            <p className="text-sm text-text text-center">
              {seat ? 'How many chips?' : 'Choose your starting bank'}
            </p>

            <div role="radiogroup" aria-label="Bank amount" className="space-y-2">
              {bankOptions.map((n) => {
                const blocked = overCeiling(n);
                const selected = !custom && choice === n;
                return (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={busy || blocked}
                    onClick={() => {
                      setChoice(n);
                      setCustom('');
                    }}
                    className={`
 w-full min-h-[52px] px-4 flex items-center gap-3 rounded-[var(--radius-sm)]
 border text-left transition-colors duration-[var(--motion-fast)]
 disabled:opacity-40
 ${selected ? 'border-accent bg-accent/10' : 'border-line bg-bg'}
 `}
                  >
                    <span
                      aria-hidden="true"
                      className={`w-4 h-4 rounded-full border-2 shrink-0 ${
                        selected ? 'border-accent bg-accent' : 'border-line-strong'
                      }`}
                    />
                    <span className="text-base text-text tabular-nums">{formatAmount(n)}</span>
                    {blocked && (
                      <span className="ml-auto text-xs text-text-faint">over the limit</span>
                    )}
                  </button>
                );
              })}
            </div>

            <input
              inputMode="decimal"
              value={custom}
              onChange={(e) => {
                setCustom(e.target.value.replace(/[^\d]/g, ''));
                setChoice(null);
              }}
              placeholder="Other amount"
              className="w-full min-h-[48px] px-3 rounded-[var(--radius-sm)] bg-bg text-base text-text placeholder:text-text-faint outline-none focus-visible:ring-1 focus-visible:ring-accent"
            />

            {ceiling !== null && (
              <p className="text-xs text-text-faint text-center">
                Table maximum {formatAmount(ceiling)}
              </p>
            )}

            <Button
              variant="primary"
              size="lg"
              fullWidth
              disabled={!chosenValid}
              loading={busy}
              onClick={submitBank}
            >
              Continue
            </Button>
          </div>
        )}

        {/* Counting up. Typed and confirmed, never a preset — a buy-in is a
            round number someone chooses, a count is a figure someone reads off
            a stack, and it locks the settlement number. */}
        {mode === 'count' && (
          <div className="w-full space-y-2">
            <p className="text-sm text-text text-center">Count your chips</p>
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
              Submit cash out
            </Button>
          </div>
        )}

        {mode === 'idle' && mayAct && (
          <div className="w-full space-y-2">
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
                <Button
                  variant="ghost"
                  size="md"
                  fullWidth
                  onClick={() => {
                    setCustom('');
                    setMode('count');
                  }}
                >
                  Stand up
                </Button>
              </>
            )}

            {/* The count is the one figure in the night read off a physical
                stack rather than chosen, so it is the one that is routinely
                wrong. The admin confirming it is looking at the same chips —
                correcting it here beats rejecting and asking for a re-count. */}
            {state === 'countingOut' && isAdmin && (
              <>
                <p className="text-sm text-text text-center">Counted chips</p>
                <input
                  inputMode="decimal"
                  aria-label="Counted chips"
                  value={count}
                  onChange={(e) => setCount(e.target.value.replace(/[^\d]/g, ''))}
                  className="w-full min-h-[56px] px-3 rounded-[var(--radius-sm)] bg-bg text-center text-2xl tabular-nums text-text outline-none focus-visible:ring-1 focus-visible:ring-accent"
                />
                <Button
                  variant="primary"
                  size="lg"
                  fullWidth
                  disabled={!count}
                  loading={busy}
                  onClick={() => onConfirmCount(Number(count))}
                >
                  Approve cash out
                </Button>
              </>
            )}
            {state === 'countingOut' && !isAdmin && (
              <p className="text-sm text-text-muted text-center">
                Waiting for the host to confirm the count.
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
