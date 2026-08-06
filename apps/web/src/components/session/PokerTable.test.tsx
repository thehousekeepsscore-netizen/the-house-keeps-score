import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PokerTable } from './PokerTable';
import { deriveNight } from '../../lib/night-state';
import { PokerSession, BuyInRequest } from '../../types';

const NOW = Date.parse('2026-08-06T21:00:00.000Z');
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();
const fmt = (n: number) => n.toLocaleString();

function buyIn(userId: string, amount = 5000, over: Partial<BuyInRequest> = {}): BuyInRequest {
  return {
    id: `b-${userId}-${amount}-${over.status ?? 'approved'}`,
    sessionId: 's1', clubId: 'c1', userId, userDisplayName: '',
    amount, status: 'approved', requestedBy: userId, createdAt: ago(90),
    ...over,
  };
}

function table(over: Partial<PokerSession>, buyIns: BuyInRequest[], currentUserId = 'p1') {
  const session: PokerSession = {
    id: 's1', clubId: 'c1', sessionName: 'Fri 8 Aug', status: 'active',
    activePlayerUids: [], pendingSitInUids: [], sitInRequestedAt: {}, cashOuts: [],
    startedBy: 'p1', createdAt: ago(200), ...over,
  };
  const night = deriveNight({ session, buyIns, currentUserId, isAdmin: true, now: NOW });
  const users = Object.fromEntries(
    night.seats.map((s) => [s.userId, { displayName: `Player ${s.userId.slice(1)}` }])
  );
  const onSelectPlayer = vi.fn();
  render(
    <PokerTable
      night={night}
      currentUserId={currentUserId}
      users={users}
      onSelectPlayer={onSelectPlayer}
      formatAmount={fmt}
    />
  );
  return { night, onSelectPlayer };
}

/** Every seat is a button, so the accessible name carries the whole seat. */
const seatNames = () => screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? '');

describe('adapts from 2 to 9 without overlapping', () => {
  for (const n of [2, 5, 9]) {
    it(`seats ${n} players`, () => {
      const uids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
      table({ activePlayerUids: uids }, uids.map((u, i) => buyIn(u, 5000, { createdAt: ago(90 - i) })));
      expect(screen.getAllByRole('button')).toHaveLength(n);
    });
  }

  it('keeps every seat box inside the arc it was given', () => {
    // Non-overlap is a property of the geometry, not something that happened
    // to hold at the counts we tried: the box is clamped to the spacing, so
    // adding a player narrows labels rather than colliding them.
    const uids = Array.from({ length: 9 }, (_, i) => `p${i + 1}`);
    table({ activePlayerUids: uids }, uids.map((u, i) => buyIn(u, 5000, { createdAt: ago(90 - i) })));
    const widths = screen.getAllByRole('button').map((b) => parseFloat((b as HTMLElement).style.width));
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBeLessThanOrEqual(96);
  });

  it('leaves room between neighbours in the vertical axis too, at any count', () => {
    // Found on screen, not in review. Clamping width alone looked sufficient —
    // width is the axis that appears to be the problem — but near the left and
    // right of the ellipse the arc runs vertically, so at nine players a
    // caption sat under its neighbour's chip while every box was comfortably
    // narrow. Non-overlap has to be checked on the axis that actually collides.
    //
    // Past nine matters because nothing in the data caps a table at nine: the
    // seat shrinks and says less rather than the ring developing a cliff.
    // Mirrors felt() and perimeter() in the component: a stadium, so the gap
    // between neighbours is the perimeter divided by the count — identical
    // wherever they sit, which is the point of walking by arc length.
    const feltFor = (n: number) =>
      n <= 2 ? { w: 38, r: 64 } : n <= 4 ? { w: 46, r: 62 }
        : n <= 6 ? { w: 54, r: 62 } : n <= 9 ? { w: 64, r: 62 } : { w: 72, r: 58 };
    const gapFor = (n: number) => {
      const { w, r } = feltFor(n);
      return (4 * w + 2 * Math.PI * r) / n;
    };

    for (const n of [5, 7, 9, 11, 14, 20]) {
      document.body.innerHTML = '';
      const uids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
      table({ activePlayerUids: uids }, uids.map((u, i) => buyIn(u, 5000, { createdAt: ago(200 - i) })));

      const box = screen.getAllByRole('button')[0] as HTMLElement;
      const width = parseFloat(box.style.width);
      // Neighbours are one gap apart in every direction on a stadium, so the
      // box must fit inside it — this is the non-overlap guarantee, measured.
      expect(width).toBeLessThanOrEqual(gapFor(n));
      expect(screen.getAllByRole('button')).toHaveLength(n);
      document.body.innerHTML = '';
    }
  });

  it('says less per seat as the table fills, rather than overlapping', () => {
    // Ten and up drops the caption; fifteen and up leaves the face alone.
    document.body.innerHTML = '';
    table({ activePlayerUids: ['p1', 'p2', 'p3'] }, ['p1', 'p2', 'p3'].map((u, i) => buyIn(u, 5000, { createdAt: ago(90 - i) })));
    expect(screen.getByText('Player 2')).toBeInTheDocument();
    expect(screen.getAllByText('5,000').length).toBeGreaterThan(0);

    document.body.innerHTML = '';
    const twelve = Array.from({ length: 12 }, (_, i) => `p${i + 1}`);
    table({ activePlayerUids: twelve }, twelve.map((u, i) => buyIn(u, 5000, { createdAt: ago(200 - i) })));
    expect(screen.getByText('Player 2')).toBeInTheDocument();
    expect(screen.queryAllByText('5,000')).toHaveLength(0);

    document.body.innerHTML = '';
    const twenty = Array.from({ length: 20 }, (_, i) => `p${i + 1}`);
    table({ activePlayerUids: twenty }, twenty.map((u, i) => buyIn(u, 5000, { createdAt: ago(300 - i) })));
    expect(screen.queryByText('Player 2')).not.toBeInTheDocument();
    // The seat still carries everything for a screen reader, and still opens.
    expect(seatNames()[1]).toMatch(/Player 2, in 5,000/);
  });

  it('never gives a seat a target below the 44px minimum', () => {
    const uids = Array.from({ length: 9 }, (_, i) => `p${i + 1}`);
    table({ activePlayerUids: uids }, uids.map((u, i) => buyIn(u, 5000, { createdAt: ago(90 - i) })));
    const heights = screen.getAllByRole('button').map((b) => parseFloat((b as HTMLElement).style.minHeight));
    heights.forEach((h) => expect(h).toBeGreaterThanOrEqual(44));
  });
});

describe('the viewer sits at the bottom', () => {
  it('rotates the ring so the viewer is first, without reordering anyone else', () => {
    const uids = ['p1', 'p2', 'p3', 'p4'];
    const buyIns = uids.map((u, i) => buyIn(u, 5000, { createdAt: ago(90 - i) }));
    table({ activePlayerUids: uids }, buyIns, 'p3');
    // Arrival order is p1..p4; from p3's chair it reads p3, p4, p1, p2.
    expect(seatNames().map((l) => l.split(',')[0])).toEqual([
      'You', 'Player 4', 'Player 1', 'Player 2',
    ]);
  });
});

describe('a seat says what it is doing', () => {
  it('in play — the bank', () => {
    table({ activePlayerUids: ['p1'] }, [buyIn('p1', 8000)]);
    expect(seatNames()[0]).toMatch(/8,000/);
  });

  it('waiting for chips — a question, never a chip count', () => {
    table({ activePlayerUids: ['p1'] }, [buyIn('p1', 3000, { status: 'pending' })]);
    // Two renderings of one vocabulary: the felt has ~90px per seat so it shows
    // the caption, while the accessible name carries the full sentence. Both
    // ask about the player; neither counts chips they do not have.
    expect(seatNames()[0]).toMatch(/asked for 3,000/i);
    expect(screen.getByText(/wants 3,000/i)).toBeInTheDocument();
    expect(seatNames()[0]).not.toMatch(/\bin 0\b/i);
  });

  it('seated with no chips yet', () => {
    table({ activePlayerUids: ['p1'] }, []);
    expect(seatNames()[0]).toMatch(/no chips yet/i);
  });

  it('waiting for a seat', () => {
    table({ pendingSitInUids: ['p1'], sitInRequestedAt: { p1: ago(1) } }, []);
    expect(seatNames()[0]).toMatch(/wants a seat/i);
  });

  it('counting out', () => {
    table(
      {
        activePlayerUids: ['p1'],
        cashOuts: [{ userId: 'p1', amount: 8200, status: 'pending', requestedAt: ago(1) }],
      },
      [buyIn('p1')]
    );
    expect(seatNames()[0]).toMatch(/counting out/i);
  });

  it('counted out — past tense, and still at the table', () => {
    table(
      {
        activePlayerUids: ['p2'],
        cashOuts: [{ userId: 'p1', amount: 8200, status: 'confirmed', requestedAt: ago(9) }],
      },
      [buyIn('p1'), buyIn('p2', 5000, { createdAt: ago(80) })]
    );
    const names = seatNames();
    expect(names).toHaveLength(2);
    expect(names.join(' ')).toMatch(/out 8,200/i);
  });
});

describe('the ring never reflows', () => {
  it('holds every seat in place when a player is counted out', () => {
    // The rule the felt has to keep. If seats moved when someone left, the
    // whole table would rearrange during the ten minutes when everyone is
    // leaving at once — which is exactly when a moving control is worst.
    const buyIns = [
      buyIn('p1', 5000, { createdAt: ago(90) }),
      buyIn('p2', 5000, { createdAt: ago(80) }),
      buyIn('p3', 5000, { createdAt: ago(70) }),
    ];
    table({ activePlayerUids: ['p1', 'p2', 'p3'] }, buyIns);
    const before = seatNames().map((l) => l.split(',')[0]);

    screen.getAllByRole('button').forEach((b) => b.remove());
    table(
      {
        activePlayerUids: ['p1', 'p3'],
        cashOuts: [{ userId: 'p2', amount: 7000, status: 'confirmed', requestedAt: ago(2) }],
      },
      buyIns
    );
    const after = seatNames().map((l) => l.split(',')[0]);

    expect(after).toEqual(before);
  });
});

describe('money lives on the felt', () => {
  it('shows what is in play in the middle, where the space is empty anyway', () => {
    table({ activePlayerUids: ['p1', 'p2'] }, [buyIn('p1', 5000), buyIn('p2', 3000)]);
    expect(screen.getByText('8,000')).toBeInTheDocument();
  });

  it('stops counting chips that have left with their owner', () => {
    table(
      {
        activePlayerUids: ['p1'],
        cashOuts: [{ userId: 'p2', amount: 4000, status: 'confirmed', requestedAt: ago(9) }],
      },
      [buyIn('p1', 5000), buyIn('p2', 3000, { createdAt: ago(80) })]
    );
    expect(screen.getByText('4,000')).toBeInTheDocument();
  });
});

describe('every action begins with a person', () => {
  it('selects the player behind the seat', async () => {
    const { onSelectPlayer } = table({ activePlayerUids: ['p1', 'p2'] }, [
      buyIn('p1'), buyIn('p2', 5000, { createdAt: ago(80) }),
    ]);
    await userEvent.click(screen.getByRole('button', { name: /Player 2/ }));
    expect(onSelectPlayer).toHaveBeenCalledWith('p2');
  });
});
