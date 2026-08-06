import React from 'react';
import { Spade, Heart, Diamond, Club } from 'lucide-react';

/**
 * A player's face at the table.
 *
 * Their uploaded photo where there is one. Where there is not, the placeholder
 * this app already had: a hue derived from their id, one of the four suits, and
 * their initials. Carried over from PokerTableRing rather than reinvented, so a
 * player looks like the same person on the redesigned screen as on the one it
 * replaces — and so the two do not disagree while both are in the bundle.
 *
 * The hue and the suit are hashed from the uid, so **the same player always gets
 * the same placeholder**. That is what makes a busy table scannable: a person is
 * recognisable before their name is read.
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
  const muted =
    dim === 'gone' ? 'opacity-40 grayscale' : dim === 'leaving' ? 'opacity-70' : '';

  const Suit = SUITS[hashOf(userId) % SUITS.length];
  const hue = hashOf(userId) % 360;

  return (
    <span
      className={`block rounded-full overflow-hidden shrink-0 transition-opacity duration-200 ${muted}`}
      style={{ width: size, height: size }}
    >
      {photoUrl ? (
        <img src={photoUrl} alt="" loading="lazy" className="w-full h-full object-cover" />
      ) : (
        <span
          className="w-full h-full flex flex-col items-center justify-center"
          style={{ background: `linear-gradient(145deg, hsl(${hue} 30% 22%), hsl(${hue} 35% 12%))` }}
        >
          {/* The suit is dropped once the avatar is too small to carry two
              marks — below about 36px the glyph and the initials fight for the
              same pixels and neither reads. */}
          {size >= 36 && (
            <Suit
              className="text-accent/70"
              fill="currentColor"
              style={{ width: size * 0.3, height: size * 0.3 }}
              aria-hidden="true"
            />
          )}
          <span
            className="font-semibold text-text/90 leading-none"
            style={{ fontSize: Math.max(9, size * 0.24), marginTop: size >= 36 ? 2 : 0 }}
          >
            {initials(name)}
          </span>
        </span>
      )}
    </span>
  );
};
