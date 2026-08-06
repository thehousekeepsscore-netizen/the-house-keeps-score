import React from 'react';

/**
 * A player's face at the table.
 *
 * A photo where one exists. Where it does not, a generated chip — not a
 * monogram on a grey circle, and never a platform emoji, which would be the one
 * element on screen rendered by someone else's design system.
 *
 * The generated form is a poker chip seen face-on: a coloured body, the ring of
 * edge spots every casino chip has, and the player's initials struck in the
 * middle. It reads as belonging to this app rather than as a placeholder
 * apologising for a missing photo.
 *
 * **The same player always gets the same chip.** Colour is chosen by hashing the
 * uid, so identity is stable across every surface — the felt, the queue, the
 * sheet, settlement, history — and a nine-player night stays scannable because
 * a person is recognisable before their name is read.
 */

/** Chip denominations, roughly. Chosen to stay distinguishable side by side and
 *  to survive both themes; none is close to the accent used for actions. */
const CHIPS = [
  { body: '#8f1d2b', spot: '#e8c9cd' }, // red
  { body: '#1d3f8f', spot: '#c9d4e8' }, // blue
  { body: '#1f6b45', spot: '#c6e2d4' }, // green
  { body: '#4a2a6b', spot: '#d8cbe6' }, // purple
  { body: '#8a5a12', spot: '#eddcbe' }, // bronze
  { body: '#1c1c1c', spot: '#cfcfcf' }, // black
  { body: '#0f5f6b', spot: '#c3e2e6' }, // teal
  { body: '#7a2f5e', spot: '#e8c8dd' }, // plum
] as const;

/** Stable across sessions, devices and reloads — a plain string hash, not
 *  Math.random, or a player would change identity on every render. */
function chipFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return CHIPS[Math.abs(h) % CHIPS.length];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export const PlayerAvatar: React.FC<{
  userId: string;
  name: string;
  photoUrl?: string;
  size: number;
  /**
   * How far through leaving this player is.
   *
   *   here     full strength
   *   leaving  counting out — a figure is being agreed, they are half gone
   *   gone     counted out — past tense, still in their chair
   *
   * A progression rather than three unrelated treatments, so the table tells
   * the story of the night emptying instead of listing states.
   */
  dim?: 'here' | 'leaving' | 'gone';
}> = ({ userId, name, photoUrl, size, dim = 'here' }) => {
  const style: React.CSSProperties = { width: size, height: size };
  const muted =
    dim === 'gone' ? 'opacity-40 saturate-[0.35]' : dim === 'leaving' ? 'opacity-70 saturate-75' : '';

  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt=""
        style={style}
        className={`rounded-full object-cover bg-surface-alt transition-opacity duration-200 ${muted}`}
      />
    );
  }

  const chip = chipFor(userId);
  // Eight spots, the arrangement almost every casino chip uses.
  const spots = Array.from({ length: 8 }, (_, i) => (i * 360) / 8);

  return (
    <svg
      viewBox="0 0 100 100"
      style={style}
      className={`rounded-full shrink-0 transition-opacity duration-200 ${muted}`}
      role="img"
      aria-label=""
    >
      <circle cx="50" cy="50" r="50" fill={chip.body} />
      {spots.map((deg) => (
        <rect
          key={deg}
          x="46"
          y="1"
          width="8"
          height="13"
          rx="3"
          fill={chip.spot}
          opacity="0.85"
          transform={`rotate(${deg} 50 50)`}
        />
      ))}
      <circle cx="50" cy="50" r="34" fill="none" stroke={chip.spot} strokeOpacity="0.35" strokeWidth="2" />
      <text
        x="50"
        y="51"
        textAnchor="middle"
        dominantBaseline="central"
        fill={chip.spot}
        fontSize="30"
        fontWeight="700"
        fontFamily="system-ui, -apple-system, sans-serif"
        letterSpacing="0.5"
      >
        {initials(name)}
      </text>
    </svg>
  );
};
