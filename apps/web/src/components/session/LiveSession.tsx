import React, { useEffect, useRef, useState } from 'react';
import { Night } from '../../lib/night-state';
import { Club, PokerSession } from '../../types';
import { Button } from '../ui/Button';
import { PokerTable } from './PokerTable';
import { WaitingForYou, WaitingRow } from './WaitingForYou';
import { TheRoom } from './TheRoom';
import { LiveFeed } from './LiveFeed';
import { Lobby } from './Lobby';
import { NightClockLine, NightClockBanner, useClock } from './NightClock';
import { FeedEvent } from '../../lib/night-feed';

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
  /**
   * Admins only: take me to settlement.
   *
   * One callback for both doors — the footer while the night runs, and the
   * frozen band once it does not — because they mean the same thing. The
   * caller freezes the table first if it is not frozen already.
   */
  onSettleNight?: () => void;
  /** Admins only. Opens the pick-a-person sheet; the amount is asked for after. */
  onAddPlayer?: () => void;
  /**
   * A player asking for chips of their own, from the stud on the felt.
   *
   * The same destination their own seat leads to, reached without first having
   * to work out that their face is a button — and one tap shorter, because the
   * stud already means chips.
   */
  onAskForChips?: () => void;
  /**
   * The night's story, newest first. Derived rather than streamed — see
   * night-feed.ts — so it is complete the moment the screen opens.
   */
  feed: FeedEvent[];
  /** Admins only, in the lobby: "alright, let's start". */
  onStartPlaying?: () => void;
  starting?: boolean;
  /** Admins only: more time on the clock, additive and unlimited. */
  onExtendSession?: () => void;
  /** Admins only: carry on with no limit for the rest of the night. One-way. */
  onKeepPlaying?: () => void;
  /** Admins only: hand the table back, so the night carries on. */
  onResumeNight?: () => void;
  /** Admins only, in the lobby: take out somebody who said they were coming. */
  onRemoveFromLobby?: (userId: string) => void;
  /**
   * Admins only, and only for a night that has none: say what it plays for.
   *
   * Absent once the night has rules — the server refuses a second attempt, so
   * a control that stayed on screen would offer something that cannot happen.
   */
  onSetSettlementRules?: () => void;
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

/**
 * What the brass stud does for whoever is holding the phone.
 *
 * One control and one meaning — chips onto this table — with two subjects. An
 * admin has to be asked whose, because they can bank anybody. A player is the
 * answer already, so they are taken straight to the amount.
 *
 * It was admin-only when it was built, which made it a host's tool sitting in
 * the middle of everybody's table. A player's route to chips was to work out
 * that their own face was a button, which is a thing you either know or you do
 * not.
 */
function studFor(
  isAdmin: boolean,
  hasSeat: boolean,
  onAddPlayer?: () => void,
  onAskForChips?: () => void
): { label: string; onPress: () => void } | undefined {
  if (isAdmin && onAddPlayer) {
    return { label: 'Add a player to the table', onPress: onAddPlayer };
  }
  if (onAskForChips) {
    // The same tap and the same sheet, but not the same act: somebody with no
    // chair is joining, and only somebody already sitting in one is topping up.
    return {
      label: hasSeat ? 'Ask for chips' : 'Join the table',
      onPress: onAskForChips,
    };
  }
  return undefined;
}

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
  onAskForChips,
  feed,
  onStartPlaying,
  starting,
  onExtendSession,
  onKeepPlaying,
  onResumeNight,
  onRemoveFromLobby,
  onSetSettlementRules,
}) => {
  const elapsed = useElapsed(session?.createdAt);
  const clock = useClock(session);
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
        clock={clock}
      />

      {/* The scheduled game running out is a conversation, not an ending. A band
          above the felt rather than a dialog over it: at ten past eleven the
          host is dealing with the room, and an app that demands to be dealt
          with first has its priorities backwards. */}
      {/*
        Frozen for settlement, and saying so.
 
        The server refuses every mutation from here, so a screen that carried on
        offering Approve and Buy chips would be offering controls it knows will
        fail. It outranks the clock band because there is only ever one thing
        asking for attention.
      */}
      {night.settling ? (
        <div className="shrink-0 mx-3 mb-3 px-4 py-2.5 furniture rounded-[var(--radius-lg)]">
          <p className="text-sm text-text">Settling up</p>
          <p className="mt-0.5 text-xs text-text-faint leading-relaxed">
            The table is on hold while the figures are agreed. Nothing can be
            bought or cashed out until it resumes.
          </p>
          {/* The way back IN, which the freeze had no door for: the footer
              hides while settling — correctly, since the night is not being
              played — so a host who closed the settlement screen was left
              looking at a frozen table with only the option to unfreeze it.
              Counting a room's chips takes more than one sitting at the screen.
              `onSettleNight` skips the freeze when one is already stamped, so
              this is the same control as the footer, not a second meaning. */}
          {isAdmin && (
            <div className="mt-2 flex gap-2">
              {onResumeNight && (
                <Button variant="secondary" size="sm" fullWidth onClick={onResumeNight}>
                  Back to the table
                </Button>
              )}
              {onSettleNight && (
                <Button variant="primary" size="sm" fullWidth onClick={onSettleNight}>
                  Count the chips
                </Button>
              )}
            </div>
          )}
        </div>
      ) : live && night.startedPlayingAt !== null && (
        <NightClockBanner
          clock={clock}
          isAdmin={isAdmin}
          onExtend={onExtendSession}
          onKeepPlaying={onKeepPlaying}
          onSettle={onSettleNight}
        />
      )}

      {/*
        A night that does not know what it is playing for.
        
        Only ever true of a game that started before rules were recorded
        against a session, and it has to be dealt with before the night can be
        settled — so it says that, here, rather than letting the host find out
        at 2am when Settle refuses. Players see it too: what the house takes is
        not an administrative detail to them.
      */}
      {live && !night.settling && !session?.settlementRules && night.startedPlayingAt !== null && (
        <div className="shrink-0 mx-3 mb-3 px-4 py-2.5 rounded-[var(--radius-lg)] bg-warning/10 border border-warning/40">
          <p className="text-sm text-text">No settlement rules yet</p>
          <p className="mt-0.5 text-xs text-text-muted leading-relaxed">
            This night began before rules were recorded against a session, so it has none of
            its own. They have to be set before it can be settled.
          </p>
          {isAdmin && onSetSettlementRules && (
            <Button variant="primary" size="sm" fullWidth className="mt-2" onClick={onSetSettlementRules}>
              Set tonight's rules
            </Button>
          )}
        </div>
      )}

      {/* Lead with what needs a decision. This sits above the stage in every
          running phase, not just one, because a request does not care which
          phase the night is in. */}
      {waiting.length > 0 && live && !night.settling && (
        <div className="px-3 pb-3 shrink-0">
          <WaitingForYou rows={waiting} formatAmount={formatAmount} />
        </div>
      )}

      {/* The elastic region. Each phase decides what inside it scrolls — the
          feed while a night runs, the guest list while people are arriving —
          because a scroller nested in a scroller eats the gesture. */}
      <div className="flex-1 min-h-0 flex flex-col">
        <Stage
          night={night}
          club={club}
          users={users}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          onSelectPlayer={onSelectPlayer}
          formatAmount={formatAmount}
          onAddPlayer={onAddPlayer}
          onAskForChips={onAskForChips}
          feed={feed}
          onStartPlaying={onStartPlaying}
          starting={starting}
          onRemoveFromLobby={onRemoveFromLobby}
        />
      </div>

      <NextAction
        night={night}
        isAdmin={isAdmin}
        currentUserId={currentUserId}
        onStartSession={onStartSession}
        onSelectPlayer={onSelectPlayer}
      />

      {/* The permanent home for settling — except in the one moment the band
          above is already asking the same question. Two "Settle night" buttons
          a few pixels apart is the on-screen-twice defect PRODUCT-BRIEF §14
          names, and the band is the one carrying the context. */}
      <SettleFooter
        isAdmin={isAdmin}
        live={live && night.startedPlayingAt !== null && clock.phase !== 'complete' && !night.settling}
        onSettleNight={onSettleNight}
      />
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
  clock: ReturnType<typeof useClock>;
}> = ({ session, elapsed, connection, night, ceiling, formatAmount, live, clock }) => (
  <header className="px-5 pt-4 pb-3 shrink-0">
    <div className="flex items-baseline gap-2 min-w-0">
      {session && (
        <h1 className="text-base font-semibold text-text truncate">{session.sessionName}</h1>
      )}
      {/* No clock in the lobby: nothing has started, so an elapsed time would
          be counting how long people have been standing around. */}
      {night.phase !== 'lobby' && elapsed && (
        <span className="ml-auto text-xs text-text-muted tabular-nums shrink-0">{elapsed}</span>
      )}
    </div>

    {night.phase === 'lobby' && (
      <p className="mt-0.5 text-[11px] uppercase tracking-[0.18em] text-text-faint">
        Preparing table
      </p>
    )}

    {live && <MaxBuyIn ceiling={ceiling} formatAmount={formatAmount} />}

    {/* Only when the host set a length. A night with no end has nothing to
        count towards, so it is shown no clock at all. */}
    <NightClockLine clock={clock} />

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
  onAskForChips?: () => void;
  feed: FeedEvent[];
  onStartPlaying?: () => void;
  starting?: boolean;
  onRemoveFromLobby?: (userId: string) => void;
}> = ({
  night, club, users, currentUserId, isAdmin, onSelectPlayer, formatAmount,
  onAddPlayer, onAskForChips, feed, onStartPlaying, starting, onRemoveFromLobby,
}) => {
  // The feed speaks in the second person wherever it is about the viewer, which
  // is what makes it their view of the night rather than a system log.
  const feedNameOf = (uid: string) => nameOf(users, uid, currentUserId);
  switch (night.phase) {
    case 'dark':
      return <Dark isAdmin={isAdmin} />;
    case 'lobby':
      // Not the table. Nobody is playing, so there is no felt, no chips in the
      // middle, no clock and no story — drawing any of them would be the same
      // lie the old screen told, in a prettier font.
      return (
        <Lobby
          club={club}
          night={night}
          users={users}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          onSelectPlayer={onSelectPlayer}
          formatAmount={formatAmount}
          onStartPlaying={onStartPlaying}
          starting={starting}
          onRemoveFromLobby={onRemoveFromLobby}
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
      /*
       * Table, then the story, then the room.
       *
       * The table takes the size it needs rather than all the space there is:
       * it is still the hero, and it is the thing at the top of the screen, but
       * the half below it belonged to nobody. A player's screen said "You're in
       * for 3,000" and then went silent for four hours.
       *
       * The feed is the elastic region now — it scrolls inside itself, so the
       * table above it and the room below it both stay where they are.
       */
      return (
        <section className="flex-1 min-h-0 flex flex-col">
          <div className="shrink-0 px-1 pt-2">
            <PokerTable
              night={night}
              currentUserId={currentUserId}
              users={users}
              onSelectPlayer={onSelectPlayer}
              formatAmount={formatAmount}
              stud={
              night.settling
                ? undefined
                : studFor(isAdmin, night.mySeat !== null, onAddPlayer, onAskForChips)
            }
            />

            {night.mySeat && night.mySeat.state !== 'cashedOut' && (
              <p className="mt-2 text-center text-sm text-text-muted">
                You're in for {formatAmount(night.mySeat.totalBuyIn)}
              </p>
            )}
          </div>

          <LiveFeed events={feed} nameOf={feedNameOf} formatAmount={formatAmount} />

          {/* The room, under the story. People who have finished do not
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
