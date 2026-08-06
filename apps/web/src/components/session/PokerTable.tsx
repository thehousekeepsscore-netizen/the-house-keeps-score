import React from 'react';
import { Night, Seat } from '../../lib/night-state';
import { PlayerAvatar } from './PlayerAvatar';
import { seatCaption, seatSentence } from '../../lib/seat-vocabulary';

/**
 * The felt.
 *
 * Present for the whole of an active session and never disappearing. It does
 * not summarise the night — it *is* the night, and it changes as the night
 * does: full strength while people play, one seat asking when someone is
 * waiting, seats fading to past tense as people are counted out.
 *
 * Three rules it must not break:
 *
 *   A seat never moves because someone else left. Order is fixed for the night
 *   by arrival (night-state.ts) and cashed-out players keep their chair, so the
 *   ring never reflows — including during the ten minutes when everyone leaves
 *   at once, which is when a moving control is worst (PRODUCT-BRIEF §2.5).
 *
 *   Players never overlap, at any count. Seat size is derived from the space
 *   between neighbours, so adding a player shrinks the table rather than
 *   colliding it.
 *
 *   Nothing on it is decoration that looks like data. Every mark a seat carries
 *   is bound to a state the app actually knows.
 *
 * The viewer always sits bottom-centre. A frame of reference, not a claim about
 * the room — there are no seat numbers, so there is nothing to misread as
 * physical position.
 */

export interface PokerTableProps {
  night: Night;
  currentUserId: string;
  users: Record<string, { displayName?: string; avatarUrl?: string } | undefined>;
  onSelectPlayer: (userId: string) => void;
  /** The club's own formatter — respects the chips/₹ toggle and devaluation. */
  formatAmount: (n: number) => string;
}

/**
 * A racetrack, not an ellipse.
 *
 * A real poker table is a stadium: two straight edges with a round cap at each
 * end, and it is shaped that way because it seats people evenly. An ellipse
 * bunches them at the ends — which is why nine players on one needed a circle
 * to stop labels colliding, and why a circle then wasted the width of the phone.
 *
 * `w` is half the straight run, `r` the cap radius. Both are bounded so that
 * w + r + half an avatar stays inside the 320px container.
 */
function felt(count: number) {
  if (count <= 2) return { w: 38, r: 64 };
  if (count <= 4) return { w: 46, r: 62 };
  if (count <= 6) return { w: 54, r: 62 };
  if (count <= 9) return { w: 64, r: 62 };
  return { w: 72, r: 58 };
}

/** Perimeter of the stadium: two straight runs plus one full circle of caps. */
const perimeter = (w: number, r: number) => 4 * w + 2 * Math.PI * r;

/**
 * Seat i, walked by ARC LENGTH from bottom-centre — so the gap between any two
 * neighbours is identical wherever they sit. Walking by angle instead would put
 * three players comfortably along the top and crush four into each cap.
 */
function position(i: number, count: number, w: number, r: number) {
  const p = perimeter(w, r);
  let t = (i * p) / count;

  // 1. bottom edge, centre → right
  if (t < w) return { x: t, y: r };
  t -= w;
  // 2. right cap, bottom → top
  if (t < Math.PI * r) {
    const a = Math.PI / 2 - t / r;
    return { x: w + r * Math.cos(a), y: r * Math.sin(a) };
  }
  t -= Math.PI * r;
  // 3. top edge, right → left
  if (t < 2 * w) return { x: w - t, y: -r };
  t -= 2 * w;
  // 4. left cap, top → bottom
  if (t < Math.PI * r) {
    const a = -Math.PI / 2 - t / r;
    return { x: -w + r * Math.cos(a), y: r * Math.sin(a) };
  }
  t -= Math.PI * r;
  // 5. bottom edge, left → centre
  return { x: -w + t, y: r };
}

/**
 * How much a seat says, by how much room it has.
 *
 * A physical table seats ten or eleven, but nothing in the data caps a club
 * there, so the ring must not have a cliff. Size comes from the gap between
 * neighbours rather than from a fixed tier.
 */
type Detail = 'full' | 'name' | 'avatar';
const LABEL_HEIGHT: Record<Detail, number> = { full: 32, name: 18, avatar: 0 };

function seatMetrics(count: number, w: number, r: number) {
  const spacing = count > 1 ? perimeter(w, r) / count : 200;
  const detail: Detail = count <= 9 ? 'full' : count <= 14 ? 'name' : 'avatar';
  const labelHeight = LABEL_HEIGHT[detail];
  const cap = count <= 4 ? 56 : count <= 6 ? 50 : 44;

  // Floor of 24px. Past roughly thirty players a 320px table cannot hold
  // another face without them touching — a property of the phone, not of the
  // layout. It degrades rather than breaking, and is far past a real table.
  const size = Math.round(Math.max(24, Math.min(cap, spacing - labelHeight - 6)));
  return { spacing, detail, size, boxHeight: size + labelHeight };
}

/**
 * The one mark that carries seat state, and it is bound to something real.
 *
 * The gold rim is brand and belongs to every seat; the dot is the state. A dot
 * that meant "online" would be decoration dressed as data — this app has no
 * per-player presence in an offline session, so a green dot on everyone would
 * be asserting something it cannot know.
 *
 * Never colour alone: each dot is paired with the caption underneath, and with
 * the seat's accessible name.
 */
const DOT: Record<Seat['state'], string> = {
  inPlay: 'bg-success',
  seatedNoChips: 'bg-line-strong',
  waitingToSit: 'bg-warning',
  countingOut: 'bg-warning',
  cashedOut: 'bg-line-strong',
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
  // relative to them. Rotating rather than re-sorting keeps the ring stable
  // even though the starting point is personal.
  const mineAt = seats.findIndex((s) => s.userId === currentUserId);
  const ordered = mineAt > 0 ? [...seats.slice(mineAt), ...seats.slice(0, mineAt)] : seats;

  const { w, r } = felt(count);
  const { spacing, detail, size, boxHeight } = seatMetrics(count, w, r);
  const boxWidth = Math.max(size, Math.min(96, spacing - 6));
  const quiet = night.phase === 'windingDown';

  return (
    <div
      className="relative mx-auto"
      style={{ width: 320, height: 2 * r + boxHeight + 16 }}
      role="group"
      aria-label={`${seats.length} at the table`}
    >
      {/* Rail — the dark band a real table has around its felt. Seats sit ON
          it, which is what makes them look seated rather than nearby. */}
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          width: 2 * (w + r),
          height: 2 * r,
          background: 'linear-gradient(160deg, #2a2318, #14100a 60%, #0d0b07)',
          boxShadow: '0 10px 30px rgba(0,0,0,0.45), inset 0 1px 0 rgba(212,175,55,0.10)',
        }}
      />

      {/* Felt. A radial lift in the middle so it reads as a surface under a
          light rather than a flat shape, and a gold hairline at the rail. */}
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full flex flex-col items-center justify-center transition-[filter] duration-200"
        style={{
          width: 2 * (w + r) - 22,
          height: 2 * r - 22,
          background:
            'radial-gradient(ellipse at 50% 42%, #1b5138 0%, #123a27 55%, #0d2a1c 100%)',
          border: '1px solid rgba(212,175,55,0.45)',
          boxShadow: 'inset 0 8px 24px rgba(0,0,0,0.45)',
          filter: quiet ? 'saturate(0.55) brightness(0.92)' : undefined,
        }}
      >
        <span className="text-[10px] uppercase tracking-[0.18em] text-white/45">In play</span>
        <span className="text-xl font-bold text-white tabular-nums leading-tight">
          {formatAmount(night.chipsInPlay)}
        </span>
      </div>

      {ordered.map((seat, i) => {
        const { x, y } = position(i, count, w, r);
        // Seats on the top run put their label ABOVE the avatar, so it reads
        // against the page rather than across the lit centre of the felt.
        // Everywhere else the outward direction is already downward or
        // sideways, and below is correct.
        const labelAbove = y < -r * 0.7;
        const realName = users[seat.userId]?.displayName || 'Player';
        const isMe = seat.userId === currentUserId;
        const name = isMe ? 'You' : realName;
        const dim =
          seat.state === 'cashedOut' ? 'gone' : seat.state === 'countingOut' ? 'leaving' : 'here';

        return (
          <button
            key={seat.userId}
            type="button"
            onClick={() => onSelectPlayer(seat.userId)}
            aria-label={`${name}, ${seatSentence(seat, formatAmount)}`}
            // No -translate-* utilities: in Tailwind v4 they compile to the
            // `translate` property, which composes on top of `transform`
            // instead of replacing it — every seat would be shifted half its
            // own box twice and the ring would sit off the felt.
            className={`absolute left-1/2 top-1/2 flex items-center rounded-2xl active:opacity-70 transition-opacity duration-[120ms] ${
              labelAbove ? 'flex-col-reverse' : 'flex-col'
            }`}
            style={{
              transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`,
              width: boxWidth,
              minHeight: Math.max(44, boxHeight),
            }}
          >
            <span className="relative block">
              <span
                className={`block rounded-full ring-2 ring-accent/70 ${
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

              {/* State, as one mark. Paired with the caption below it. */}
              <span
                className={`absolute rounded-full ring-2 ring-bg ${DOT[seat.state]}`}
                style={{ width: size * 0.24, height: size * 0.24, right: 0, bottom: 0 }}
                aria-hidden="true"
              />
            </span>

            {detail !== 'avatar' && (
              <span className={`w-full text-center leading-tight ${labelAbove ? 'mb-1' : 'mt-1'}`}>
                {isMe && (
                  <span className="inline-block px-1.5 rounded-full bg-accent/20 text-accent text-[8px] font-bold tracking-wider">
                    YOU
                  </span>
                )}
                <span
                  className={`block text-[11px] truncate ${
                    dim === 'gone' ? 'text-text-muted' : 'text-text'
                  }`}
                >
                  {name}
                </span>
                {detail === 'full' && (
                  <span className="block text-[10px] text-accent/85 truncate tabular-nums">
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
