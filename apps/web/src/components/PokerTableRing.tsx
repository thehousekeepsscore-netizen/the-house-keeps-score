import React from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Spade, Plus } from 'lucide-react';

export interface RingPlayer {
  uid: string;
  name: string;
  bank: number;
  /** Renders the seat as a translucent "waiting to be dealt in" placeholder. */
  pending?: boolean;
}

interface PokerTableRingProps {
  players: RingPlayer[];
  formatBank: (amount: number) => string;
  /** Highlighted seat. Omit for a read-only table. */
  selectedUid?: string;
  /** Provide to make seats tappable (used by the Request-a-Bank modal). */
  onSelect?: (uid: string) => void;
  /**
   * Second way into a buy-in: tapping a seat opens a small popover offering
   * to request a bank for whoever sits there. Mutually exclusive with
   * `onSelect` — pass one or the other, not both.
   */
  onRequestBankFor?: (uid: string) => void;
  className?: string;
}

// The oval felt sits in the middle and every seat is placed on an ellipse
// around it, so 2 players or 9 players both stay evenly spaced without any
// per-count special casing.
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

  // A seat that disappears (cashed out, sit-in rejected) shouldn't leave a
  // stale popover pinned to nothing.
  React.useEffect(() => {
    if (popoverUid && !players.some((p) => p.uid === popoverUid)) setPopoverUid(null);
  }, [players, popoverUid]);

  return (
    <div className={`relative w-full max-w-[300px] aspect-[5/6] mx-auto ${className}`}>
      {/* Felt */}
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[54%] h-[62%] rounded-[50%] border-[3px] border-accent/45 flex items-center justify-center overflow-hidden"
        style={{
          background:
            'radial-gradient(circle at 50% 40%, color-mix(in srgb, var(--color-accent) 14%, var(--color-bg)), var(--color-bg) 75%)',
        }}
      >
        <Spade
          className="absolute w-[50%] h-[50%] text-accent/[0.05]"
          fill="currentColor"
          aria-hidden="true"
        />
        <span className="relative text-[10px] font-black text-accent/70 uppercase tracking-[0.2em] text-center leading-relaxed px-2">
          Poker
          <br />
          Table
        </span>
      </div>

      {/* Seats */}
      <AnimatePresence initial={false}>
        {players.map((player, i) => {
          // Start at 12 o'clock and walk clockwise.
          const angle = (-90 + i * (360 / count)) * (Math.PI / 180);
          const left = 50 + 34 * Math.cos(angle);
          const top = 50 + 40 * Math.sin(angle);
          const isSelected = selectedUid === player.uid;
          const showPopover = popoverUid === player.uid && !!onRequestBankFor;

          const handleTap = () => {
            if (onSelect) onSelect(player.uid);
            if (onRequestBankFor) setPopoverUid((cur) => (cur === player.uid ? null : player.uid));
          };

          return (
            <motion.div
              key={player.uid}
              layout={!prefersReducedMotion}
              // New arrivals drop into their seat rather than popping in.
              initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.4, y: -18 }}
              animate={{ opacity: player.pending ? 0.55 : 1, scale: 1, y: 0 }}
              exit={prefersReducedMotion ? undefined : { opacity: 0, scale: 0.4 }}
              transition={{ type: 'spring', stiffness: 380, damping: 26 }}
              style={{ left: `${left}%`, top: `${top}%` }}
              className="absolute -translate-x-1/2 -translate-y-1/2 z-10"
            >
              <button
                type="button"
                onClick={tappable ? handleTap : undefined}
                disabled={!tappable}
                className={`flex flex-col items-center gap-0.5 px-2.5 py-2 rounded-2xl border transition-colors min-w-[68px] ${
                  isSelected
                    ? 'bg-accent/15 border-accent shadow-lg shadow-accent/20'
                    : player.pending
                      ? 'bg-surface border-dashed border-line-strong'
                      : `bg-surface border-line ${tappable ? 'hover:border-line-strong' : ''}`
                } ${tappable ? 'cursor-pointer' : 'cursor-default'}`}
              >
                <Spade
                  className={`w-3 h-3 ${isSelected ? 'text-accent' : 'text-text-faint'}`}
                  fill="currentColor"
                />
                <span
                  className={`text-[11px] font-bold truncate max-w-[74px] ${
                    isSelected ? 'text-accent' : 'text-text'
                  }`}
                >
                  {player.name}
                </span>
                <span className="text-[9px] font-mono text-text-muted whitespace-nowrap">
                  {player.pending ? 'Waiting…' : formatBank(player.bank)}
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
                      className="flex items-center gap-1 whitespace-nowrap bg-accent text-accent-contrast font-bold text-[10px] uppercase tracking-wide px-2.5 py-1.5 rounded-xl shadow-lg cursor-pointer"
                    >
                      <Plus className="w-3 h-3 stroke-[3]" />
                      Request bank
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
      </AnimatePresence>

      {/* Tapping the felt dismisses an open seat popover */}
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
