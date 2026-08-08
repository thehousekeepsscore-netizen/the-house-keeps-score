import React from 'react';
import { Seat } from '../../lib/night-state';
import { PlayerAvatar } from './PlayerAvatar';

/**
 * People who have finished, and are still here.
 *
 * A confirmed cash-out used to leave someone sitting on the felt holding a
 * settled figure, which kept a chair warm for a person who had already pushed
 * it back — and at eighteen players those chairs are the scarce thing on the
 * screen. Deleting them outright was worse: somebody who cashed out at eleven
 * is not gone, they are standing behind you with a drink, and quite often they
 * sit back down.
 *
 * So they come off the table and into the room under it. Quiet by construction:
 * small faces, muted type, no controls of their own. The felt keeps the
 * attention; this is peripheral vision.
 *
 * Tapping one opens the same sheet as tapping a seat — which is what makes
 * rejoining need no special path. Their seat state is `cashedOut`, and the
 * sheet has always answered that with "Join again".
 */
export const TheRoom: React.FC<{
  room: Seat[];
  users: Record<string, { displayName?: string; avatarUrl?: string } | undefined>;
  currentUserId: string;
  onSelectPlayer: (userId: string) => void;
  formatAmount: (n: number) => string;
}> = ({ room, users, currentUserId, onSelectPlayer, formatAmount }) => {
  if (room.length === 0) return null;

  return (
    <section
      aria-label={`${room.length} in the room`}
      // Scrolls sideways rather than wrapping: a night where nine people have
      // left is a night where the table needs its height more than ever.
      className="shrink-0 px-4 pt-3 flex gap-3 overflow-x-auto overscroll-x-contain"
    >
      {room.map((seat) => {
        const isMe = seat.userId === currentUserId;
        const name = isMe ? 'You' : users[seat.userId]?.displayName || 'Player';

        return (
          <button
            key={seat.userId}
            type="button"
            onClick={() => onSelectPlayer(seat.userId)}
            aria-label={`${name}, cashed out with ${formatAmount(seat.confirmedCashOut ?? 0)}`}
            className="shrink-0 w-[76px] flex flex-col items-center gap-0.5 active:opacity-70 transition-opacity duration-[var(--motion-state)]"
          >
            <PlayerAvatar
              userId={seat.userId}
              name={name}
              photoUrl={users[seat.userId]?.avatarUrl}
              size={30}
              dim="gone"
            />
            <span className="w-full text-center text-[11px] text-text-muted truncate leading-tight">
              {name}
            </span>
            {/* One line, always. Wrapped onto two it doubled the height of the
                whole strip to say a thing nobody is reading closely. */}
            <span className="text-[9px] uppercase tracking-[0.1em] text-text-faint leading-none whitespace-nowrap">
              Cashed out
            </span>
            <span className="text-[11px] text-text-muted tabular-nums leading-tight">
              {formatAmount(seat.confirmedCashOut ?? 0)}
            </span>
          </button>
        );
      })}
    </section>
  );
};
