import React, { useEffect, useRef, useState } from 'react';
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
 * A rounded rectangle, seated on all four edges.
 *
 * A horizontal racetrack was better than an ellipse and still wrong at high
 * counts: it has only two long runs, so eighteen players crowd the two caps.
 * A tall rounded rectangle has four — five across the top, four down each side,
 * five across the bottom — which is how a real table seats a crowd, and it is
 * what buys the room for eighteen names.
 *
 * It costs height. The table now takes roughly half the screen, and the action
 * queue moves into a sheet over it rather than a band above it. That was a
 * deliberate trade: the felt is the emotional home of the screen, and a queue
 * in a sheet at rest is still visible, so PRODUCT-BRIEF §6 still holds.
 *
 * `w`/`h` are half-width and half-height, `r` the corner radius.
 */
function felt(count: number, available: number) {
  // Seats straddle the rim, so half a seat BOX hangs outside the table — the
  // box, not the avatar. Budgeting for the avatar alone let a name run off the
  // left edge of the phone at eighteen players, because the label is wider
  // than the face it sits under.
  const boxGuess = count <= 6 ? 88 : count <= 14 ? 64 : 56;
  const maxW = Math.max(120, available / 2 - 3 - boxGuess / 2);

  const h =
    count <= 4 ? 92 : count <= 6 ? 106 : count <= 9 ? 126 : count <= 14 ? 146 : 158;
  const wWanted = count <= 4 ? 120 : count <= 6 ? 140 : count <= 9 ? 158 : 170;
  const w = Math.round(Math.min(maxW, wWanted));

  // Rounded, but not a stadium: a full-radius end would collapse the side runs
  // back into caps and bring the crowding with them.
  const r = Math.round(Math.min(w, h) * 0.74);
  return { w, h, r };
}

/** Four straight runs plus one full circle of corners. */
const perimeter = (w: number, h: number, r: number) =>
  4 * (w - r) + 4 * (h - r) + 2 * Math.PI * r;

/**
 * Seat i, walked by ARC LENGTH clockwise from bottom-centre — so the gap
 * between any two neighbours is identical wherever they sit. Walking by angle
 * would put five comfortably along the top and crush the rest into the corners.
 */
function position(i: number, count: number, w: number, h: number, r: number) {
  const straightX = w - r;
  const straightY = h - r;
  const corner = (Math.PI / 2) * r;
  let t = ((i * perimeter(w, h, r)) / count) % perimeter(w, h, r);

  // 1. bottom run, centre → right
  if (t < straightX) return { x: t, y: h };
  t -= straightX;
  // 2. bottom-right corner
  if (t < corner) {
    const a = Math.PI / 2 - t / r;
    return { x: straightX + r * Math.cos(a), y: straightY + r * Math.sin(a) };
  }
  t -= corner;
  // 3. right run, bottom → top
  if (t < 2 * straightY) return { x: w, y: straightY - t };
  t -= 2 * straightY;
  // 4. top-right corner
  if (t < corner) {
    const a = -t / r;
    return { x: straightX + r * Math.cos(a), y: -straightY + r * Math.sin(a) };
  }
  t -= corner;
  // 5. top run, right → left
  if (t < 2 * straightX) return { x: straightX - t, y: -h };
  t -= 2 * straightX;
  // 6. top-left corner
  if (t < corner) {
    const a = -Math.PI / 2 - t / r;
    return { x: -straightX + r * Math.cos(a), y: -straightY + r * Math.sin(a) };
  }
  t -= corner;
  // 7. left run, top → bottom
  if (t < 2 * straightY) return { x: -w, y: -straightY + t };
  t -= 2 * straightY;
  // 8. bottom-left corner
  if (t < corner) {
    const a = Math.PI - t / r;
    // `+ sin`, not `- sin`: this corner sweeps downward from the left run to
    // the bottom run, and negating it folded the arc back up into the table —
    // which threw every seat after it and piled the left side on itself.
    return { x: -straightX + r * Math.cos(a), y: straightY + r * Math.sin(a) };
  }
  t -= corner;
  // 9. bottom run, left → centre
  return { x: -straightX + t, y: h };
}

/** The table is as wide as its container; everything else follows from that. */
function useAvailableWidth(ref: React.RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(360);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/**
 * How much a seat says, by how much room it has.
 *
 * A physical table seats ten or eleven, but nothing in the data caps a club
 * there, so the ring must not have a cliff. Size comes from the gap between
 * neighbours rather than from a fixed tier.
 */
type Detail = 'full' | 'name' | 'avatar';
const LABEL_HEIGHT: Record<Detail, number> = { full: 26, name: 15, avatar: 0 };

function seatMetrics(count: number, w: number, h: number, r: number) {
  const spacing = count > 1 ? perimeter(w, h, r) / count : 200;
  // Four runs instead of two means names survive to twenty rather than nine.
  const detail: Detail = count <= 20 ? 'full' : count <= 28 ? 'name' : 'avatar';
  const labelHeight = LABEL_HEIGHT[detail];
  const cap = count <= 6 ? 50 : count <= 14 ? 40 : 34;

  // Floor of 24px. Past roughly thirty players a 320px table cannot hold
  // another face without them touching — a property of the phone, not of the
  // layout. It degrades rather than breaking, and is far past a real table.
  const size = Math.round(Math.max(22, Math.min(cap, spacing - labelHeight - 4)));
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

  const hostRef = useRef<HTMLDivElement>(null);
  const available = useAvailableWidth(hostRef);
  const { w, h, r } = felt(count, available);
  const { spacing, detail, size, boxHeight } = seatMetrics(count, w, h, r);
  const boxWidth = Math.max(size, Math.min(96, spacing - 6));
  const quiet = night.phase === 'windingDown';
  // The rail scales with the table so a small game does not get a chunky frame
  // and a large one does not get a hairline.
  const railW = Math.round(Math.max(11, Math.min(18, h * 0.11)));

  return (
    <div
      ref={hostRef}
      className="relative w-full"
      style={{ height: 2 * h + boxHeight + 12 }}
      role="group"
      aria-label={`${seats.length} at the table`}
    >
      {/*
        The felt, in layers. See index.css — leather, brushed brass, cloth,
        weave, vignette, embossed suit. Every edge here is a change in light
        rather than a stroke, which is the difference between a table and a
        drawing of one.
      */}
      <div
        className="felt-shell"
        style={{ width: 2 * w, height: 2 * h, borderRadius: r }}
      >
        <div className="felt-rail" />

        <div
          className="felt-trim"
          style={{ inset: railW, borderRadius: Math.max(8, r - railW) }}
        >
          <div
            className="felt-surface"
            style={{
              inset: 2,
              borderRadius: Math.max(6, r - railW - 2),
              // The night quietens as people leave — the cloth loses its light
              // rather than the app announcing that the night is ending.
              filter: quiet ? 'saturate(0.6) brightness(0.9)' : undefined,
              transition: 'filter 200ms ease-out',
            }}
          >
            <div className="felt-weave" />
            <div className="felt-vignette" />
            <span className="felt-mark" style={{ fontSize: Math.round(h * 1.05) }} aria-hidden="true">
              ♠
            </span>

            <div className="relative z-10 h-full flex flex-col items-center justify-center">
              <span className="text-[10px] uppercase tracking-[0.2em] text-white/40">In play</span>
              <span className="text-2xl font-semibold text-white/95 tabular-nums leading-tight">
                {formatAmount(night.chipsInPlay)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {ordered.map((seat, i) => {
        const { x, y } = position(i, count, w, h, r);
        // Labels sit below the avatar everywhere, including the top run. That
        // needed the felt's edges darkened first — the flip that put them above
        // was working around a centre that was too light, and it cost the top
        // of the table a row of vertical space it did not have to give.
        const labelAbove = false;
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
                  <span className="inline-block px-1.5 rounded-full bg-accent/20 text-accent text-[8px] font-medium ">
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
                {detail === 'full' &&
                  (seat.pendingBuyIn !== null || seat.state === 'waitingToSit' ? (
                    // A question gets its own weight. As a caption it read like
                    // a smaller version of a chip count, which is the confusion
                    // this whole vocabulary exists to prevent.
                    <span className="inline-block mt-0.5 px-1.5 py-px rounded-full bg-accent text-accent-contrast text-[9px] font-medium uppercase tracking-wide whitespace-nowrap">
                      {seatCaption(seat, formatAmount)}
                    </span>
                  ) : (
                    <span className="block text-[10px] text-accent/85 truncate tabular-nums">
                      {seatCaption(seat, formatAmount)}
                    </span>
                  ))}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
