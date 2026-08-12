import React from 'react';
import { PokerTable } from './PokerTable';
import { WaitingForYou, WaitingRow } from './WaitingForYou';
import { deriveNight } from '../../lib/night-state';
import { PokerSession, BuyInRequest } from '../../types';

/**
 * Every seat count and every seat state, on one page.
 *
 * Developer instrumentation, in the same spirit as /debug/performance: unlinked
 * from the UI and inside the authenticated tree. It exists because the felt is
 * the one part of this app whose correctness is geometric — seats must not
 * overlap at nine, two players must read as a pair rather than as an empty
 * ring, and the states have to be distinguishable at a glance in a dim room.
 * None of that is answerable from a unit test, and a real club rarely has nine
 * players and a pending cash-out at the same moment.
 */

const NAMES = ['Priya', 'Arjun', 'Sam', 'Meera', 'Ishaan', 'Nikhil', 'Rhea', 'Kabir', 'Tara',
  'Dev', 'Anya', 'Vikram', 'Sana', 'Omar', 'Leela', 'Zaid', 'Nina', 'Rohit'];
const at = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

function scenario(
  count: number,
  over: Partial<PokerSession> = {},
  extra: BuyInRequest[] = [],
  bank = true
) {
  const uids = Array.from({ length: count }, (_, i) => `u${i}`);
  const session: PokerSession = {
    id: 's1', clubId: 'c1', sessionName: 'Preview', status: 'active',
    activePlayerUids: uids, pendingSitInUids: [], sitInRequestedAt: {}, cashOuts: [],
    startedBy: 'u0', createdAt: at(200), ...over,
  };
  const buyIns: BuyInRequest[] = (bank ? uids : []).map((uid, i) => ({
    id: `b${i}`, sessionId: 's1', clubId: 'c1', userId: uid, userDisplayName: '',
    amount: 3000 + i * 1000, status: 'approved', requestedBy: uid, createdAt: at(180 - i),
  }));
  const users = Object.fromEntries(uids.map((uid, i) => [uid, { displayName: NAMES[i] }]));
  return { night: deriveNight({ session, buyIns: [...buyIns, ...extra], currentUserId: 'u0', isAdmin: true }), users };
}

const pending = (uid: string, amount: number): BuyInRequest => ({
  id: `p-${uid}`, sessionId: 's1', clubId: 'c1', userId: uid, userDisplayName: '',
  amount, status: 'pending', requestedBy: uid, createdAt: at(2),
});

export const TablePreview: React.FC = () => {
  // ?only=18 renders a single case, for iterating on one count without
  // scrolling past the others.
  const only = new URLSearchParams(window.location.search).get('only');

  const cases: [string, ReturnType<typeof scenario>][] = [
    ['2', scenario(2)],
    ['3', scenario(3)],
    ['4', scenario(4)],
    ['5', scenario(5)],
    ['6', scenario(6)],
    ['8', scenario(8)],
    ['9', scenario(9)],
    ['12', scenario(12)],
    ['13', scenario(13)],
    ['18', scenario(18)],
    ['pending buy-in', scenario(6, {}, [pending('u2', 3000)])],
    [
      'pending cash-out',
      scenario(6, { cashOuts: [{ userId: 'u3', amount: 8200, status: 'pending', requestedAt: at(1) }] }),
    ],
    [
      'counted out',
      scenario(6, {
        activePlayerUids: ['u0', 'u1', 'u2', 'u4', 'u5'],
        cashOuts: [{ userId: 'u3', amount: 8200, status: 'confirmed', requestedAt: at(9) }],
      }),
    ],
    ['seated, no chips yet', scenario(4, {}, [], false)],
  ];

  const shown = only ? cases.filter(([t]) => t === only || t.startsWith(only + ' ')) : cases;

  // One queue, three kinds of person. Rendered here because the phrasing is
  // the feature and it has to be read, not asserted.
  const waiting: WaitingRow[] = [
    { id: 'w1', kind: 'buy-in', userId: 'u1', joining: true, amount: 5000,
      waitingMs: 48_000, name: 'Priya', onApprove: () => {}, onDismiss: () => {} },
    { id: 'w2', kind: 'buy-in', userId: 'u2', joining: false, amount: 3000,
      waitingMs: 3 * 60_000, name: 'Rahul', onApprove: () => {}, onDismiss: () => {} },
    { id: 'w3', kind: 'cash-out', userId: 'u3', joining: false, amount: 7200,
      waitingMs: 4 * 60_000 + 13_000, name: 'Arjun', onApprove: () => {}, onDismiss: () => {} },
    { id: 'w4', kind: 'buy-in', userId: 'u4', joining: false, amount: 3000,
      waitingMs: 2 * 60_000, name: 'You',
      blockedReason: 'Another admin needs to approve this one.',
      onApprove: () => {}, onDismiss: () => {} },
  ];

  return (
    <div className="min-h-screen bg-bg text-text pb-16">
      {(!only || only === 'queue') && (
        <section className="border-b border-line py-4 px-3">
          <h2 className="px-2 pb-2 text-xs text-text-muted">waiting for you</h2>
          <WaitingForYou rows={waiting} formatAmount={(n) => n.toLocaleString()} />
        </section>
      )}
      {shown.map(([title, { night, users }]) => (
        <section key={title} className="border-b border-line py-4">
          <h2 className="px-5 pb-2 text-xs text-text-muted">{title}</h2>
          <PokerTable
            night={night}
            currentUserId="u0"
            users={users}
            onSelectPlayer={() => {}}
            formatAmount={(n) => n.toLocaleString()}
          />
        </section>
      ))}
    </div>
  );
};
