import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, within, fireEvent } from '@testing-library/react';
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
    waiting: [],
    ceiling: 8000,
    onStartSession: vi.fn(),
    onSelectPlayer: vi.fn(),
    onSettleNight: vi.fn(),
    onAddPlayer: vi.fn(),
    feed: [],
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
    expect(screen.getByRole('status')).toHaveTextContent(/reconnecting/i);
  });

  it('says it in one line, because it sits above the felt', () => {
    // The old copy explained the consequence in a full sentence and wrapped to
    // two lines on a 375px screen, pushing the table down to say something the
    // dot and one word already say.
    renderScreen({ connection: 'offline' });
    expect(screen.getByRole('status')).toHaveTextContent(/^Offline — may be out of date$/);
  });

  it('says nothing at all while the socket is fine', () => {
    renderScreen({ connection: 'live' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
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

  /**
   * Opening the table is not starting the game.
   *
   * The screen this replaces went from one tap straight to a live felt with
   * chips in the middle, which was a lie about the room: nobody had joined,
   * nobody had bought in, nobody had agreed to begin.
   */
  it('is a lobby, not a table, until the host starts the night', () => {
    renderScreen({ session: session({ activePlayerUids: ['host'], startedPlayingAt: null }) });
    expect(screen.getByText(/preparing table/i)).toBeInTheDocument();
    // No felt, no chips in the middle, no clock and no story.
    expect(screen.queryByText(/in play/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /tonight, as it happens/i })).not.toBeInTheDocument();
  });

  it('lists everybody and how ready each of them is', () => {
    renderScreen(
      { session: session({ activePlayerUids: ['host', 'priya'], startedPlayingAt: null }) },
      [
        {
          id: 'b1', sessionId: 's1', clubId: 'c1', userId: 'priya', userDisplayName: '',
          amount: 5000, status: 'approved', requestedBy: 'priya', createdAt: ago(9),
        },
      ]
    );
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /priya, ready/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /waiting for buy-in/i })).toBeInTheDocument();
  });

  it('will not start a night on one player, and says why', () => {
    renderScreen(
      { session: session({ activePlayerUids: ['host'], startedPlayingAt: null }) },
      [
        {
          id: 'b1', sessionId: 's1', clubId: 'c1', userId: 'host', userDisplayName: '',
          amount: 5000, status: 'approved', requestedBy: 'host', createdAt: ago(9),
        },
      ]
    );
    expect(screen.queryByRole('button', { name: /start playing/i })).not.toBeInTheDocument();
    expect(screen.getByText(/two players need chips/i)).toBeInTheDocument();
  });

  it('starts on two ready players, not on everybody', () => {
    // Somebody is always still parking. A night that cannot begin until the
    // last arrival has bought in is a night the app is holding up.
    const onStartPlaying = vi.fn();
    renderScreen(
      {
        session: session({ activePlayerUids: ['host', 'priya', 'arjun'], startedPlayingAt: null }),
        onStartPlaying,
      },
      [
        {
          id: 'b1', sessionId: 's1', clubId: 'c1', userId: 'host', userDisplayName: '',
          amount: 5000, status: 'approved', requestedBy: 'host', createdAt: ago(9),
        },
        {
          id: 'b2', sessionId: 's1', clubId: 'c1', userId: 'priya', userDisplayName: '',
          amount: 5000, status: 'approved', requestedBy: 'priya', createdAt: ago(8),
        },
      ]
    );
    return userEvent.click(screen.getByRole('button', { name: /start playing/i })).then(() => {
      expect(onStartPlaying).toHaveBeenCalledTimes(1);
    });
  });

  it('offers no way to start a night to a player', () => {
    renderScreen({
      session: session({ activePlayerUids: ['host'], startedPlayingAt: null }),
      isAdmin: false,
    });
    expect(screen.queryByRole('button', { name: /start playing/i })).not.toBeInTheDocument();
  });

  it('says everyone has left', () => {
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
  });

  it('still states why a night cannot settle, rather than only refusing later', () => {
    // The server has always rejected a one-player night; the old screen
    // discovered it on submit, after every figure had been entered.
    renderScreen({
      session: session({
        activePlayerUids: [],
        cashOuts: [{ userId: 'priya', amount: 8200, status: 'confirmed', requestedAt: ago(9) }],
      }),
    });
    expect(screen.getByText(/at least two players/i)).toBeInTheDocument();
  });
});

describe('the live limit', () => {
  it('states the table maximum without anyone opening anything', () => {
    // It used to exist only inside the join sheet, which meant the way most
    // people discovered the limit was by asking for more and being refused.
    renderScreen({ session: session({ activePlayerUids: ['host'] }), ceiling: 8000 });
    expect(screen.getByText(/max buy-in/i)).toBeInTheDocument();
    expect(screen.getByText('8,000')).toBeInTheDocument();
  });

  it('says so plainly when a club sets no ceiling at all', () => {
    renderScreen({ session: session({ activePlayerUids: ['host'] }), ceiling: null });
    expect(screen.getByText(/no limit/i)).toBeInTheDocument();
  });

  it('says nothing about a limit when no night is running', () => {
    renderScreen({ session: null });
    expect(screen.queryByText(/max buy-in/i)).not.toBeInTheDocument();
  });
});

describe('where settling lives', () => {
  it('is in the same place all night, so it is never hunted for', () => {
    // Deliberately not phase-dependent. It used to appear as "Review & settle"
    // only once everyone had left; a control that moves by phase is a control
    // you search for at 2am.
    for (const uids of [['host', 'priya'], ['host']]) {
      renderScreen({ session: session({ activePlayerUids: uids }) });
      expect(screen.getByRole('button', { name: /settle night/i })).toBeInTheDocument();
      cleanup();
    }
  });

  it('is not offered to a player', () => {
    renderScreen({ session: session({ activePlayerUids: ['host', 'priya'] }), isAdmin: false });
    expect(screen.queryByRole('button', { name: /settle night/i })).not.toBeInTheDocument();
  });

  it('is absent before a night starts, when there is nothing to settle', () => {
    renderScreen({ session: null });
    expect(screen.queryByRole('button', { name: /settle night/i })).not.toBeInTheDocument();
  });
});

describe('zone C — the next action', () => {
  it('offers the way in to someone with no seat, since they have nothing to tap', () => {
    const onSelectPlayer = vi.fn();
    renderScreen(
      { session: session({ activePlayerUids: ['priya'] }), currentUserId: 'host', onSelectPlayer },
      [
        {
          id: 'b1', sessionId: 's1', clubId: 'c1', userId: 'priya', userDisplayName: '',
          amount: 5000, status: 'approved', requestedBy: 'priya', createdAt: ago(60),
        },
      ]
    );
    return userEvent.click(screen.getByRole('button', { name: /join table/i })).then(() => {
      // The bar opens their own sheet — every action still originates there.
      expect(onSelectPlayer).toHaveBeenCalledWith('host');
    });
  });

  it('offers no chair once everyone has left', () => {
    // The host has no seat either at that point, so the generic "you have no
    // seat" branch would offer the person closing the night a place at an
    // empty table. Settling is in the footer, where it always is.
    renderScreen({
      session: session({
        activePlayerUids: [],
        cashOuts: [
          { userId: 'priya', amount: 8200, status: 'confirmed', requestedAt: ago(9) },
          { userId: 'arjun', amount: 4100, status: 'confirmed', requestedAt: ago(5) },
        ],
      }),
    });
    expect(screen.queryByRole('button', { name: /join table/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /settle night/i })).toBeInTheDocument();
  });

  it('is absent while a night is simply being played', () => {
    // The honest answer to "what should I do next?" is nothing, so the bar
    // does not exist and the table keeps those pixels. The settle footer is a
    // deliberate exception and lives outside this zone.
    renderScreen(
      { session: session({ activePlayerUids: ['host', 'priya'] }) },
      [
        {
          id: 'b1', sessionId: 's1', clubId: 'c1', userId: 'priya', userDisplayName: '',
          amount: 5000, status: 'approved', requestedBy: 'priya', createdAt: ago(60),
        },
      ]
    );
    expect(screen.queryByRole('button', { name: /start tonight|join table/i })).not.toBeInTheDocument();
  });
});

describe('seat vocabulary', () => {
  it('describes a pending request as a question, never as a chip count', () => {
    // The bug this replaces: "Arjun · 0 Chips" — true, and useless.
    renderScreen(
      { session: session({ activePlayerUids: ['arjun'] }) },
      [
        {
          id: 'b0', sessionId: 's1', clubId: 'c1', userId: 'arjun', userDisplayName: '',
          amount: 5000, status: 'approved', requestedBy: 'arjun', createdAt: ago(40),
        },
        {
          id: 'b1', sessionId: 's1', clubId: 'c1', userId: 'arjun', userDisplayName: '',
          amount: 3000, status: 'pending', requestedBy: 'arjun', createdAt: ago(1),
        },
      ]
    );
    // Arjun is already at the table, so this is a top-up, not an arrival. The
    // felt carries the short form and the accessible name the sentence — two
    // renderings of one vocabulary, so they cannot drift apart.
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? '');
    expect(labels.join(' | ')).toMatch(/wants 3,000 more/i);
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
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? '');
    expect(labels.join(' | ')).toMatch(/pulling up a chair/i);
    expect(labels.join(' | ')).toMatch(/in 5,000/i);
    // Arjun's count was agreed, so he is in the room under the table rather
    // than holding a chair on it.
    expect(labels.join(' | ')).toMatch(/cashed out with 4,100/i);
  });
});

/**
 * People who have finished, and are still here.
 *
 * Leaving them on the felt kept a chair warm for somebody who had pushed it
 * back; deleting them said the night had never included them. The room is the
 * third answer, and it is the one a real table gives.
 */
describe('the room under the table', () => {
  const settled = () =>
    renderScreen(
      {
        session: session({
          activePlayerUids: ['host'],
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

  it('shows what someone left with, quietly, once their count is agreed', () => {
    settled();
    expect(screen.getByRole('group', { name: /at the table/i })).toBeInTheDocument();
    const room = screen.getByRole('region', { name: /1 in the room/i });
    expect(room).toHaveTextContent(/arjun/i);
    expect(room).toHaveTextContent('4,100');
  });

  it('is the same way in as a seat, so rejoining needs no special path', async () => {
    const { onSelectPlayer } = settled();
    const room = screen.getByRole('region', { name: /1 in the room/i });
    await userEvent.click(within(room).getByRole('button', { name: /arjun/i }));
    expect(onSelectPlayer).toHaveBeenCalledWith('arjun');
  });

  it('is absent while everyone is still playing', () => {
    renderScreen({ session: session({ activePlayerUids: ['host', 'priya'] }) });
    expect(screen.queryByRole('region', { name: /in the room/i })).not.toBeInTheDocument();
  });
});

/**
 * The brass stud: one control, one meaning — chips onto this table.
 *
 * Two subjects, though. An admin can bank anybody, so they are asked whose; a
 * player is the answer already. It was admin-only when it was built, which put
 * a host's tool in the middle of everybody's table and left a player's only
 * route to chips as working out that their own face was a button.
 */
describe('the stud on the felt', () => {
  // It lives on the felt, so the night has to have reached it — the arrival
  // phase is a guest list, and every name on it is already tappable.
  const running = (over: Partial<LiveSessionProps> = {}) =>
    renderScreen(
      { session: session({ activePlayerUids: ['host', 'priya'] }), ...over },
      [
        {
          id: 'b1', sessionId: 's1', clubId: 'c1', userId: 'priya', userDisplayName: '',
          amount: 5000, status: 'approved', requestedBy: 'priya', createdAt: ago(60),
        },
      ]
    );

  it('asks an admin who the chips are for', async () => {
    const onAddPlayer = vi.fn();
    running({ onAddPlayer });
    await userEvent.click(screen.getByRole('button', { name: /add a player/i }));
    expect(onAddPlayer).toHaveBeenCalledTimes(1);
  });

  it('takes a player straight to the amount, since they are the answer', async () => {
    const onAskForChips = vi.fn();
    const onAddPlayer = vi.fn();
    running({ isAdmin: false, onAskForChips, onAddPlayer });

    await userEvent.click(screen.getByRole('button', { name: /ask for bank/i }));
    expect(onAskForChips).toHaveBeenCalledTimes(1);
    // A player is never offered the pick-a-person step, even if the handler is
    // threaded down to them.
    expect(onAddPlayer).not.toHaveBeenCalled();
  });

  it('names the act, which is not the same act at every seat', () => {
    // Same tap, same sheet, different thing happening: somebody with no chair
    // is joining, and only somebody already in one is topping up.
    running({ isAdmin: false, currentUserId: 'host', onAskForChips: vi.fn() });
    expect(screen.getByRole('button', { name: /ask for bank/i })).toBeInTheDocument();
    cleanup();

    renderScreen(
      { session: session({ activePlayerUids: ['priya'] }), currentUserId: 'host', isAdmin: false, onAskForChips: vi.fn() },
      [
        {
          id: 'b1', sessionId: 's1', clubId: 'c1', userId: 'priya', userDisplayName: '',
          amount: 5000, status: 'approved', requestedBy: 'priya', createdAt: ago(60),
        },
      ]
    );
    expect(screen.getByRole('button', { name: /join the table/i })).toBeInTheDocument();
  });

  it('never asks an admin to pick when there is nobody to pick', () => {
    // Absent rather than dead. A stud that opened an empty list would be a
    // control that lies about having something behind it.
    running({ onAddPlayer: undefined, onAskForChips: undefined });
    expect(screen.queryByRole('button', { name: /add a player|ask for chips/i })).not.toBeInTheDocument();
  });
});

describe('every player is the way in', () => {
  it('selects a player rather than exposing a generic control', () => {
    const onSelectPlayer = vi.fn();
    renderScreen(
      { session: session({ activePlayerUids: ['host', 'priya'] }), onSelectPlayer },
      [
        {
          id: 'b1', sessionId: 's1', clubId: 'c1', userId: 'priya', userDisplayName: '',
          amount: 5000, status: 'approved', requestedBy: 'priya', createdAt: ago(9),
        },
      ]
    );
    return userEvent.click(screen.getByRole('button', { name: /priya/i })).then(() => {
      expect(onSelectPlayer).toHaveBeenCalledWith('priya');
    });
  });
});

/**
 * Frozen for settlement.
 *
 * Figures cannot be agreed while they are still changing underneath, so the
 * server refuses every mutation once a host starts settling. The screen has to
 * match that: offering Approve and a brass stud that the server will reject is
 * worse than offering nothing.
 */
describe('the table on hold', () => {
  const settling = (over: Partial<LiveSessionProps> = {}) =>
    renderScreen(
      {
        session: session({
          activePlayerUids: ['host', 'priya'],
          settlingAt: ago(1),
        }),
        waiting: [
          {
            id: 'q1', kind: 'buy-in', userId: 'priya', joining: false, amount: 3000,
            requestedAt: ago(1), waitingMs: 4 * 60_000, name: 'Priya',
            onApprove: vi.fn(), onDismiss: vi.fn(),
          },
        ],
        ...over,
      },
      [
        {
          id: 'b1', sessionId: 's1', clubId: 'c1', userId: 'priya', userDisplayName: '',
          amount: 5000, status: 'approved', requestedBy: 'priya', createdAt: ago(60),
        },
      ]
    );

  it('says the table is on hold rather than looking normal', () => {
    settling();
    expect(screen.getByText(/settling up/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing can be bought or cashed out/i)).toBeInTheDocument();
  });

  it('takes the approval queue away, because approving would be refused', () => {
    settling();
    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
  });

  it('takes the chips control off the felt', () => {
    settling();
    expect(
      screen.queryByRole('button', { name: /add a player|ask for chips|join the table/i })
    ).not.toBeInTheDocument();
  });

  it('offers the host the way back, so a mis-tap does not end an evening', async () => {
    const onResumeNight = vi.fn();
    settling({ onResumeNight });
    await userEvent.click(screen.getByRole('button', { name: /back to the table/i }));
    expect(onResumeNight).toHaveBeenCalledTimes(1);
  });

  it('offers a player no way out of it, because it is not theirs to decide', () => {
    settling({ isAdmin: false, onResumeNight: vi.fn() });
    expect(screen.getByText(/settling up/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /back to the table/i })).not.toBeInTheDocument();
  });

  it('does not also show the settle footer, which would be the same tap twice', () => {
    settling();
    expect(screen.queryByRole('button', { name: /settle night/i })).not.toBeInTheDocument();
  });
});

/**
 * The lobby ghost.
 *
 * Rahul says he's in, gets marked ready, then goes home without pressing
 * anything. Nothing else takes him out, so "4 of 6 ready" describes a room with
 * five people in it.
 */
describe('taking somebody out of the lobby', () => {
  const lobby = (over: Partial<LiveSessionProps> = {}) =>
    renderScreen(
      {
        session: session({ activePlayerUids: ['host', 'priya', 'arjun'], startedPlayingAt: null }),
        onRemoveFromLobby: vi.fn(),
        ...over,
      },
      [
        {
          id: 'b1', sessionId: 's1', clubId: 'c1', userId: 'arjun', userDisplayName: '',
          amount: 5000, status: 'approved', requestedBy: 'arjun', createdAt: ago(9),
        },
      ]
    );

  it('offers it for somebody with nothing at stake', async () => {
    const { onRemoveFromLobby } = lobby();
    await userEvent.click(screen.getByRole('button', { name: /remove priya/i }));
    expect(onRemoveFromLobby).toHaveBeenCalledWith('priya');
  });

  it('does NOT offer it for somebody holding chips', () => {
    // Removing them would erase money from the night with no cash-out and no
    // record. That is standing up, and it goes through the count.
    lobby();
    expect(screen.queryByRole('button', { name: /remove arjun/i })).not.toBeInTheDocument();
  });

  it('does not offer it for the admin themselves', () => {
    lobby();
    expect(screen.queryByRole('button', { name: /remove you/i })).not.toBeInTheDocument();
  });

  it('offers it to nobody when the viewer is a player', () => {
    lobby({ isAdmin: false, currentUserId: 'priya' });
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  });
});

/**
 * Every phase of a night still renders.
 *
 * Written when the old screen was deleted and this became the only session
 * experience: with nothing to fall back to, "it renders at all" is worth
 * asserting for each state rather than for the two that happened to have tests.
 *
 * The clock phases use real time rather than the fixture's NOW, because the
 * banner reads Date.now() directly — a night that started 121 real minutes ago
 * is genuinely inside its grace period.
 */
describe('every phase renders', () => {
  const realAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const banked = (uid: string, id: string): BuyInRequest => ({
    id, sessionId: 's1', clubId: 'c1', userId: uid, userDisplayName: '',
    amount: 5000, status: 'approved', requestedBy: uid, createdAt: ago(90),
  });

  it('no session — the table is dark', () => {
    renderScreen({ session: null });
    expect(screen.getByText(/no session running/i)).toBeInTheDocument();
  });

  it('grace period — the plan ran out and nothing stopped', () => {
    renderScreen(
      {
        session: session({
          activePlayerUids: ['host', 'priya'],
          startedPlayingAt: realAgo(121),
          durationMinutes: 120,
        }),
      },
      [banked('host', 'b1'), banked('priya', 'b2')]
    );
    expect(screen.getByText(/time limit reached/i)).toBeInTheDocument();
    expect(screen.getByText(/grace period/i)).toBeInTheDocument();
    // Nothing is locked: the felt is still there and still the hero.
    expect(screen.getByRole('group', { name: /at the table/i })).toBeInTheDocument();
  });

  it('session complete — the host is asked, not told', () => {
    renderScreen(
      {
        session: session({
          activePlayerUids: ['host', 'priya'],
          startedPlayingAt: realAgo(130),
          durationMinutes: 120,
        }),
      },
      [banked('host', 'b1'), banked('priya', 'b2')]
    );
    expect(screen.getByText(/session complete/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue playing/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /settle night/i })).toBeInTheDocument();
  });

  it('settled — the night is a receipt', () => {
    renderScreen({
      session: session({
        status: 'settled',
        activePlayerUids: [],
        cashOuts: [
          { userId: 'priya', amount: 8200, status: 'confirmed', requestedAt: ago(9) },
          { userId: 'arjun', amount: 4100, status: 'confirmed', requestedAt: ago(5) },
        ],
      }),
    });
    expect(screen.getByText(/this night is settled/i)).toBeInTheDocument();
    // Nothing to settle twice.
    expect(screen.queryByRole('button', { name: /settle night/i })).not.toBeInTheDocument();
  });
});

/**
 * What the house takes, after the control that set it has gone.
 *
 * These are the only numbers on this screen that decide what a player walks
 * away with, and nothing else on the felt says what the house takes — so they
 * stay, for players as well as the host.
 */
describe('the house take line', () => {
  const rules = (over: Record<string, unknown> = {}) => ({
    capturedAt: ago(30),
    sessionRakeAmount: 1000, winnersCutPercent: 5,
    rakeEnabled: true, rakeMethod: 'PERCENT_PROFIT', rakeValue: 0,
    potEnabled: true, mismatchStrategy: 'PROPORTIONAL_WINNERS',
    rakeOrder: 'MISMATCH_FIRST', winnerDefinition: 'PROFIT_POSITIVE',
    winnerTopN: 1, roundingRule: 'NONE',
    ...over,
  });

  const playing = (settlementRules?: Record<string, unknown>) =>
    session({ activePlayerUids: ['host', 'priya'], startedPlayingAt: ago(60), settlementRules } as never);

  it('shows both figures once the night has rules', () => {
    renderScreen({ session: playing(rules()) });

    expect(screen.getByText(/house takes/i)).toBeInTheDocument();
    expect(screen.getByText('1,000 · 5% of winnings')).toBeInTheDocument();
  });

  it('shows it to a player, not only to the host', () => {
    // A player cannot open the settlement screen, so this is the only place
    // they can find out what the night charges.
    renderScreen({ session: playing(rules()), isAdmin: false, currentUserId: 'priya' });

    expect(screen.getByText(/house takes/i)).toBeInTheDocument();
  });

  it('says nothing on a night that charges nothing', () => {
    renderScreen({ session: playing(rules({ sessionRakeAmount: 0, winnersCutPercent: 0 })) });

    expect(screen.queryByText(/house takes/i)).not.toBeInTheDocument();
  });

  it('names only the charge that applies', () => {
    renderScreen({ session: playing(rules({ winnersCutPercent: 0 })) });

    expect(screen.getByText('1,000')).toBeInTheDocument();
    expect(screen.queryByText(/of winnings/i)).not.toBeInTheDocument();
  });

});

/**
 * The felt keeps its own space.
 *
 * The table sits in a shrink-0 box inside the elastic region. When the queue
 * grew, that region's share of the screen shrank and the table did not — so it
 * overflowed and rendered over the footer beneath it. The footer is
 * translucent, which is why it read as the Settle button sitting on top of the
 * table rather than as a layout fault.
 *
 * HONEST LIMIT: jsdom has no layout engine, so none of this can measure an
 * overlap. What it pins is the mechanism — the region scrolls rather than
 * spills, and the table is not the thing that gives way. Whether it LOOKS
 * right on a 375px screen is a question for a browser, and this file cannot
 * answer it.
 */
describe('the felt is never the thing that gives way', () => {
  const busy = () =>
    renderScreen(
      { session: session({ activePlayerUids: ['host', 'priya'], startedPlayingAt: ago(60) }) },
      []
    );

  it('lets the elastic region scroll instead of overflowing the footer', () => {
    busy();
    // renderScreen returns the props it built, not the RTL result — so the
    // tree is reached through the document rather than a container handle.
    //
    // Selected by the behaviour rather than by a class tuple, so re-ordering
    // utility classes does not silently make this assert nothing.
    const stage = [...document.body.querySelectorAll('div')].find(
      (d) => d.className.includes('flex-1') && d.className.includes('overflow-y-auto')
    );

    expect(stage, 'the elastic region should scroll rather than spill').toBeDefined();
    // Not hidden: clipping would cut the bottom row of seats off instead of
    // letting the host reach them.
    expect(stage?.className).not.toMatch(/overflow-hidden/);
  });

  it('keeps the table itself unshrinkable', () => {
    busy();
    const felt = screen.getByRole('group', { name: /at the table/i });

    // Whatever else moves, the felt sits in a shrink-0 box — the hero does not
    // absorb the cost of a busy queue.
    const unshrinkable = felt.closest('div.shrink-0');
    expect(unshrinkable, 'the felt should sit inside a shrink-0 container').not.toBeNull();
  });
});

/**
 * A player's own request, off the felt.
 *
 * It used to be the brass stud in the middle of the table, which could not say
 * whose chips it meant and could not be labelled without hitting a seat: the
 * free interior is sized for a small round stud, and a labelled pill overlapped
 * the viewer's own seat by 4px at four players and 33px at eighteen. Measured,
 * both times, before it moved.
 *
 * It sits on the viewer's own line under the table now — beside "You're in
 * for", directly below their seat, which is always bottom-centre.
 */
describe('asking for your own bank', () => {
  const playing = (over: Partial<LiveSessionProps> = {}) =>
    renderScreen(
      {
        session: session({ activePlayerUids: ['host', 'priya'], startedPlayingAt: ago(60) }),
        onAskForChips: vi.fn(),
        ...over,
      },
      [
        {
          id: 'b1', sessionId: 's1', clubId: 'c1', userId: 'host', userDisplayName: '',
          amount: 5000, status: 'approved', requestedBy: 'host', createdAt: ago(50),
        } as never,
      ]
    );

  it('is labelled, because a bare + cannot say whose chips it means', () => {
    playing({ isAdmin: false });
    expect(screen.getByRole('button', { name: /ask for bank/i })).toBeInTheDocument();
  });

  it('sits beside what the viewer already has on the table', () => {
    playing({ isAdmin: false });
    expect(screen.getByText(/You're in for/i)).toBeInTheDocument();
  });

  it('is NOT on the felt any more', () => {
    // The stud's accessible name was the only thing that said what it did, and
    // for a player it said this. Nothing on the cloth should now.
    playing({ isAdmin: false });
    const felt = screen.getByRole('group', { name: /at the table/i });
    expect(within(felt).queryByRole('button', { name: /ask for bank/i })).not.toBeInTheDocument();
  });

  it('says join rather than ask when the viewer has no seat', () => {
    renderScreen(
      {
        session: session({ activePlayerUids: ['priya'], startedPlayingAt: ago(60) }),
        currentUserId: 'host',
        isAdmin: false,
        onAskForChips: vi.fn(),
      },
      [
        {
          id: 'b1', sessionId: 's1', clubId: 'c1', userId: 'priya', userDisplayName: '',
          amount: 5000, status: 'approved', requestedBy: 'priya', createdAt: ago(50),
        } as never,
      ]
    );
    expect(screen.getByRole('button', { name: /join the table/i })).toBeInTheDocument();
  });

  it('opens the same sheet it always did', () => {
    const onAskForChips = vi.fn();
    playing({ isAdmin: false, onAskForChips });

    fireEvent.click(screen.getByRole('button', { name: /ask for bank/i }));
    expect(onAskForChips).toHaveBeenCalledTimes(1);
  });

  it('is gone while the table is frozen for settlement', () => {
    // Nothing can be bought from here, so nothing should offer to.
    playing({ isAdmin: false, session: session({
      activePlayerUids: ['host', 'priya'], startedPlayingAt: ago(60), settlingAt: ago(1),
    }) });
    expect(screen.queryByRole('button', { name: /ask for bank/i })).not.toBeInTheDocument();
  });

  it('leaves the host their own control on the felt', () => {
    // Bringing somebody to the table is about the room, not about one person,
    // and it keeps the middle of the cloth.
    playing({ isAdmin: true, onAddPlayer: vi.fn() });
    expect(screen.getByRole('button', { name: /add a player to the table/i })).toBeInTheDocument();
  });
});
