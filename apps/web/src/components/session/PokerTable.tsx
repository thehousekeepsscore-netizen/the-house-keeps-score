import React from 'react';
import { Night, Seat } from '../../lib/night-state';
import { PlayerAvatar } from './PlayerAvatar';
import { seatCaption, seatSentence } from '../../lib/seat-vocabulary';

/**
 * The felt.
 *
 * It is present for the whole of an active session and never disappears. It
 * does not summarise the night — it *is* the night, and it changes as the night
 * does: full strength while people play, one seat asking for attention when
 * someone is waiting, seats fading to past tense as people are counted out.
 *
 * Two rules it must not break, and they are the same rule:
 *
 *   A seat never moves because someone else left. Order is fixed for the night
 *   by arrival (see night-state.ts) and cashed-out players keep their chair, so
 *   the ring never reflows — including during the ten minutes when everyone is
 *   leaving at once, which is exactly when a moving control would be worst.
 *
 *   Players never overlap. Spacing is computed from the seat count and each
 *   seat's box is clamped to it, so non-overlap is a property of the geometry
 *   rather than something that happens to hold at the counts we tried.
 *
 * The viewer always sits bottom-centre. That is a frame of reference, not a
 * claim about the room — the felt carries no seat numbers and never says
 * "seat 3", so there is nothing to misread as physical position.
 */

export interface PokerTableProps {
  night: Night;
  currentUserId: string;
  users: Record<string, { displayName?: string; avatarUrl?: string } | undefined>;
  onSelectPlayer: (userId: string) => void;
  formatAmount: (n: number) => string;
}

/**
 * Seat radii, and how much of a seat there is room to draw.
 *
 * Seats sit ON the rim, the way people sit at a table, so the felt is very
 * slightly smaller than the ring. Sizing the felt independently of the seats
 * was the first version and it looked like three people standing near a table
 * rather than around one.
 *
 * rx is bounded by the 320px container; ry is free below nine because the
 * ellipse is what makes a small game feel intimate. At nine and above it
 * becomes a circle, because equal angles map to the shortest arc at the
 * major-axis ends — which is exactly where labels collided.
 */
function radii(count: number) {
  if (count <= 2) return { rx: 0, ry: 76, feltRx: 74, feltRy: 68 };
  if (count <= 4) return { rx: 92, ry: 82, feltRx: 90, feltRy: 74 };
  if (count <= 6) return { rx: 108, ry: 86, feltRx: 106, feltRy: 78 };
  if (count <= 9) return { rx: 112, ry: 112, feltRx: 106, feltRy: 106 };
  return { rx: 120, ry: 120, feltRx: 112, feltRy: 112 };
}

/**
 * How much a seat says, by how much room it has.
 *
 * A physical table seats ten or eleven, but nothing in the data stops a club
 * running more, so the ring must not have a cliff at nine. Rather than a fixed
 * size per tier, the avatar is derived from the arc between neighbours — so
 * adding a player shrinks the table instead of overlapping it, at any count.
 *
 *   full     name and what they are doing
 *   name     name only; the caption moves into the sheet behind the seat
 *   avatar   the face alone — at this density a label is unreadable anyway
 */
type Detail = 'full' | 'name' | 'avatar';

const LABEL_HEIGHT: Record<Detail, number> = { full: 31, name: 18, avatar: 0 };

function seatMetrics(count: number, rx: number, ry: number) {
  const spacing = count > 1 ? (2 * Math.PI * Math.min(rx || ry, ry)) / count : 200;
  const detail: Detail = count <= 9 ? 'full' : count <= 14 ? 'name' : 'avatar';
  const labelHeight = LABEL_HEIGHT[detail];

  // The floor is 24px. Below roughly twenty-five players a 320px ring cannot
  // hold another face without them touching, and no arrangement of one ring
  // can — that is a property of the phone, not of the layout. It degrades
  // rather than breaking, and a table that large is far past a real one.
  const cap = count <= 4 ? 56 : count <= 6 ? 48 : 40;
  const size = Math.round(Math.max(24, Math.min(cap, spacing - labelHeight - 6)));

  return { spacing, detail, size, boxHeight: size + labelHeight };
}

/** Seat i, clockwise from bottom-centre where the viewer sits. */
function position(i: number, count: number, rx: number, ry: number) {
  const angle = Math.PI / 2 + (i * 2 * Math.PI) / count;
  return { x: Math.cos(angle) * rx, y: Math.sin(angle) * ry };
}

/**
 * Ring treatment per state — always paired with a word, never colour alone.
 * A dim room at an angle is the situation this app is used in.
 */
const RING: Record<Seat['state'], string> = {
  inPlay: 'border-2 border-solid border-line-strong',
  seatedNoChips: 'border-2 border-dashed border-line',
  waitingToSit: 'border-2 border-dashed border-warning',
  countingOut: 'border-2 border-solid border-warning',
  cashedOut: 'border-2 border-solid border-line/60',
};

export const PokerTable: React.FC<PokerTableProps> = ({
  night,
  currentUserId,
  users,
  onSelectPlayer,
  formatAmount,
}) => {
  const seats = night.seats;
  const count = Math.max(seats.length, 1);

  // The viewer sits at the bottom; everyone else keeps their arrival order
  // relative to them. Rotating the array rather than re-sorting it means the
  // ring is stable even though the starting point is personal.
  const mineAt = seats.findIndex((s) => s.userId === currentUserId);
  const ordered = mineAt > 0 ? [...seats.slice(mineAt), ...seats.slice(0, mineAt)] : seats;

  const { rx, ry, feltRx, feltRy } = radii(count);
  const { spacing, detail, size, boxHeight } = seatMetrics(count, rx, ry);

  // Non-overlap by construction, in BOTH axes.
  //
  // The first version clamped width only, which is the axis that looks like the
  // problem. It is not: near the left and right extremes of the ellipse the arc
  // runs vertically, so at nine players a seat's caption landed under its
  // neighbour's chip while the boxes were comfortably narrow.
  const boxWidth = Math.max(size, Math.min(96, spacing - 6));

  return (
    <div
      className="relative mx-auto"
      style={{ width: 320, height: 2 * ry + size + 34 }}
      role="group"
      aria-label={`${seats.length} at the table`}
    >
      {/* The felt. Money in the middle, where the space is empty anyway — the
          one figure on this screen that costs no vertical room. */}
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[50%] bg-surface-alt border border-line flex flex-col items-center justify-center transition-[filter] duration-200"
        style={{
          width: 2 * feltRx,
          height: 2 * feltRy,
          filter: night.phase === 'windingDown' ? 'saturate(0.6)' : undefined,
        }}
      >
        <span className="text-[10px] uppercase tracking-widest text-text-muted">In play</span>
        <span className="text-lg font-bold text-text tabular-nums">
          {formatAmount(night.chipsInPlay)}
        </span>
      </div>

      {ordered.map((seat, i) => {
        const { x, y } = position(i, count, rx, ry);
        const realName = users[seat.userId]?.displayName || 'Player';
        const name = seat.userId === currentUserId ? 'You' : realName;
        const dim =
          seat.state === 'cashedOut' ? 'gone' : seat.state === 'countingOut' ? 'leaving' : 'here';

        return (
          <button
            key={seat.userId}
            type="button"
            onClick={() => onSelectPlayer(seat.userId)}
            aria-label={`${name}, ${seatSentence(seat, formatAmount)}`}
            // No -translate-* utilities here: in Tailwind v4 they compile to the
            // `translate` property, which composes on top of `transform` rather
            // than replacing it — so a seat would be shifted half its own box
            // twice and the whole ring would sit up and to the left of the felt.
            // The centring is done inside the inline transform instead.
            className="absolute left-1/2 top-1/2 flex flex-col items-center gap-1 rounded-2xl active:opacity-70 transition-opacity duration-[120ms]"
            style={{
              transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`,
              width: boxWidth,
              // The circle shrinks at nine players; the target never goes below
              // the 44px minimum, so it extends past the avatar instead.
              minHeight: Math.max(44, boxHeight),
            }}
          >
            <span
              className={`rounded-full ${RING[seat.state]} ${
                seat.state === 'waitingToSit' || seat.pendingBuyIn !== null
                  ? 'animate-[seat-wait_2s_ease-in-out_infinite]'
                  : ''
              }`}
            >
              <PlayerAvatar
                userId={seat.userId}
                name={realName}
                photoUrl={users[seat.userId]?.avatarUrl}
                size={size}
                dim={dim}
              />
            </span>
            {detail !== 'avatar' && (
              <span className="w-full text-center leading-tight">
                <span
                  className={`block text-[11px] truncate ${dim === 'gone' ? 'text-text-muted' : 'text-text'}`}
                >
                  {name}
                </span>
                {detail === 'full' && (
                  <span className="block text-[10px] text-text-muted truncate tabular-nums">
                    {seatCaption(seat, formatAmount)}
                  </span>
                )}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
