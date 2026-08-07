import React, { useEffect, useRef, useState } from 'react';
import { Night } from '../../lib/night-state';
import { Club, PokerSession } from '../../types';
import { Button } from '../ui/Button';
import { PokerTable } from './PokerTable';
import { seatSentence } from '../../lib/seat-vocabulary';
import { WaitingForYou, WaitingRow } from './WaitingForYou';
import { TheRoom } from './TheRoom';

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
  /** Built by the screen that owns the mutations, not by the queue. */
  waiting: WaitingRow[];
  /**
   * The club's own formatter. Threaded in rather than written here, because
   * the club decides whether a figure is chips or rupees — a club with
   * devaluation on values several chips at ₹1, so a hardcoded ₹ on the felt
   * would be stating something false about money.
   */
  formatAmount: (n: number) => string;
  /**
   * The live buy-in ceiling. Null when the club is UNCAPPED.
   *
   * Shown in the header rather than only inside the join sheet: under
   * MATCH_HIGHEST this is a moving number, and a limit you have to open a sheet
   * to discover is a limit people find out about by being refused.
   */
  ceiling: number | null;
  /** Admins only, and always available — settlement itself lands in the next PR. */
  onSettleNight?: () => void;
  /** Admins only. Opens the pick-a-person sheet; the amount is asked for after. */
  onAddPlayer?: () => void;
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
  formatAmount,
  waiting,
  ceiling,
  onSettleNight,
  onAddPlayer,
}) => {
  const elapsed = useElapsed(session?.createdAt);
  const live = night.phase !== 'dark' && night.phase !== 'closed';

  /*
   * Four regions, and only one of them is elastic.
   *
   *   header   fixed    identity, the clock, the limit
   *   queue    fixed    two cards, and it scrolls inside itself
   *   stage    ELASTIC  the table takes whatever is left
   *   footer   fixed    the one thing an admin needs to find at 2am
   *
   * The table is the hero, so it is the region that absorbs change. Nothing
   * else is allowed to push it: a queue that grew with its contents moved the
   * felt every time somebody asked for chips, which is the same seat-moves-
   * under-a-thumb failure PRODUCT-BRIEF §2.5 names.
   */
  return (
    <div className="flex flex-col min-h-0 flex-1">
      <Header
        club={club}
        session={session}
        elapsed={elapsed}
        connection={connection}
        night={night}
        ceiling={ceiling}
        formatAmount={formatAmount}
        live={live}
      />

      {/* Lead with what needs a decision. This sits above the stage in every
          running phase, not just one, because a request does not care which
          phase the night is in. */}
      {waiting.length > 0 && live && (
        <div className="px-3 pb-3 shrink-0">
          <WaitingForYou rows={waiting} formatAmount={formatAmount} />
        </div>
      )}

      {/* The elastic region. It scrolls rather than growing, because growing is
          how the guest list — which is every club member during the arrival
          phase — used to push the settle footer off the bottom of the screen. */}
      <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
        <Stage
          night={night}
          club={club}
          users={users}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          onSelectPlayer={onSelectPlayer}
          formatAmount={formatAmount}
          onAddPlayer={onAddPlayer}
        />
      </div>

      <NextAction
        night={night}
        isAdmin={isAdmin}
        currentUserId={currentUserId}
        onStartSession={onStartSession}
        onSelectPlayer={onSelectPlayer}
      />

      <SettleFooter isAdmin={isAdmin} live={live} onSettleNight={onSettleNight} />
    </div>
  );
};

/**
 * Where "Settle Night" lives, permanently.
 *
 * The one control on this screen that is pinned regardless of what the night is
 * doing — which is a deliberate exception to the rule that zone C disappears
 * when there is nothing to do. Settling is the one thing a host must be able to
 * find without hunting, at the end of a long evening, and a control that moves
 * around by phase is a control you search for.
 *
 * Always enabled here on purpose: validation and the settlement flow itself are
 * the next PR, and a disabled button that will not say why is worse than one
 * that opens something honest.
 */
const SettleFooter: React.FC<{
  isAdmin: boolean;
  live: boolean;
  onSettleNight?: () => void;
}> = ({ isAdmin, live, onSettleNight }) => {
  if (!isAdmin || !live || !onSettleNight) return null;
  return (
    <div className="shrink-0 px-5 py-2.5 border-t border-line bg-bg/95 backdrop-blur-xl">
      <Button variant="secondary" size="md" fullWidth onClick={onSettleNight}>
        Settle night
      </Button>
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
  ceiling: number | null;
  formatAmount: (n: number) => string;
  live: boolean;
}> = ({ session, elapsed, connection, night, ceiling, formatAmount, live }) => (
  <header className="px-5 pt-4 pb-3 shrink-0">
    <div className="flex items-baseline gap-2 min-w-0">
      {session && (
        <h1 className="text-base font-semibold text-text truncate">{session.sessionName}</h1>
      )}
      {elapsed && (
        <span className="ml-auto text-xs text-text-muted tabular-nums shrink-0">{elapsed}</span>
      )}
    </div>

    {live && <MaxBuyIn ceiling={ceiling} formatAmount={formatAmount} />}

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
 * The table maximum, on screen at all times.
 *
 * Under MATCH_HIGHEST this is not a setting, it is a live figure: it rises the
 * moment anyone takes a bigger bank than has been taken. Before this it existed
 * only inside the join sheet, which meant the way most people discovered the
 * limit was by asking for more than it and being refused.
 *
 * It brightens once when it changes. A number that quietly becomes a different
 * number is the thing worth animating, and the only thing here worth animating.
 */
const MaxBuyIn: React.FC<{
  ceiling: number | null;
  formatAmount: (n: number) => string;
}> = ({ ceiling, formatAmount }) => {
  const [bumped, setBumped] = useState(0);
  const previous = useRef(ceiling);

  useEffect(() => {
    // Only a change, never the first sight of it — arriving at a table is not
    // an event the limit should be celebrating.
    if (previous.current !== null && ceiling !== null && ceiling !== previous.current) {
      setBumped((n) => n + 1);
    }
    previous.current = ceiling;
  }, [ceiling]);

  return (
    <div className="mt-1 flex items-baseline gap-2">
      <span className="text-xs text-text-muted">Max buy-in</span>
      <span
        // Re-keyed so the animation restarts rather than being ignored as
        // already-applied when the figure changes twice in quick succession.
        key={bumped}
        className={`ml-auto text-sm font-semibold text-accent tabular-nums ${
          bumped > 0 ? 'animate-[figure-changed_var(--motion-ceremony)_ease-out]' : ''
        }`}
      >
        {ceiling === null ? 'No limit' : formatAmount(ceiling)}
      </span>
    </div>
  );
};

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
  formatAmount: (n: number) => string;
  onAddPlayer?: () => void;
}> = ({ night, club, users, currentUserId, isAdmin, onSelectPlayer, formatAmount, onAddPlayer }) => {
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
          formatAmount={formatAmount}
        />
      );
    case 'ready':
      return <Ready night={night} />;
    case 'closed':
      return <Closed />;
    default:
      // running / windingDown — the same felt in both. It never disappears
      // because people are leaving; it quietens.
      //
      // flex-1 is the whole of item 9: the table is the region that grows, so
      // everything above it can be fixed and nothing above it can push it.
      return (
        <section className="flex-1 min-h-0 flex flex-col justify-center px-1 py-2">
          <PokerTable
            night={night}
            currentUserId={currentUserId}
            users={users}
            onSelectPlayer={onSelectPlayer}
            formatAmount={formatAmount}
            onAddPlayer={isAdmin ? onAddPlayer : undefined}
          />

          {night.mySeat && night.mySeat.state !== 'cashedOut' && (
            <p className="mt-3 text-center text-sm text-text-muted">
              You're in for {formatAmount(night.mySeat.totalBuyIn)}
            </p>
          )}

          {/* The room, under the table. People who have finished do not
              disappear — they step back from the felt. */}
          <TheRoom
            room={night.room}
            users={users}
            currentUserId={currentUserId}
            onSelectPlayer={onSelectPlayer}
            formatAmount={formatAmount}
          />
        </section>
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
  formatAmount: (n: number) => string;
}> = ({ club, night, users, currentUserId, isAdmin, onSelectPlayer, formatAmount }) => {
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
                  {seat ? seatSentence(seat, formatAmount) : 'not yet'}
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
  onSelectPlayer: (userId: string) => void;
}> = ({ night, isAdmin, currentUserId, onStartSession, onSelectPlayer }) => {
  if (night.phase === 'dark' && isAdmin) {
    return (
      <Bar>
        <Button variant="primary" size="lg" fullWidth onClick={onStartSession}>
          Start tonight
        </Button>
      </Bar>
    );
  }

  // Settling used to appear here as "Review & settle" once everyone had left.
  // It now lives in the footer, permanently and in one place, so this branch
  // would be the same action offered twice a few pixels apart.

  // Somebody who is not at the table has no seat to tap, so this is the one
  // situation where the bar carries the way in. Still the next thing to do
  // rather than a permanent control: the moment they are seated, it goes.
  //
  // Nothing is offered once everyone has left: the host has no seat either at
  // that point, so a chair at an empty table is not the next thing to do.
  if (!night.mySeat && night.phase !== 'dark' && night.phase !== 'closed' && night.phase !== 'ready') {
    return (
      <Bar>
        <Button variant="primary" size="lg" fullWidth onClick={() => onSelectPlayer(currentUserId)}>
          Join table
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
