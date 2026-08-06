import React from 'react';
import { PokerTable } from './PokerTable';
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
  const cases: [string, ReturnType<typeof scenario>][] = [
    ['2 — a pair, not an empty ring', scenario(2)],
    ['5', scenario(5)],
    ['9 — labels narrow, targets do not', scenario(9)],
    ['12 — the caption steps aside', scenario(12)],
    ['18 — faces only; the seat still opens', scenario(18)],
    ['pending buy-in — the seat asks', scenario(5, {}, [pending('u2', 3000)])],
    [
      'pending cash-out',
      scenario(5, { cashOuts: [{ userId: 'u3', amount: 8200, status: 'pending', requestedAt: at(1) }] }),
    ],
    [
      'counted out — faded, and still in its chair',
      scenario(5, {
        activePlayerUids: ['u0', 'u1', 'u2', 'u4'],
        cashOuts: [{ userId: 'u3', amount: 8200, status: 'confirmed', requestedAt: at(9) }],
      }),
    ],
    ['seated, no chips yet — nobody has bought in', scenario(4, {}, [], false)],
  ];

  return (
    <div className="min-h-screen bg-bg text-text pb-16">
      {cases.map(([title, { night, users }]) => (
        <section key={title} className="border-b border-line py-4">
          <h2 className="px-5 pb-2 text-xs uppercase tracking-widest text-text-muted">{title}</h2>
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
