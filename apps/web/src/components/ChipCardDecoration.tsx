import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import chipStackImg from '../assets/login/chip-stack.webp';
import aceCardsImg from '../assets/login/ace-cards.webp';

interface ChipCardDecorationProps {
  // 'hero' — the full-strength login treatment (used once, standalone).
  // 'ambient' — a fixed, blurred, low-opacity watermark for content-heavy
  // screens, so it reads as texture rather than competing with real data.
  variant?: 'hero' | 'ambient';
}

// Same source photo everywhere — `--decor-filter` (set per [data-theme] in
// index.css) hue-rotates it onto each theme's accent color at render time.
export const ChipCardDecoration: React.FC<ChipCardDecorationProps> = ({ variant = 'hero' }) => {
  const prefersReducedMotion = useReducedMotion();

  if (variant === 'ambient') {
    return (
      <div
        className="fixed inset-0 z-0 overflow-hidden pointer-events-none"
        style={{ filter: 'var(--decor-filter)' }}
        aria-hidden="true"
      >
        <img
          src={chipStackImg}
          alt=""
          className="absolute -left-6 bottom-28 w-28 h-auto blur-[2px] select-none"
          style={{ opacity: 'var(--decor-opacity)' }}
          draggable={false}
        />
        <img
          src={aceCardsImg}
          alt=""
          className="absolute -right-4 bottom-28 w-24 h-auto blur-[2px] select-none"
          style={{ opacity: 'var(--decor-opacity)' }}
          draggable={false}
        />
      </div>
    );
  }

  return (
    <motion.div
      initial={prefersReducedMotion ? false : { opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.35 }}
      className="relative w-full max-w-sm h-36 shrink-0 pointer-events-none"
      style={{ filter: 'var(--decor-filter)' }}
      aria-hidden="true"
    >
      <img
        src={chipStackImg}
        alt=""
        className="absolute -left-6 bottom-0 w-40 h-auto select-none"
        draggable={false}
      />
      <img
        src={aceCardsImg}
        alt=""
        className="absolute -right-4 bottom-0 w-36 h-auto select-none"
        draggable={false}
      />
    </motion.div>
  );
};
