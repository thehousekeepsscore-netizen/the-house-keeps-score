import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Spade, Heart, Club as ClubIcon } from 'lucide-react';

// A small fanned "deal" of three cards, dealt in on load then idling with a
// gentle breathing motion — shown while the initial auth check is in
// flight, so the app never flashes the login form for an already-signed-in
// user. Purely decorative; respects prefers-reduced-motion.
const CARD_SUITS = [
  { Icon: Spade, rotate: -16, delay: 0 },
  { Icon: Heart, rotate: 0, delay: 0.08 },
  { Icon: ClubIcon, rotate: 16, delay: 0.16 },
];

export const SplashScreen: React.FC = () => {
  const prefersReducedMotion = useReducedMotion();

  return (
    <div className="fixed inset-0 z-[999] bg-bg flex flex-col items-center justify-center gap-8 overflow-hidden">
      {/* Faint vignette, matches LoginPage's felt-texture treatment */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(circle at 50% 45%, color-mix(in srgb, var(--color-accent) 6%, transparent), transparent 60%)',
        }}
      />

      <div className="relative w-32 h-24">
        {CARD_SUITS.map(({ Icon, rotate, delay }, i) => (
          <motion.div
            key={i}
            initial={prefersReducedMotion ? false : { opacity: 0, y: 40, rotate: 0, scale: 0.8 }}
            animate={
              prefersReducedMotion
                ? { opacity: 1, rotate }
                : { opacity: 1, y: [40, 0, 0], rotate: [0, rotate, rotate + (i - 1) * 2, rotate], scale: 1 }
            }
            transition={
              prefersReducedMotion
                ? undefined
                : {
                    duration: 0.6,
                    delay,
                    times: [0, 0.6, 1],
                    rotate: { duration: 2.6, repeat: Infinity, repeatType: 'mirror', ease: 'easeInOut', delay: delay + 0.7 },
                  }
            }
            className="absolute left-1/2 top-1/2 w-16 h-24 -ml-8 -mt-12 rounded-xl bg-surface border-2 border-line-strong shadow-xl shadow-black/30 flex items-center justify-center origin-bottom"
            style={{ transformOrigin: '50% 90%' }}
          >
            <Icon className="w-7 h-7 text-accent" fill="currentColor" />
          </motion.div>
        ))}
      </div>

      <motion.div
        initial={prefersReducedMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.4 }}
        className="text-center"
      >
        <h1 className="text-lg font-bold tracking-tight text-text">
          The House <span className="text-accent">Keeps Score</span>
        </h1>
        <div className="flex items-center justify-center gap-1.5 mt-3">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-accent"
              animate={prefersReducedMotion ? { opacity: 0.6 } : { opacity: [0.25, 1, 0.25] }}
              transition={prefersReducedMotion ? undefined : { duration: 1.1, repeat: Infinity, delay: i * 0.18, ease: 'easeInOut' }}
            />
          ))}
        </div>
      </motion.div>
    </div>
  );
};
