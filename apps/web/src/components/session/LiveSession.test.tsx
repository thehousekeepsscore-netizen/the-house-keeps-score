import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LiveSession, LiveSessionProps } from './LiveSession';
import { deriveNight } from '../../lib/night-state';
import { Club, PokerSession, BuyInRequest } from '../../types';

/**
 * The screen renders the specification in LIVE-SESSION-INTERACTION-MODEL.md.
 * These tests assert the claims that document makes, so a regression shows up
 * as a contradiction with the design rather than as a diff nobody can judge.
 */

const NOW = Date.parse('2026-08-06T21:00:00.000Z');
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();

const club = {
  id: 'c1',
  name: 'Friday Night',
  memberUids: ['host', 'priya', 'arjun'],
  adminUids: [],
  memberCount: 3,
  adminCount: 1,
  isMember: true,
  isAdmin: true,
  isOwner: true,
  createdBy: 'host',
  createdAt: ago(9999),
  maxCapacity: 50,
} as unknown as Club;

function session(over: Partial<PokerSession> = {}): PokerSession {
  return {
    id: 's1',
    clubId: 'c1',
    sessionName: 'Fri 8 Aug',
    status: 'active',
    activePlayerUids: [],
    pendingSitInUids: [],
    sitInRequestedAt: {},
    cashOuts: [],
    startedBy: 'host',
    createdAt: ago(250),
    ...over,
  };
}

function renderScreen(over: Partial<LiveSessionProps> = {}, buyIns: BuyInRequest[] = []) {
  const s = over.session === undefined ? session() : over.session;
  const props: LiveSessionProps = {
    club,
    session: s,
    night: deriveNight({
      session: s,
      buyIns,
      currentUserId: over.currentUserId ?? 'host',
      isAdmin: over.isAdmin ?? true,
      now: NOW,
    }),
    currentUserId: 'host',
    isAdmin: true,
    users: { host: { displayName: 'Rahul' }, priya: { displayName: 'Priya' }, arjun: { displayName: 'Arjun' } },
    connection: 'live',
    formatAmount: (n: number) => n.toLocaleString(),
    onStartSession: vi.fn(),
    onSelectPlayer: vi.fn(),
    ...over,
  };
  render(<LiveSession {...props} />);
  return props;
}

describe('zone A — identity and vitals', () => {
  it('never renders the club name — the club screen above it already owns that', () => {
    // Found on screen, not in review: this component mounts inside a club
    // screen whose header already carries the name, so printing it here put it
    // up twice — the exact defect PRODUCT-BRIEF §14 exists to remove.
    renderScreen();
    expect(screen.queryByText('Friday Night')).not.toBeInTheDocument();
  });

  it('owns the session identity', () => {
    renderScreen();
    expect(screen.getByText('Fri 8 Aug')).toBeInTheDocument();
  });

  it('says nothing about the connection while it is live', () => {
    // A permanent green dot describes nothing. The indicator exists to
    // describe failure, because silence is the failure mode.
    renderScreen({ connection: 'live' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('warns that the table may be stale when the socket drops', () => {
    renderScreen({ connection: 'reconnecting' });
    expect(screen.getByRole('status')).toHaveTextContent(/out of date/i);
  });
});

describe('phases', () => {
  it('offers an admin the one control that matters when nothing is running', () => {
    const props = renderScreen({ session: null });
    expect(screen.getByRole('button', { name: /start tonight/i })).toBeInTheDocument();
    expect(props.night.phase).toBe('dark');
  });

  it('does not offer a player a control they cannot use', () => {
    renderScreen({ session: null, isAdmin: false });
    expect(screen.queryByRole('button', { name: /start tonight/i })).not.toBeInTheDocument();
    // The club is not "closed" to them — it just isn't playing.
    expect(screen.getByText(/no session running/i)).toBeInTheDocument();
  });

  it('opens on the guest list, not a scoreboard of zeros', () => {
    renderScreen({ session: session({ activePlayerUids: ['host'] }) });
    expect(screen.getByText(/who's playing/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /priya/i })).toBeInTheDocument();
  });

  it('says everyone has left, and offers exactly one action', () => {
    renderScreen({
      session: session({
        activePlayerUids: [],
        cashOuts: [
          { userId: 'priya', amount: 8200, status: 'confirmed', requestedAt: ago(9) },
          { userId: 'arjun', amount: 4100, status: 'confirmed', requestedAt: ago(5) },
        ],
      }),
    });
    expect(screen.getByText(/everyone has left/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /review & settle/i })).toBeInTheDocument();
  });

  it('replaces the settle control with the reason when a night cannot settle', () => {
    // Not a disabled button. The server has always rejected a one-player
    // night; the old screen discovered it on submit.
    renderScreen({
      session: session({
        activePlayerUids: [],
        cashOuts: [{ userId: 'priya', amount: 8200, status: 'confirmed', requestedAt: ago(9) }],
      }),
    });
    expect(screen.getByText(/at least two players/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /review & settle/i })).not.toBeInTheDocument();
  });
});

describe('zone C — the next action', () => {
  it('is absent while a night is simply being played', () => {
    // The honest answer to "what should I do next?" is nothing, so the bar
    // does not exist and the table keeps those pixels.
    renderScreen(
      { session: session({ activePlayerUids: ['host', 'priya'] }) },
      [
        {
          id: 'b1', sessionId: 's1', clubId: 'c1', userId: 'priya', userDisplayName: '',
          amount: 5000, status: 'approved', requestedBy: 'priya', createdAt: ago(60),
        },
      ]
    );
    expect(screen.queryByRole('button', { name: /start tonight|review & settle/i })).not.toBeInTheDocument();
  });
});

describe('seat vocabulary', () => {
  it('describes a pending request as a question, never as a chip count', () => {
    // The bug this replaces: "Arjun · 0 Chips" — true, and useless.
    renderScreen(
      { session: session({ activePlayerUids: ['arjun'] }) },
      [
        {
          id: 'b1', sessionId: 's1', clubId: 'c1', userId: 'arjun', userDisplayName: '',
          amount: 3000, status: 'pending', requestedBy: 'arjun', createdAt: ago(1),
        },
      ]
    );
    expect(screen.getByText(/asked for 3,000/i)).toBeInTheDocument();
    expect(screen.queryByText(/^in 0$/i)).not.toBeInTheDocument();
  });

  it('keeps waiting, in play and counted out as three different sentences', () => {
    renderScreen(
      {
        session: session({
          activePlayerUids: ['host'],
          pendingSitInUids: ['priya'],
          sitInRequestedAt: { priya: ago(1) },
          cashOuts: [{ userId: 'arjun', amount: 4100, status: 'confirmed', requestedAt: ago(5) }],
        }),
      },
      [
        {
          id: 'b1', sessionId: 's1', clubId: 'c1', userId: 'host', userDisplayName: '',
          amount: 5000, status: 'approved', requestedBy: 'host', createdAt: ago(60),
        },
      ]
    );
    // The running phase renders the felt, so the seat carries the short form
    // and its accessible name carries the sentence — two renderings of one
    // vocabulary (lib/seat-vocabulary.ts), so they cannot drift apart.
    const seats = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? '');
    expect(seats.join(' | ')).toMatch(/wants a seat/i);
    expect(seats.join(' | ')).toMatch(/in 5,000/i);
    expect(seats.join(' | ')).toMatch(/counted out 4,100/i);
  });
});

describe('every player is the way in', () => {
  it('selects a player rather than exposing a generic control', () => {
    const onSelectPlayer = vi.fn();
    renderScreen({ session: session({ activePlayerUids: ['host'] }), onSelectPlayer });
    return userEvent.click(screen.getByRole('button', { name: /priya/i })).then(() => {
      expect(onSelectPlayer).toHaveBeenCalledWith('priya');
    });
  });
});
