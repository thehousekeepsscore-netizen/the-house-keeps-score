import React from 'react';
import { Spade, Heart } from 'lucide-react';

interface BrandLogoProps {
  /** Tailwind size classes for the badge, e.g. "w-20 h-20". */
  className?: string;
  /** 'squircle' is the primary mark; 'circle' the alternate; 'spot' drops the suits. */
  variant?: 'squircle' | 'circle' | 'spot';
  /** Font size class for the "H". */
  letterClassName?: string;
  /** Suit icon size class. */
  suitClassName?: string;
}

// The app's mark: a gold "H" flanked by a spade and a heart.
//
// Everything is driven by theme tokens, so this single component *is* the
// whole logo set — it renders in Emerald gold, Nordic teal, Royal purple,
// Midnight ruby or Poker Lounge blue depending on the active palette, with no
// per-theme asset to export or keep in sync.
export const BrandLogo: React.FC<BrandLogoProps> = ({
  className = 'w-20 h-20',
  variant = 'squircle',
  letterClassName = 'text-[2.9rem]',
  suitClassName = 'w-3.5 h-3.5',
}) => {
  const shape = variant === 'circle' ? 'rounded-full' : 'rounded-[28%]';

  return (
    <div
      className={`relative ${className} ${shape} border-2 border-accent flex items-center justify-center shadow-lg shadow-black/40 shrink-0 overflow-hidden`}
      // Subtle top-lit gradient rather than a flat fill, so the badge reads as
      // a physical chip the way the brand sheet does.
      style={{
        background:
          'radial-gradient(120% 100% at 50% 0%, color-mix(in srgb, var(--color-accent) 10%, var(--color-surface)), var(--color-surface) 70%)',
      }}
      aria-hidden="true"
    >
      {variant !== 'spot' && (
        <Spade
          className={`absolute top-[9%] left-[9%] ${suitClassName} text-accent`}
          fill="currentColor"
        />
      )}

      <span
        className={`${letterClassName} font-semibold leading-none select-none`}
        style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          transform: 'translateY(3%)',
          // Metallic sheen across the letter — falls back to a solid accent
          // fill anywhere background-clip:text isn't supported.
          color: 'var(--color-accent)',
          backgroundImage:
            'linear-gradient(160deg, color-mix(in srgb, var(--color-accent) 55%, white), var(--color-accent) 45%, color-mix(in srgb, var(--color-accent) 70%, black))',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}
      >
        H
      </span>

      {variant !== 'spot' && (
        <Heart
          className={`absolute bottom-[9%] right-[9%] ${suitClassName} text-accent`}
          fill="currentColor"
        />
      )}
    </div>
  );
};
