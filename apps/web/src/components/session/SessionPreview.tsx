import React, { useState } from 'react';
import { LiveSession } from './LiveSession';
import { PlayerSheet } from './PlayerSheet';
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
  const withQueue = params.get('queue') !== '0';

  const [picked, setPicked] = useState<string | null>(null);
  // Locally applied so the journey is walkable end to end without a server:
  // tapping an amount adds the pending request the API would have created.
  const [myRequest, setMyRequest] = useState<number | null>(null);
  // ?me=out starts the viewer outside the game, which is the only way to see
  // the arrival journey — everything else assumes you are already seated.
  const outside = params.get('me') === 'out';

  const uids = Array.from({ length: count }, (_, i) => `u${i}`);
  const users: Record<string, { displayName?: string }> = Object.fromEntries(
    uids.map((uid, i) => [uid, { displayName: NAMES[i % NAMES.length] }])
  );
  const me = outside ? 'me' : 'u0';
  if (outside) users.me = { displayName: 'You' };

  // Eight seated and banked; the ninth is pulling up a chair, so the felt and
  // the queue are both showing something real.
  const seated = uids.slice(0, count - 1);
  const arriving = uids[count - 1];

  const session: PokerSession = {
    id: 's1', clubId: 'c1', sessionName: 'Fri 8 Aug', status: 'active',
    activePlayerUids: seated, pendingSitInUids: [], sitInRequestedAt: {}, cashOuts: [],
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
      />

      {picked && (
        <PlayerSheet
          open
          onClose={() => setPicked(null)}
          name={picked === me ? 'You' : users[picked]?.displayName ?? 'Player'}
          userId={picked}
          seat={night.seats.find((s) => s.userId === picked) ?? null}
          isSelf={picked === me}
          isAdmin
          formatAmount={(n) => n.toLocaleString()}
          bankOptions={[club.minBuyIn ?? 1000, 3000, club.maxBuyIn ?? 5000]}
          ceiling={ceiling}
          onJoin={(amount) => { setMyRequest(amount); setPicked(null); }}
          onBuyMore={(amount) => { setMyRequest(amount); setPicked(null); }}
          onStandUp={() => setPicked(null)}
          onConfirmCount={() => setPicked(null)}
        />
      )}
    </div>
  );
};
