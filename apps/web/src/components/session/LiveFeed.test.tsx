import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { LiveFeed } from './LiveFeed';
import { FeedEvent } from '../../lib/night-feed';

/**
 * The bottom half of a player's screen, alive.
 *
 * The rule these tests exist to hold is the motion one: exactly one line may
 * move, and only when it is genuinely new. This region changes on its own while
 * nobody is looking at it, which is precisely when several things animating at
 * once is worst (PRODUCT-BRIEF §2.6 — the eye never has to choose).
 */

const fmt = (n: number) => n.toLocaleString();
const nameOf = (uid: string) => (uid === 'me' ? 'You' : uid === 'arjun' ? 'Arjun' : 'Tara');

const at = (secsAgo: number) => new Date(Date.now() - secsAgo * 1000).toISOString();

const events: FeedEvent[] = [
  { id: 'e3', kind: 'joined', at: at(2), userId: 'tara' },
  { id: 'e2', kind: 'topped-up', at: at(18), userId: 'arjun', amount: 3000 },
  { id: 'e1', kind: 'bought-in', at: at(90), userId: 'me', amount: 5000 },
];

const rows = () => screen.getAllByRole('listitem');
const animated = () => rows().filter((li) => /animate-\[feed-in/.test(li.className));

describe('the story reads top down', () => {
  it('puts the newest first and says how long ago each was', () => {
    render(<LiveFeed events={events} nameOf={nameOf} formatAmount={fmt} />);
    const text = rows().map((li) => li.textContent);
    expect(text[0]).toMatch(/Tara joined the table/);
    expect(text[0]).toMatch(/just now|2 sec ago/);
    expect(text[1]).toMatch(/Arjun bought another 3,000/);
    expect(text[2]).toMatch(/You bought in for 5,000/);
  });

  it('renders nothing at all when a night has no story yet', () => {
    const { container } = render(<LiveFeed events={[]} nameOf={nameOf} formatAmount={fmt} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not announce itself to a screen reader', () => {
    // A live region here would read every buy-in aloud over the top of the
    // actual room, all evening. The feed is a place you look.
    const { container } = render(<LiveFeed events={events} nameOf={nameOf} formatAmount={fmt} />);
    expect(container.querySelector('[aria-live]')).toBeNull();
  });

  it('scrolls inside itself rather than pushing the table around', () => {
    const { container } = render(<LiveFeed events={events} nameOf={nameOf} formatAmount={fmt} />);
    expect(container.querySelector('ul')?.className).toMatch(/overflow-y-auto/);
  });
});

describe('only one thing moves', () => {
  it('animates nothing on first paint', () => {
    // Arriving at a table is not an event. Animating the whole list on open
    // would make the one thing that matters — a new line — indistinguishable.
    render(<LiveFeed events={events} nameOf={nameOf} formatAmount={fmt} />);
    expect(animated()).toHaveLength(0);
  });

  it('animates the new line, and only that line', () => {
    const { rerender } = render(<LiveFeed events={events} nameOf={nameOf} formatAmount={fmt} />);
    const arrived: FeedEvent = { id: 'e4', kind: 'stood-up', at: at(0), userId: 'arjun', amount: 7200 };
    rerender(<LiveFeed events={[arrived, ...events]} nameOf={nameOf} formatAmount={fmt} />);

    const moving = animated();
    expect(moving).toHaveLength(1);
    expect(moving[0]).toHaveTextContent(/Arjun stood up with 7,200/);
  });

  it('stops animating it once it is no longer the newest', () => {
    const { rerender } = render(<LiveFeed events={events} nameOf={nameOf} formatAmount={fmt} />);
    const first: FeedEvent = { id: 'e4', kind: 'joined', at: at(1), userId: 'tara' };
    rerender(<LiveFeed events={[first, ...events]} nameOf={nameOf} formatAmount={fmt} />);

    const second: FeedEvent = { id: 'e5', kind: 'joined', at: at(0), userId: 'arjun' };
    rerender(<LiveFeed events={[second, first, ...events]} nameOf={nameOf} formatAmount={fmt} />);

    const moving = animated();
    expect(moving).toHaveLength(1);
    expect(moving[0]).toHaveTextContent(/Arjun joined/);
  });

  it('does not re-animate when only the clock ticks', () => {
    // The labels re-render every ten seconds. If that counted as "new", the
    // top line would twitch forever.
    const { rerender } = render(<LiveFeed events={events} nameOf={nameOf} formatAmount={fmt} />);
    rerender(<LiveFeed events={[...events]} nameOf={nameOf} formatAmount={fmt} />);
    expect(animated()).toHaveLength(0);
  });
});

describe('every line carries a glyph', () => {
  it('marks each kind with its own, since a feed is scanned down its left edge', () => {
    // Line icons now, not emoji: the feed was the one region the room could
    // not light — emoji arrive pre-coloured, differently on every phone at
    // the table. Distinctness per kind is still the property under test,
    // asserted on the rendered SVG geometry rather than on characters.
    render(<LiveFeed events={events} nameOf={nameOf} formatAmount={fmt} />);
    const glyphs = rows().map((li) => li.querySelector('svg')?.innerHTML);
    expect(glyphs.every(Boolean)).toBe(true);
    expect(new Set(glyphs).size).toBe(3);
    // And none of them is an emoji character.
    for (const li of rows()) {
      expect(within(li).queryByText(/\p{Extended_Pictographic}/u)).toBeNull();
    }
  });
});
