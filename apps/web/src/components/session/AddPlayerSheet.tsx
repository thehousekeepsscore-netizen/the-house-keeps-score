import React, { useMemo, useState } from 'react';
import { Sheet } from '../ui/Sheet';
import { PlayerAvatar } from './PlayerAvatar';

/**
 * Bringing somebody to the table.
 *
 * This sheet chooses a PERSON and nothing else. It deliberately does not ask
 * for an amount, because the moment it did there would be two implementations
 * of "how much?" — one for a player joining themselves and one for a host
 * seating them — and they would drift. Picking a name here opens the player's
 * own sheet, which has always opened on the bank chooser for anyone with no
 * seat. One flow, entered from two doors.
 *
 * What it does not list matters as much as what it does: anyone already in the
 * night is absent, not greyed. A host scanning for "who isn't here yet" should
 * be reading a list of exactly that, and a disabled row is a name they have to
 * read and then discard.
 */

export interface AddPlayerSheetProps {
  open: boolean;
  onClose: () => void;
  /** Club members not currently part of the night, in whatever order the club gives. */
  candidates: { userId: string; name: string; avatarUrl?: string }[];
  onSelect: (userId: string) => void;
}

/** Search appears once a list is long enough to be worth searching. */
const SEARCH_FROM = 8;

export const AddPlayerSheet: React.FC<AddPlayerSheetProps> = ({
  open,
  onClose,
  candidates,
  onSelect,
}) => {
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => c.name.toLowerCase().includes(q));
  }, [candidates, query]);

  const close = () => {
    setQuery('');
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Add player"
      description={
        candidates.length === 0
          ? 'Everyone in this club is already in the night.'
          : undefined
      }
    >
      <div className="space-y-2">
        {candidates.length >= SEARCH_FROM && (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search members"
            aria-label="Search members"
            className="w-full min-h-[48px] px-3 rounded-[var(--radius-sm)] bg-bg text-base text-text placeholder:text-text-faint outline-none focus-visible:ring-1 focus-visible:ring-accent"
          />
        )}

        {shown.length === 0 && candidates.length > 0 && (
          <p className="py-6 text-sm text-text-muted text-center">Nobody by that name.</p>
        )}

        <ul className="divide-y divide-line/40">
          {shown.map((c) => (
            <li key={c.userId}>
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  onSelect(c.userId);
                }}
                className="w-full min-h-[56px] flex items-center gap-3 py-2 text-left active:opacity-70 transition-opacity duration-[var(--motion-state)]"
              >
                <PlayerAvatar userId={c.userId} name={c.name} photoUrl={c.avatarUrl} size={34} />
                <span className="flex-1 text-base text-text truncate">{c.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
};
