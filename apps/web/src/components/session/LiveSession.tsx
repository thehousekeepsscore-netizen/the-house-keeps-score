import React, { useEffect, useState } from 'react';
import { Night } from '../../lib/night-state';
import { Club, PokerSession } from '../../types';
import { Button } from '../ui/Button';

/**
 * The live session, rebuilt.
 *
 * Three zones that never reorder, and only the middle one changes:
 *
 *   A  identity + vitals   scrolls away — reference, not action
 *   B  the stage           the only thing a phase changes
 *   C  the next action     pinned, and absent whenever there isn't one
 *
 * "Read from the top, act from the bottom": information goes where the eye
 * lands, controls stay where the thumb rests. See
 * LIVE-SESSION-INTERACTION-MODEL.md — this file implements it rather than
 * deciding it.
 *
 * Every measurement in that document is against 375x667 (an iPhone SE, the
 * shortest phone in real use), which leaves 427px of first viewport once
 * chrome is subtracted. That number is why the queue collapses at four cards
 * and not three, and why zone C disappears rather than holding a permanent
 * button.
 */

export interface LiveSessionProps {
  club: Club;
  session: PokerSession | null;
  night: Night;
  currentUserId: string;
  isAdmin: boolean;
  /** Display names and photos, keyed by uid. */
  users: Record<string, { displayName?: string; avatarUrl?: string } | undefined>;
  /** Surfaced only when it is not 'live' — see below. */
  connection: 'live' | 'reconnecting' | 'offline';
  onStartSession: () => void;
  onSelectPlayer: (userId: string) => void;
}

/** Ticks slowly on purpose: the header shows minutes, so a 1s timer would
 *  re-render the screen sixty times to change nothing. */
function useElapsed(since: string | undefined): string | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (!since) return;
    const id = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [since]);

  if (!since) return null;
  const started = Date.parse(since);
  if (!Number.isFinite(started)) return null;
  const mins = Math.max(0, Math.floor((Date.now() - started) / 60_000));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

const nameOf = (
  users: LiveSessionProps['users'],
  uid: string,
  currentUserId: string
) => (uid === currentUserId ? 'You' : users[uid]?.displayName || 'Player');

export const LiveSession: React.FC<LiveSessionProps> = ({
  club,
  session,
  night,
  currentUserId,
  isAdmin,
  users,
  connection,
  onStartSession,
  onSelectPlayer,
}) => {
  const elapsed = useElapsed(session?.createdAt);

  return (
    <div className="flex flex-col min-h-0">
      <Header
        club={club}
        session={session}
        elapsed={elapsed}
        connection={connection}
        night={night}
      />

      <div className="flex-1 min-h-0">
        <Stage
          night={night}
          club={club}
          users={users}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          onSelectPlayer={onSelectPlayer}
        />
      </div>

      <NextAction
        night={night}
        isAdmin={isAdmin}
        currentUserId={currentUserId}
        onStartSession={onStartSession}
      />
    </div>
  );
};

/* ---------------------------------------------------------------- zone A */

/**
 * Session identity and vitals — and deliberately NOT the club name.
 *
 * The interaction model drew this line as "Friday Night · Fri 8 Aug", written
 * on the assumption that this component owned the whole screen. It does not:
 * it mounts inside the club screen, which already has a header carrying the
 * club name, the join code and the viewer's role. Rendering the club name here
 * put it on screen twice — the exact defect PRODUCT-BRIEF §14 exists to remove,
 * reintroduced by the redesign meant to fix it.
 *
 * So: the club screen owns the club name, this owns the session identity.
 *
 * The connection indicator renders ONLY when the socket is not live. A dropped
 * socket leaves the table looking perfectly normal while it silently stops
 * changing, so silence is the failure mode — which means the indicator exists
 * to describe failure, and a permanent green dot would be describing nothing.
 */
const Header: React.FC<{
  club: Club;
  session: PokerSession | null;
  elapsed: string | null;
  connection: LiveSessionProps['connection'];
  night: Night;
}> = ({ session, elapsed, connection, night }) => (
  <header className="px-5 pt-4 pb-3 shrink-0">
    <div className="flex items-baseline gap-2 min-w-0">
      {session && (
        <h1 className="text-base font-bold text-text truncate">{session.sessionName}</h1>
      )}
      {elapsed && (
        <span className="ml-auto text-xs text-text-muted tabular-nums shrink-0">{elapsed}</span>
      )}
    </div>

    {connection !== 'live' && (
      <p role="status" className="mt-1.5 text-xs text-warning">
        {connection === 'offline'
          ? "You're offline — this table may be out of date."
          : 'Reconnecting — this table may be out of date.'}
      </p>
    )}

    {night.phase === 'windingDown' && <WindingDownProgress night={night} />}
  </header>
);

/**
 * Progress, never a difference.
 *
 * Most of the money is still chips the app knows nothing about, so buy-ins
 * against cash-outs mid-night is not a discrepancy — it is a night in progress.
 * Showing it as one would manufacture alarm every Friday.
 */
const WindingDownProgress: React.FC<{ night: Night }> = ({ night }) => {
  const out = night.settlementUids.length - night.playersAtTable;
  const total = night.settlementUids.length;
  const pct = total > 0 ? Math.round((out / total) * 100) : 0;

  return (
    <div className="mt-3">
      <div className="h-1.5 rounded-full bg-line overflow-hidden">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1.5 text-xs text-text-muted">
        {out} of {total} counted out
      </p>
    </div>
  );
};

/* ---------------------------------------------------------------- zone B */

const Stage: React.FC<{
  night: Night;
  club: Club;
  users: LiveSessionProps['users'];
  currentUserId: string;
  isAdmin: boolean;
  onSelectPlayer: (userId: string) => void;
}> = ({ night, club, users, currentUserId, isAdmin, onSelectPlayer }) => {
  switch (night.phase) {
    case 'dark':
      return <Dark isAdmin={isAdmin} />;
    case 'opening':
      return (
        <Opening
          club={club}
          night={night}
          users={users}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          onSelectPlayer={onSelectPlayer}
        />
      );
    case 'ready':
      return <Ready night={night} />;
    case 'closed':
      return <Closed />;
    default:
      // running / windingDown — the table and the queue arrive next.
      return (
        <Placeholder
          night={night}
          users={users}
          currentUserId={currentUserId}
          onSelectPlayer={onSelectPlayer}
        />
      );
  }
};

const Dark: React.FC<{ isAdmin: boolean }> = ({ isAdmin }) => (
  <section className="px-5 py-10 text-center">
    <p className="text-base text-text">No session running.</p>
    <p className="mt-1.5 text-sm text-text-muted">
      {isAdmin ? 'Start one when everyone has arrived.' : 'The host will start one shortly.'}
    </p>
  </section>
);

/**
 * The arrival phase, which the old screen had no concept of — it showed the
 * same scoreboard whether the night had four hours of history or none, so the
 * first fifteen minutes were a table of zeros.
 *
 * The list is every club member, because in this phase the only thing you do
 * to a name is bank them.
 */
const Opening: React.FC<{
  club: Club;
  night: Night;
  users: LiveSessionProps['users'];
  currentUserId: string;
  isAdmin: boolean;
  onSelectPlayer: (userId: string) => void;
}> = ({ club, night, users, currentUserId, isAdmin, onSelectPlayer }) => {
  // Seats, not a boolean. Requests arrive during the arrival phase too — a
  // player opens the app and asks for chips while the host is still banking
  // people — and "at the table" would hide the fact that someone is waiting.
  // One sentence per person, in the vocabulary of their state, in every phase.
  const seatOf = new Map(night.seats.map((s) => [s.userId, s]));
  const roster = club.memberUids ?? [];

  return (
    <section className="px-5 pb-4">
      <h2 className="text-sm font-semibold text-text-muted mb-3">Who's playing?</h2>
      <ul className="divide-y divide-line">
        {roster.map((uid) => {
          const seat = seatOf.get(uid);
          return (
            <li key={uid}>
              <button
                type="button"
                onClick={() => onSelectPlayer(uid)}
                disabled={!isAdmin && uid !== currentUserId}
                className="w-full min-h-[56px] flex items-center gap-3 py-3 text-left disabled:opacity-45"
              >
                <span className="w-9 h-9 rounded-full bg-surface-alt border border-line shrink-0" />
                <span className="flex-1 text-base text-text truncate">
                  {nameOf(users, uid, currentUserId)}
                </span>
                <span className="text-sm text-text-muted shrink-0">
                  {seat ? describe(seat) : 'not yet'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

const Ready: React.FC<{ night: Night }> = ({ night }) => (
  <section className="px-5 py-12 text-center">
    <p className="text-lg font-semibold text-text">Everyone has left.</p>
    <p className="mt-2 text-sm text-text-muted">
      {night.settlementUids.length} players
    </p>
    {night.settleBlockedReason && (
      <p className="mt-5 text-sm text-warning leading-relaxed">{night.settleBlockedReason}</p>
    )}
  </section>
);

const Closed: React.FC = () => (
  <section className="px-5 py-12 text-center">
    <p className="text-base text-text">This night is settled.</p>
  </section>
);

/** Temporary. The table and the action queue land in the next milestones. */
const Placeholder: React.FC<{
  night: Night;
  users: LiveSessionProps['users'];
  currentUserId: string;
  onSelectPlayer: (userId: string) => void;
}> = ({ night, users, currentUserId, onSelectPlayer }) => (
  <section className="px-5 pb-4">
    <ul className="divide-y divide-line">
      {night.seats.map((seat) => (
        <li key={seat.userId}>
          <button
            type="button"
            onClick={() => onSelectPlayer(seat.userId)}
            className="w-full min-h-[56px] flex items-center gap-3 py-3 text-left"
          >
            <span className="w-9 h-9 rounded-full bg-surface-alt border border-line shrink-0" />
            <span className="flex-1 min-w-0">
              <span className="block text-base text-text truncate">
                {nameOf(users, seat.userId, currentUserId)}
              </span>
              <span className="block text-sm text-text-muted">{describe(seat)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  </section>
);

/**
 * One sentence per seat, in the vocabulary of its state.
 *
 * This is the rule the old screen broke: a player with a pending request was
 * rendered as "Arjun · 0 Chips", which is true and useless — settled-state
 * vocabulary describing an unsettled situation. Waiting, in play and counted
 * out are three different vocabularies and they stay apart.
 */
function describe(seat: Night['seats'][number]): string {
  if (seat.pendingBuyIn !== null) return `asked for ${seat.pendingBuyIn.toLocaleString()}`;
  switch (seat.state) {
    case 'waitingToSit':
      return 'wants a seat';
    case 'countingOut':
      return `counting out ${seat.pendingCashOut?.toLocaleString() ?? ''}`.trim();
    case 'cashedOut':
      return `counted out ${seat.confirmedCashOut?.toLocaleString() ?? ''}`.trim();
    case 'seatedNoChips':
      return 'no chips yet';
    case 'inPlay':
    default:
      return `in ${seat.totalBuyIn.toLocaleString()}`;
  }
}

/* ---------------------------------------------------------------- zone C */

/**
 * The next action — and often there isn't one.
 *
 * This is deliberately not a toolbar. A permanently pinned "Buy chips" is the
 * always-visible CASHOUT bar this redesign deleted, wearing a different label:
 * buying chips happens two or three times a night against roughly fifteen
 * glances, so it lives on the person, not on the screen.
 *
 * Two rules keep it honest — it never duplicates a control already on screen,
 * and it is never a menu. When the honest answer is "nothing, you're playing
 * poker", the bar is absent and the table gets those 64 pixels back.
 */
const NextAction: React.FC<{
  night: Night;
  isAdmin: boolean;
  currentUserId: string;
  onStartSession: () => void;
}> = ({ night, isAdmin, onStartSession }) => {
  if (night.phase === 'dark' && isAdmin) {
    return (
      <Bar>
        <Button variant="primary" size="lg" fullWidth onClick={onStartSession}>
          Start tonight
        </Button>
      </Bar>
    );
  }

  if (night.phase === 'ready' && isAdmin && night.canSettle) {
    return (
      <Bar>
        <Button variant="primary" size="lg" fullWidth onClick={() => {}}>
          Review &amp; settle
        </Button>
      </Bar>
    );
  }

  return null;
};

const Bar: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="sticky bottom-0 px-5 pt-3 pb-1 bg-bg/95 backdrop-blur-xl border-t border-line shrink-0">
    {children}
  </div>
);
