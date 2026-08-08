import React from 'react';
import { Night, Seat } from '../../lib/night-state';
import { Club } from '../../types';
import { Button } from '../ui/Button';
import { PlayerAvatar } from './PlayerAvatar';

/**
 * The table is open. Nobody is playing yet.
 *
 * The screen this replaces went straight from "Open table" to a live felt with
 * chips in the middle, which was a lie about the room: nobody had joined,
 * nobody had bought in, and nobody had started. A poker night does not begin
 * when the table is created — it begins when everyone is seated, has chips, and
 * the first hand is dealt.
 *
 * So this is deliberately NOT the table. No felt, no seats, no "in play", no
 * clock, no story. There is nothing to tell yet, and drawing an empty poker
 * table would be the same lie in a prettier font. It is a list of people and
 * how ready each of them is.
 *
 * The one thing it is waiting for is a person saying "alright, let's start".
 */

export interface LobbyProps {
  club: Club;
  night: Night;
  currentUserId: string;
  isAdmin: boolean;
  users: Record<string, { displayName?: string; avatarUrl?: string } | undefined>;
  formatAmount: (n: number) => string;
  onSelectPlayer: (userId: string) => void;
  onStartPlaying?: () => void;
  starting?: boolean;
  /**
   * Admins only: take somebody out who said they were coming and went home.
   *
   * Offered only for people with no chips. Somebody holding an approved buy-in
   * has money in the night, and removing them would erase it with no cash-out
   * and no record — that is standing up, not being removed.
   */
  onRemoveFromLobby?: (userId: string) => void;
}

/** The four states of getting ready, in the order they happen. */
function readiness(seat: Seat | undefined, amount: (n: number) => string) {
  if (!seat) return { label: 'Not here yet', ready: false, figure: null as string | null };
  if (seat.state === 'waitingToSit') {
    return {
      label: seat.pendingBuyIn !== null ? 'Waiting for approval' : 'Waiting to join',
      ready: false,
      figure: seat.pendingBuyIn !== null ? amount(seat.pendingBuyIn) : null,
    };
  }
  if (seat.totalBuyIn > 0) {
    return { label: 'Ready', ready: true, figure: amount(seat.totalBuyIn) };
  }
  return {
    label: seat.pendingBuyIn !== null ? 'Waiting for approval' : 'Waiting for buy-in',
    ready: false,
    figure: seat.pendingBuyIn !== null ? amount(seat.pendingBuyIn) : null,
  };
}

export const Lobby: React.FC<LobbyProps> = ({
  club,
  night,
  currentUserId,
  isAdmin,
  users,
  formatAmount,
  onSelectPlayer,
  onStartPlaying,
  starting = false,
  onRemoveFromLobby,
}) => {
  const seatOf = new Map([...night.seats, ...night.room].map((s) => [s.userId, s]));

  // Everyone in the room first, then the rest of the club. Somebody who has
  // walked in outranks somebody who might.
  const here = [...seatOf.keys()];
  const rest = (club.memberUids ?? []).filter((uid) => !seatOf.has(uid));

  const row = (uid: string) => {
    const seat = seatOf.get(uid);
    const { label, ready, figure } = readiness(seat, formatAmount);
    const isMe = uid === currentUserId;
    const name = isMe ? 'You' : users[uid]?.displayName || 'Player';

    // Nothing at stake, so nothing is lost by taking them out. Somebody holding
    // chips has to stand up and be counted like anybody else.
    const removable =
      isAdmin && !isMe && Boolean(onRemoveFromLobby) && Boolean(seat) && !ready;

    return (
      <li key={uid} className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onSelectPlayer(uid)}
          disabled={!isAdmin && !isMe}
          aria-label={`${name}, ${label.toLowerCase()}`}
          className="w-full min-h-[60px] flex items-center gap-3 py-2 text-left disabled:opacity-45"
        >
          <PlayerAvatar
            userId={uid}
            name={name}
            photoUrl={users[uid]?.avatarUrl}
            size={36}
            dim={seat ? 'here' : 'gone'}
          />

          <span className="min-w-0 flex-1">
            <span className="block text-[15px] text-text truncate">{name}</span>
            <span
              className={`block text-xs leading-tight ${ready ? 'text-success' : 'text-text-muted'}`}
            >
              {/* A tick, not a colour alone: readiness is the one thing being
                  scanned down this list, and it has to survive being read by
                  somebody who cannot tell green from grey. */}
              {ready && <span aria-hidden="true">✓ </span>}
              {label}
            </span>
          </span>

          {figure && (
            <span className="text-[15px] text-accent tabular-nums shrink-0">{figure}</span>
          )}
        </button>

        {removable && (
          <button
            type="button"
            onClick={() => onRemoveFromLobby?.(uid)}
            aria-label={`Remove ${name} from the lobby`}
            className="shrink-0 w-11 h-11 grid place-items-center rounded-full text-text-faint active:opacity-60 transition-opacity duration-[var(--motion-state)]"
          >
            <span aria-hidden="true" className="text-lg leading-none">×</span>
          </button>
        )}
      </li>
    );
  };

  return (
    <section className="flex-1 min-h-0 flex flex-col">
      {/* "Preparing table" is the header's line, not this one's — saying it in
          both places is the on-screen-twice defect PRODUCT-BRIEF §14 names. */}
      <div className="shrink-0 px-5 pb-3">
        <p className="text-2xl font-semibold text-text tabular-nums">
          {night.readyCount}
          <span className="text-text-faint"> / {night.lobbyCount} ready</span>
        </p>
      </div>

      <ul className="flex-1 min-h-0 overflow-y-auto px-5 divide-y divide-line/40">
        {here.map(row)}
        {rest.length > 0 && (
          <li className="pt-4 pb-1">
            <p className="text-[10px] uppercase tracking-[0.18em] text-text-faint">
              Not here yet
            </p>
          </li>
        )}
        {rest.map(row)}
      </ul>

      {/*
        The one control that ends this screen, and only an admin has it.

        Two ready players is the whole gate. Not everybody, deliberately:
        somebody is always still parking, and a night that cannot begin until
        the last arrival has bought in is a night the app is holding up. Late
        arrivals join a running table exactly as they would have joined this
        one.
      */}
      {isAdmin && (
        <div className="shrink-0 px-5 pt-3 pb-1">
          {night.canStartPlaying ? (
            <Button variant="primary" size="lg" fullWidth loading={starting} onClick={onStartPlaying}>
              Start playing
            </Button>
          ) : (
            <p className="py-3 text-center text-sm text-text-muted">
              Two players need chips before the night can start.
            </p>
          )}
        </div>
      )}
    </section>
  );
};
