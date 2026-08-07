import React, { useState } from 'react';
import { LiveSession } from './LiveSession';
import { PlayerSheet } from './PlayerSheet';
import { AddPlayerSheet } from './AddPlayerSheet';
import { WaitingRow } from './WaitingForYou';
import { deriveNight } from '../../lib/night-state';
import { Club, PokerSession, BuyInRequest } from '../../types';

/**
 * The whole live session screen, with a full table.
 *
 * TablePreview shows the felt on its own, which is the right tool for
 * geometry. This is the other question — what a night actually looks like —
 * and it needs the header, the queue and the bar in place to answer it,
 * because the thing worth judging is how they share one screen.
 *
 * Developer instrumentation, same as /debug/table: unlinked and behind auth.
 */

const NAMES = ['Priya', 'Arjun', 'Sam', 'Meera', 'Ishaan', 'Nikhil', 'Rhea', 'Kabir', 'Tara'];
const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const club = {
  id: 'c1',
  name: 'Friday Night',
  memberUids: NAMES.map((_, i) => `u${i}`),
  minBuyIn: 1000,
  maxBuyIn: 5000,
} as unknown as Club;

export const SessionPreview: React.FC = () => {
  const params = new URLSearchParams(window.location.search);
  const count = Math.max(1, Math.min(18, Number(params.get('n')) || 9));
  // ?queue=0 hides it, ?queue=N asks for N people waiting — the point of a
  // number rather than a flag is that the region is supposed to stop growing at
  // two, and that is only visible with more than two.
  const queueParam = params.get('queue');
  const withQueue = queueParam !== '0';
  const extraWaiting = Math.max(0, Math.min(8, Number(queueParam) || 0) - 2);

  const [picked, setPicked] = useState<string | null>(null);
  // Locally applied so the journey is walkable end to end without a server:
  // tapping an amount adds the pending request the API would have created.
  const [myRequest, setMyRequest] = useState<number | null>(null);
  // Same idea for standing up: the request the API would have created, applied
  // locally, so the seat state and the admin's confirmation are both walkable.
  const [cashOut, setCashOut] = useState<{ userId: string; amount: number } | null>(null);
  // ?room=N seats N people who have already finished, so the room under the
  // table can be judged with the felt still full.
  const [confirmed, setConfirmed] = useState<{ userId: string; amount: number }[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  // ?me=out starts the viewer outside the game, which is the only way to see
  // the arrival journey — everything else assumes you are already seated.
  const outside = params.get('me') === 'out';

  const uids = Array.from({ length: count }, (_, i) => `u${i}`);
  // Every club member, not just the ones seated — Add Player lists the people
  // who are NOT in the night, and they need names too.
  // Every club member AND every seat — Add Player lists the people who are not
  // in the night, and a table of eighteen needs eighteen names of realistic
  // width, not nine names and nine "Player"s.
  const users: Record<string, { displayName?: string }> = Object.fromEntries(
    Array.from(new Set([...club.memberUids, ...Array.from({ length: count }, (_, i) => `u${i}`)]))
      .map((uid) => {
        const i = Number(uid.slice(1));
        return [uid, { displayName: i >= NAMES.length ? `${NAMES[i % NAMES.length]} ${Math.floor(i / NAMES.length) + 1}` : NAMES[i] }];
      })
  );
  const me = outside ? 'me' : 'u0';
  if (outside) users.me = { displayName: 'You' };

  // Eight seated and banked; the ninth is pulling up a chair, so the felt and
  // the queue are both showing something real.
  const seated = uids.slice(0, count - 1);
  const arriving = uids[count - 1];

  // The last few seats start the night already finished, so the felt and the
  // room are both populated without walking a cash-out for each of them.
  const roomCount = Math.max(0, Math.min(count - 2, Number(params.get('room')) || 0));
  // slice(-0) is slice(0), which is the whole array — so with no room asked for
  // this quietly moved every seated player into the room and the table read
  // "everyone has left".
  const roomUids = roomCount === 0 ? [] : seated.slice(-roomCount);
  const roomSeed = roomUids.map((uid, i) => ({ userId: uid, amount: 4000 + i * 900 }));

  const session: PokerSession = {
    id: 's1', clubId: 'c1', sessionName: 'Fri 8 Aug', status: 'active',
    // A confirmed cash-out frees the seat on the server, so the harness has to
    // do the same or the winding-down figures count people who have gone.
    activePlayerUids: seated.filter((uid) => !roomUids.includes(uid)),
    pendingSitInUids: [], sitInRequestedAt: {},
    cashOuts: [
      ...roomSeed.map((c) => ({ ...c, status: 'confirmed' as const, requestedAt: at(20) })),
      ...confirmed.map((c) => ({ ...c, status: 'confirmed' as const, requestedAt: at(1) })),
      ...(cashOut
        ? [{ userId: cashOut.userId, amount: cashOut.amount, status: 'pending' as const, requestedAt: at(0) }]
        : []),
    ],
    startedBy: 'u0', createdAt: at(196),
  };

  const buyIns: BuyInRequest[] = [
    ...seated.map((uid, i) => ({
      id: `b${i}`, sessionId: 's1', clubId: 'c1', userId: uid, userDisplayName: '',
      amount: 3000 + i * 1000, status: 'approved' as const, requestedBy: uid, createdAt: at(180 - i),
    })),
    { id: 'p1', sessionId: 's1', clubId: 'c1', userId: arriving, userDisplayName: '',
      amount: 5000, status: 'pending', requestedBy: arriving, createdAt: at(1) },
    { id: 'p2', sessionId: 's1', clubId: 'c1', userId: uids[1], userDisplayName: '',
      amount: 3000, status: 'pending', requestedBy: uids[1], createdAt: at(3) },
    ...Array.from({ length: extraWaiting }, (_, i) => ({
      id: `px${i}`, sessionId: 's1', clubId: 'c1', userId: uids[(i + 2) % count],
      userDisplayName: '', amount: 2000 + i * 500, status: 'pending' as const,
      // Inside the five-minute window, or the countdown reads 0:00 and the
      // harness looks like a bug rather than a busy queue.
      requestedBy: uids[(i + 2) % count], createdAt: at(1 + i * 0.5),
    })),
    ...(myRequest !== null
      ? [{ id: 'pme', sessionId: 's1', clubId: 'c1', userId: 'me', userDisplayName: '',
           amount: myRequest, status: 'pending' as const, requestedBy: 'me', createdAt: at(0) }]
      : []),
  ];

  const night = deriveNight({ session, buyIns, currentUserId: me, isAdmin: true });

  /*
   * The buy-in ceiling, mirroring getBuyInCeiling on the server:
   * MATCH_HIGHEST means the biggest bank anyone currently holds, and the
   * club's configured maximum only until somebody holds one. It is passed to
   * the sheet and shown there as a limit — never on the felt, and never as a
   * button, because it climbs all night.
   */
  const banks = new Map<string, number>();
  for (const r of buyIns) {
    if (r.status === 'approved') banks.set(r.userId, (banks.get(r.userId) ?? 0) + r.amount);
  }
  const highest = banks.size ? Math.max(...banks.values()) : 0;
  const ceiling = highest > 0 ? highest : (club.maxBuyIn ?? 5000);

  const waiting: WaitingRow[] = withQueue
    ? night.queue.map((q) => ({
        ...q,
        name: users[q.userId]?.displayName ?? 'Player',
        onApprove: () => {},
        onDismiss: () => {},
      }))
    : [];

  return (
    <div className="min-h-screen bg-bg text-text">
      <LiveSession
        club={club}
        session={session}
        night={night}
        currentUserId={me}
        isAdmin
        users={users}
        connection="live"
        waiting={waiting}
        formatAmount={(n) => n.toLocaleString()}
        onStartSession={() => {}}
        onSelectPlayer={setPicked}
        ceiling={ceiling}
        onSettleNight={() => {}}
        onAddPlayer={() => setAddOpen(true)}
      />

      <AddPlayerSheet
        open={addOpen}
        onClose={() => setAddOpen(false)}
        candidates={club.memberUids
          .filter((uid) => ![...night.seats, ...night.room].some((s) => s.userId === uid))
          .map((uid) => ({ userId: uid, name: users[uid]?.displayName ?? 'Player' }))}
        onSelect={(uid) => { setAddOpen(false); setPicked(uid); }}
      />

      {picked && (
        <PlayerSheet
          open
          onClose={() => setPicked(null)}
          name={picked === me ? 'You' : users[picked]?.displayName ?? 'Player'}
          userId={picked}
          seat={[...night.seats, ...night.room].find((s) => s.userId === picked) ?? null}
          isSelf={picked === me}
          isAdmin
          formatAmount={(n) => n.toLocaleString()}
          bankOptions={[club.minBuyIn ?? 1000, 3000, club.maxBuyIn ?? 5000]}
          ceiling={ceiling}
          onJoin={(amount) => { setMyRequest(amount); setPicked(null); }}
          onBuyMore={(amount) => { setMyRequest(amount); setPicked(null); }}
          onStandUp={(amount) => {
            if (picked) setCashOut({ userId: picked, amount });
            setPicked(null);
          }}
          onConfirmCount={(amount) => {
            if (cashOut) setConfirmed((c) => [...c, { userId: cashOut.userId, amount }]);
            setCashOut(null);
            setPicked(null);
          }}
        />
      )}
    </div>
  );
};
