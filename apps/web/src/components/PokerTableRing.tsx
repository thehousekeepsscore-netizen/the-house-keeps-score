import React from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Spade, Heart, Diamond, Club, Plus, LogOut } from 'lucide-react';

/**
 * The table. The emotional centrepiece of the product, and the one screen
 * element people remember.
 *
 * It used to be a ring of name labels: readable, but it told you nothing you
 * could not get from a list, and it showed a player awaiting chips as
 * "Arjun · 0 Chips" — settled-state vocabulary describing an unsettled
 * situation.
 *
 * Three changes make it carry its own weight:
 *
 *   avatars    faces, not text. A photo is recognised at a glance in a way a
 *              name never is, and the table is scanned in about a second.
 *   state      every seat says what is happening through colour, ring style
 *              and a badge — readable without reading.
 *   fit        seat geometry and avatar size respond to the count, so two
 *              players do not look abandoned and nine do not collide.
 */

export type SeatState = 'playing' | 'waiting-buyin' | 'waiting-cashout' | 'sitting-out';

export interface RingPlayer {
  uid: string;
  name: string;
  bank: number;
  avatarUrl?: string;
  state?: SeatState;
  /** Deprecated shorthand for `state: 'waiting-buyin'`. */
  pending?: boolean;
}

interface PokerTableRingProps {
  players: RingPlayer[];
  formatBank: (amount: number) => string;
  selectedUid?: string;
  onSelect?: (uid: string) => void;
  onRequestBankFor?: (uid: string) => void;
  className?: string;
}

/**
 * A generated identity for players with no photo.
 *
 * Suit and hue are derived from the user id, so the same person is always the
 * same avatar — consistency is what makes it recognisable rather than decorative.
 * Deliberately not an emoji: platform emoji render differently on every OS, and
 * a table of mismatched glyphs is the opposite of a considered product.
 */
const SUITS = [Spade, Heart, Diamond, Club] as const;

function hashOf(uid: string): number {
  let h = 0;
  for (let i = 0; i < uid.length; i += 1) h = (h * 31 + uid.charCodeAt(i)) >>> 0;
  return h;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Ring, glow and badge per state. Colour alone is never the only signal. */
const STATE_STYLE: Record<SeatState, { ring: string; badge: string | null; dim: boolean; pulse: boolean }> = {
  playing: { ring: 'ring-accent/70', badge: null, dim: false, pulse: false },
  'waiting-buyin': { ring: 'ring-warning ring-dashed', badge: 'buyin', dim: false, pulse: true },
  'waiting-cashout': { ring: 'ring-success ring-dashed', badge: 'cashout', dim: false, pulse: true },
  'sitting-out': { ring: 'ring-line', badge: null, dim: true, pulse: false },
};

export const PokerTableRing: React.FC<PokerTableRingProps> = ({
  players,
  formatBank,
  selectedUid,
  onSelect,
  onRequestBankFor,
  className = '',
}) => {
  const prefersReducedMotion = useReducedMotion();
  const [popoverUid, setPopoverUid] = React.useState<string | null>(null);
  const count = players.length;
  const tappable = typeof onSelect === 'function' || typeof onRequestBankFor === 'function';

  React.useEffect(() => {
    if (popoverUid && !players.some((p) => p.uid === popoverUid)) setPopoverUid(null);
  }, [players, popoverUid]);

  /**
   * Seat geometry, chosen by count.
   *
   * A fixed ellipse looks abandoned at two players and collides at nine. One or
   * two sit opposite each other so the arrangement reads as deliberate rather
   * than as a ring with gaps; three and up distribute evenly, with the avatar
   * shrinking and the ellipse widening as the table fills.
   */
  const avatarPx = count <= 4 ? 56 : count <= 6 ? 48 : 40;
  const radiusX = count <= 2 ? 0 : count <= 4 ? 34 : count <= 6 ? 37 : 40;
  // Pushed out slightly further than the felt's half-height so the name and
  // chip figure under each avatar clear its edge rather than crossing it.
  const radiusY = count <= 2 ? 36 : count <= 4 ? 41 : 43;

  const seatAt = (i: number) => {
    if (count === 1) return { left: 50, top: 14 };
    if (count === 2) return { left: 50, top: i === 0 ? 50 - radiusY : 50 + radiusY };
    const angle = (-90 + i * (360 / count)) * (Math.PI / 180);
    return { left: 50 + radiusX * Math.cos(angle), top: 50 + radiusY * Math.sin(angle) };
  };

  return (
    <div className={`relative w-full max-w-[320px] aspect-[5/6] mx-auto ${className}`}>
      {/* Felt */}
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[50%] h-[52%] rounded-[50%] border-[3px] border-accent/40 flex items-center justify-center overflow-hidden"
        style={{
          background:
            'radial-gradient(circle at 50% 40%, color-mix(in srgb, var(--color-accent) 14%, var(--color-bg)), var(--color-bg) 75%)',
        }}
      >
        <Spade className="absolute w-[46%] h-[46%] text-accent/[0.06]" fill="currentColor" aria-hidden="true" />
        {/*
          The felt shows the pot rather than the words "POKER TABLE". The label
          was the largest text in the centre of the screen and said something the
          user already knew; the number is the thing they keep asking for.
        */}
        <div className="relative text-center px-2">
          <div className="text-[10px] text-accent/60 tracking-wide">On the table</div>
          <div className="text-base font-semibold text-accent tabular-nums">
            {formatBank(players.reduce((sum, p) => sum + p.bank, 0))}
          </div>
        </div>
      </div>

      {/* Seats */}
      <AnimatePresence initial={false}>
        {players.map((player, i) => {
          const { left, top } = seatAt(i);
          const state: SeatState = player.state ?? (player.pending ? 'waiting-buyin' : 'playing');
          const style = STATE_STYLE[state];
          const isSelected = selectedUid === player.uid;
          const showPopover = popoverUid === player.uid && !!onRequestBankFor;
          const Suit = SUITS[hashOf(player.uid) % SUITS.length];
          const hue = hashOf(player.uid) % 360;

          const handleTap = () => {
            if (onSelect) onSelect(player.uid);
            if (onRequestBankFor) setPopoverUid((cur) => (cur === player.uid ? null : player.uid));
          };

          return (
            <motion.div
              key={player.uid}
              layout={!prefersReducedMotion}
              initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.4, y: -18 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={prefersReducedMotion ? undefined : { opacity: 0, scale: 0.4 }}
              transition={{ type: 'spring', stiffness: 380, damping: 26 }}
              style={{ left: `${left}%`, top: `${top}%` }}
              className="absolute -translate-x-1/2 -translate-y-1/2 z-10"
            >
              <button
                type="button"
                onClick={tappable ? handleTap : undefined}
                disabled={!tappable}
                aria-label={`${player.name}, ${formatBank(player.bank)}${
                  state === 'playing' ? '' : `, ${state.replace('-', ' ')}`
                }`}
                className={`flex flex-col items-center gap-1 ${tappable ? 'cursor-pointer' : 'cursor-default'}`}
              >
                <span className="relative block">
                  <span
                    className={`block rounded-full overflow-hidden ring-2 ${
                      isSelected ? 'ring-accent ring-[3px]' : style.ring
                    } ${style.dim ? 'opacity-45 grayscale' : ''} transition-all duration-200`}
                    style={{ width: avatarPx, height: avatarPx }}
                  >
                    {player.avatarUrl ? (
                      <img
                        src={player.avatarUrl}
                        alt=""
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <span
                        className="w-full h-full flex flex-col items-center justify-center"
                        style={{
                          background: `linear-gradient(145deg, hsl(${hue} 30% 22%), hsl(${hue} 35% 12%))`,
                        }}
                      >
                        <Suit
                          className="text-accent/70"
                          fill="currentColor"
                          style={{ width: avatarPx * 0.3, height: avatarPx * 0.3 }}
                          aria-hidden="true"
                        />
                        <span
                          className="font-semibold text-text/90 leading-none mt-0.5"
                          style={{ fontSize: avatarPx * 0.22 }}
                        >
                          {initials(player.name)}
                        </span>
                      </span>
                    )}
                  </span>

                  {/*
                    A badge, not a word. "Waiting…" required reading; a coin or a
                    door icon on the rim is legible at a glance and survives being
                    seen out of the corner of an eye.
                  */}
                  {style.badge && (
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 rounded-full flex items-center justify-center border-2 border-bg ${
                        style.badge === 'buyin' ? 'bg-warning' : 'bg-success'
                      } ${style.pulse ? 'animate-pulse' : ''}`}
                      style={{ width: avatarPx * 0.36, height: avatarPx * 0.36 }}
                      aria-hidden="true"
                    >
                      {style.badge === 'buyin' ? (
                        <Plus className="w-2.5 h-2.5 text-accent-contrast stroke-[3]" />
                      ) : (
                        <LogOut className="w-2.5 h-2.5 text-accent-contrast stroke-[3]" />
                      )}
                    </span>
                  )}
                </span>

                <span
                  className={`font-medium truncate max-w-[76px] leading-tight ${
                    isSelected ? 'text-accent' : style.dim ? 'text-text-muted' : 'text-text'
                  }`}
                  style={{ fontSize: count > 6 ? 11 : 12 }}
                >
                  {player.name}
                </span>
                <span className="text-[11px] font-mono text-text-muted tabular-nums whitespace-nowrap leading-none">
                  {formatBank(player.bank)}
                </span>
              </button>

              <AnimatePresence>
                {showPopover && (
                  <motion.div
                    initial={prefersReducedMotion ? false : { opacity: 0, y: -4, scale: 0.9 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={prefersReducedMotion ? undefined : { opacity: 0, y: -4, scale: 0.9 }}
                    transition={{ duration: 0.15 }}
                    className="absolute left-1/2 -translate-x-1/2 top-full mt-1.5 z-20"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onRequestBankFor?.(player.uid);
                        setPopoverUid(null);
                      }}
                      className="flex items-center gap-1 whitespace-nowrap bg-accent text-accent-contrast font-semibold text-xs px-3 py-2 rounded-xl shadow-lg cursor-pointer active:scale-95 transition-transform"
                    >
                      <Plus className="w-3.5 h-3.5 stroke-[3]" />
                      Buy in
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
      </AnimatePresence>

      {popoverUid && onRequestBankFor && (
        <button
          type="button"
          aria-label="Close"
          onClick={() => setPopoverUid(null)}
          className="absolute inset-0 z-0 cursor-default"
        />
      )}
    </div>
  );
};
