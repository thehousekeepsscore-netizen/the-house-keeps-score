import React, { useEffect, useState } from 'react';
import { Seat } from '../../lib/night-state';
import { agoLabel } from '../../lib/night-feed';
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
 *   playing            Add to bank  (Stand up, quieter)
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
   * Sitting back down after standing up, with the same chips.
   *
   * Not a buy-in. They already own those chips — they carry them back to the
   * felt, so no new money enters the night and nothing is added to what they
   * have put in. Buying MORE is an ordinary top-up once they are seated again.
   */
  onSitBackDown: () => void;
  /**
   * Skip the menu and open on the bank chooser.
   *
   * Set by the brass stud on the felt, which already means "chips": a seated
   * player who taps it has said what they want, and showing them a sheet with
   * "Add to bank" on it asks the question twice.
   */
  askForChips?: boolean;
  busy?: boolean;
  /**
   * This player's approved banks, newest last, for the correction path.
   *
   * Passed as rows rather than a total because a void acts on ONE approved
   * buy-in — "which 5,000" is the question, and a total cannot answer it.
   * Empty or omitted hides the correction entirely.
   */
  banks?: { id: string; amount: number; at: string }[];
  /**
   * Take back an approved bank. Absent when the caller cannot offer it — a
   * player, or a night that has already been frozen for settling.
   */
  onVoidBank?: (requestId: string, reason?: string) => void;
}

type Mode = 'idle' | 'bank' | 'count' | 'void';

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
  onSitBackDown,
  askForChips = false,
  busy = false,
  banks = [],
  onVoidBank,
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
  /** Which approved bank is being taken back, and why. */
  const [voidId, setVoidId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  /* One instant for the whole list, so two banks a second apart cannot be
     labelled against two different "now"s in the same render. */
  const [nowMs] = useState(() => Date.now());

  // Keyed on the person, not on the seat: a seat appearing means they just
  // joined, and resetting on that would throw away what they are looking at.
  useEffect(() => {
    setMode(seat && !askForChips ? 'idle' : 'bank');
    setChoice(null);
    setCustom('');
    setCount(seat?.pendingCashOut != null ? String(seat.pendingCashOut) : '');
    setVoidId(null);
    setVoidReason('');
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
            {/* "How much?" rather than "How many chips?" — the same two-word
                shape OpenTableSheet uses above its own chooser, and it stops
                reintroducing a second noun for the money one line above a
                radiogroup already labelled "Bank amount". */}
            <p className="text-sm text-text text-center">
              {seat ? 'How much?' : 'Choose your starting bank'}
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

            {/*
              The button states the figure, because this one commits money.
              "Continue" promised a next step and there is none — the tap posts
              the request. Every other commit in the night already names its
              amount ("Sit back down with 7,200"), and this was the one that did
              not.

              Pick-then-confirm is unchanged: the figure moved onto the button,
              the second tap did not go away.

              `chosen` rather than `choice`, so a typed amount does not label the
              button with the preset tapped before it — same value submitBank
              sends, so the label and the payload cannot drift. The null check is
              for the type: `chosenValid` cannot narrow it.
            */}
            <Button
              variant="primary"
              size="lg"
              fullWidth
              disabled={!chosenValid}
              loading={busy}
              onClick={submitBank}
            >
              {chosen !== null && chosen > 0 ? `Request ${formatAmount(chosen)}` : 'Request'}
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

        {/*
            Taking a bank back.

            Two steps on purpose. Step one picks WHICH bank, because a player
            with three approved buy-ins has three different 5,000s and only one
            of them is the mistake. Step two states the consequence in full and
            asks again — this removes money from a live night, and a single tap
            is the wrong weight for that.

            The word is "voided" everywhere, never "edited" or "changed": the
            original request keeps its amount, and the feed will say so.
        */}
        {mode === 'void' && isAdmin && onVoidBank && (
          <div className="w-full space-y-3">
            {voidId === null ? (
              <>
                <p className="text-sm text-text-muted text-center leading-relaxed">
                  Which bank was wrong? The whole bank is taken back — it is not
                  changed to a different amount.
                </p>
                {banks.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => setVoidId(b.id)}
                    className="w-full min-h-[56px] px-4 rounded-[var(--radius-sm)] bg-bg flex items-center justify-between gap-3 cursor-pointer hover:bg-surface-alt transition-colors"
                  >
                    <span className="text-lg tabular-nums text-text">{formatAmount(b.amount)}</span>
                    <span className="text-xs text-text-faint">{agoLabel(b.at, nowMs)}</span>
                  </button>
                ))}
                <Button variant="ghost" size="md" fullWidth onClick={() => setMode('idle')}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm text-text text-center leading-relaxed">
                  Void{' '}
                  <span className="text-accent tabular-nums">
                    {formatAmount(banks.find((b) => b.id === voidId)?.amount ?? 0)}
                  </span>{' '}
                  from {name}&apos;s bank?
                </p>
                <p className="text-xs text-text-muted text-center leading-relaxed">
                  These chips stop counting toward their total and toward the table
                  maximum. The original buy-in is kept on record as voided. If they
                  should have had a different amount, add it as a new bank afterwards.
                </p>
                <input
                  aria-label="Reason (optional)"
                  placeholder="Reason (optional)"
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  maxLength={200}
                  className="w-full min-h-[48px] px-3 rounded-[var(--radius-sm)] bg-bg text-base text-text outline-none focus-visible:ring-1 focus-visible:ring-accent"
                />
                <Button
                  variant="danger"
                  size="lg"
                  fullWidth
                  loading={busy}
                  onClick={() => onVoidBank(voidId, voidReason.trim() || undefined)}
                >
                  Void this bank
                </Button>
                <Button variant="ghost" size="md" fullWidth onClick={() => setVoidId(null)}>
                  Back
                </Button>
              </>
            )}
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
                  Add to bank
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

            {/*
                The correction path, deliberately last and deliberately quiet.

                Approving a bank is one-way, so a host who approved 5,000
                instead of 2,000 previously had nothing to press and the chips
                counted all night.

                The word is "void", not "correct" and not "edit", and it is the
                word from the very first tap. "Correct a bank" reads like it
                leads to a field you can retype; this leads to taking the whole
                approved bank back while the original stays on record. Naming
                that up front is the difference between an audit trail and a
                rewrite. If they should have had 2,000, that is a new bank
                afterwards — which is why this sits below "Add to bank" rather
                than replacing it.
            */}
            {isAdmin && onVoidBank && banks.length > 0 && (state === 'inPlay' || state === 'seatedNoChips') && (
              <Button variant="ghost" size="md" fullWidth onClick={() => setMode('void')}>
                Void bank
              </Button>
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

            {/*
              Back to the table with the chips they left with — never fewer.
              A player who stands up with 7,200 and sits back down with 1,000
              has taken 6,200 out of the night while everyone else's money is
              still on the felt; poker calls that going south.

              It is deliberately not a buy-in. Those chips are already theirs
              and already counted, so treating the return as new money would
              add 7,200 to what they have put in and settle them 7,200 down.
              More chips than that is an ordinary top-up, once they are sitting.
            */}
            {/*
              An admin looking at somebody else says so. The button used to read
              "Sit back down with 7,200" whoever was holding the phone, which
              described the wrong person's evening and — until the id was
              actually sent — did the wrong person's action.

              It asks rather than does, and says so, because it is the same
              request the player would make: it joins the queue and an admin
              approves it there. Promising a seat here would be a second lie
              about the same button.
            */}
            {state === 'cashedOut' && (
              <>
                <Button variant="primary" size="lg" fullWidth loading={busy} onClick={onSitBackDown}>
                  {isSelf
                    ? `Sit back down with ${formatAmount(seat?.confirmedCashOut ?? 0)}`
                    : `Ask for ${name} to sit back down with ${formatAmount(seat?.confirmedCashOut ?? 0)}`}
                </Button>
                <p className="text-xs text-text-faint text-center leading-relaxed">
                  {isSelf
                    ? "You take your chips back to the table. Buy more once you're sitting."
                    : `${name} takes those chips back to the table. Approve it in the queue to seat them.`}
                </p>
              </>
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
