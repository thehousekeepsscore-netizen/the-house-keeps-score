import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * What each role actually sees on the session board.
 *
 * The board's permission model is one boolean derived inside the component --
 * isAdmin, which includes the owner -- so these tests drive it the only honest
 * way: three club fixtures that differ in ownerUid/adminUids, evaluated by the
 * component's own derivation against the signed-in uid. No role prop exists,
 * and none is invented here; a harness that set "role" directly would assert
 * against its own input.
 *
 * Two of these are redesign guarantees, the rest are the existing permission
 * surface pinned down so a restyle cannot quietly move it:
 *
 *   - The section under the table is titled HISTORY (it was "Live").
 *   - The header names the role: the owner reads Owner, a non-owner admin
 *     reads Admin, a player reads neither. A label only -- the capabilities
 *     asserted around it are identical for owner and admin, deliberately.
 *   - Settle night is admin-only. The reference design drew it on the player
 *     board; the product does not grant it, so the test pins its absence.
 *   - The Approve tab is admin-only.
 *   - The feed shows EVERY player's events to EVERY role. That is the current
 *     product's deliberate design (see LiveFeed.tsx -- the feed is the point,
 *     for players especially), and under MATCH_HIGHEST players need the room's
 *     banks to know the table ceiling. Restricting players to their own events
 *     would need server-side filtering that does not exist; if that lands, this
 *     is the test that must change -- knowingly, not by accident.
 */

vi.mock('../lib/auth-context', async () => {
  const actual = await vi.importActual<typeof import('../lib/auth-context')>('../lib/auth-context');
  return {
    ...actual,
    useAuth: () => ({
      user: { uid: 'me', email: 'me@test.local', displayName: 'Me', profileComplete: true },
      status: 'authenticated',
      logout: vi.fn(),
      authError: null,
      clearAuthError: vi.fn(),
    }),
  };
});

vi.mock('../lib/offlineSessions-api', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/offlineSessions-api')>('../lib/offlineSessions-api');
  return { ...actual, getActiveSession: vi.fn(), listBuyInRequests: vi.fn() };
});

vi.mock('../lib/clubRecords-api', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/clubRecords-api')>('../lib/clubRecords-api');
  return {
    ...actual,
    listHistory: vi.fn(),
    getLeaderboard: vi.fn(),
    listPotLog: vi.fn(),
    listPendingChanges: vi.fn(),
    listAuditLog: vi.fn(),
    listDeletedSessions: vi.fn(),
  };
});

vi.mock('../lib/clubs-api', async () => {
  const actual = await vi.importActual<typeof import('../lib/clubs-api')>('../lib/clubs-api');
  return { ...actual, getClub: vi.fn(), listJoinRequests: vi.fn() };
});

const socketHandlers = new Map<string, Set<(...a: unknown[]) => void>>();
const fakeSocket = {
  connected: false,
  active: true,
  on: vi.fn((e: string, fn: (...a: unknown[]) => void) => {
    if (!socketHandlers.has(e)) socketHandlers.set(e, new Set());
    socketHandlers.get(e)!.add(fn);
  }),
  off: vi.fn((e: string, fn: (...a: unknown[]) => void) => socketHandlers.get(e)?.delete(fn)),
  emit: vi.fn(),
  connect: vi.fn(),
};
vi.mock('../lib/socket', () => ({ getSocket: () => fakeSocket, resetSocket: vi.fn() }));

import { ClubDetailView } from './ClubDetailView';
import { ResourceCacheProvider } from '../lib/resource-cache';
import * as offlineSessionsApi from '../lib/offlineSessions-api';
import * as clubsApi from '../lib/clubs-api';
import * as clubRecordsApi from '../lib/clubRecords-api';
import { Club, PokerSession, BuyInRequest } from '../types';
import type { AppUser as User } from '../lib/auth-types';

const NOW = Date.now();
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();

const currentUser = {
  uid: 'me',
  email: 'me@test.local',
  displayName: 'Me',
  photoURL: '',
  profileComplete: true,
} as unknown as User;

/** The signed-in uid is 'me'; ownership fields are what vary per role. */
function clubAs(role: 'owner' | 'admin' | 'player'): Club {
  return {
    id: 'c1',
    name: 'Friday Night',
    code: '60781',
    ownerUid: role === 'owner' ? 'me' : 'somebody-else',
    createdBy: role === 'owner' ? 'me' : 'somebody-else',
    adminUids: role === 'admin' ? ['me'] : ['somebody-else'],
    memberUids: ['me', 'priya', 'somebody-else'],
    isMember: true,
    minBuyIn: 1000,
    maxBuyIn: 5000,
    buyInMode: 'MATCH_HIGHEST',
    memberCount: 3,
    adminCount: 1,
    maxCapacity: 50,
    createdAt: ago(9999),
  } as unknown as Club;
}

const session: PokerSession = {
  id: 's1',
  clubId: 'c1',
  sessionName: 'Fri · Day 1',
  status: 'active',
  activePlayerUids: ['me', 'priya'],
  pendingSitInUids: [],
  sitInRequestedAt: {},
  cashOuts: [],
  startedBy: 'somebody-else',
  createdAt: ago(120),
  startedPlayingAt: ago(90),
  timeExtensions: [],
  timeLimitLiftedAt: null,
  settlingAt: null,
};

const buyIn = (id: string, userId: string, amount: number, minsAgo: number): BuyInRequest => ({
  id,
  sessionId: 's1',
  clubId: 'c1',
  userId,
  userDisplayName: '',
  amount,
  status: 'approved',
  requestedBy: userId,
  createdAt: ago(minsAgo),
});

function renderAs(role: 'owner' | 'admin' | 'player') {
  const club = clubAs(role);
  vi.mocked(clubsApi.getClub).mockResolvedValue(club);
  vi.mocked(clubsApi.listJoinRequests).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listHistory).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.getLeaderboard).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPotLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPendingChanges).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listAuditLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listDeletedSessions).mockResolvedValue([]);
  vi.mocked(offlineSessionsApi.getActiveSession).mockResolvedValue(session);
  // Two players' money, so "does a role see the OTHER player's event" is a
  // question the fixture can answer.
  vi.mocked(offlineSessionsApi.listBuyInRequests).mockResolvedValue([
    buyIn('b-mine', 'me', 5000, 80),
    buyIn('b-priya', 'priya', 3000, 40),
  ]);

  const router = createMemoryRouter(
    [
      {
        path: '/clubs/:clubId',
        element: (
          <ResourceCacheProvider>
            <ClubDetailView
              club={club}
              currentUser={currentUser}
              playerAvatarUrl=""
              onBackToDashboard={vi.fn()}
            />
          </ResourceCacheProvider>
        ),
      },
    ],
    { initialEntries: ['/clubs/c1'] }
  );
  return render(<RouterProvider router={router} />);
}

/** The felt has painted once the ceiling line is up. */
async function settled() {
  await waitFor(() => expect(screen.getByText(/Max buy-in/i)).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  socketHandlers.clear();
  localStorage.clear();
});

describe('the section under the table is HISTORY', () => {
  it('is titled History, not Live', async () => {
    // "History" also names the bottom-nav tab, so the assertion is scoped to
    // the feed section itself: the section is labelled History AND its header
    // row says History. The absence check is what actually guards the rename.
    renderAs('player');
    await settled();

    const section = await screen.findByLabelText('History');
    expect(section.querySelector('span.uppercase')?.textContent).toBe('History');
    expect(screen.queryByText('Live', { selector: 'span' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Tonight, as it happens')).not.toBeInTheDocument();
  });
});

describe('the header names the role', () => {
  it('the owner reads Owner', async () => {
    renderAs('owner');
    await settled();
    expect(screen.getByText('· Owner')).toBeInTheDocument();
    expect(screen.queryByText('· Admin')).not.toBeInTheDocument();
  });

  it('a non-owner admin reads Admin', async () => {
    renderAs('admin');
    await settled();
    expect(screen.getByText('· Admin')).toBeInTheDocument();
    expect(screen.queryByText('· Owner')).not.toBeInTheDocument();
  });

  it('a player reads neither', async () => {
    renderAs('player');
    await settled();
    expect(screen.queryByText('· Owner')).not.toBeInTheDocument();
    expect(screen.queryByText('· Admin')).not.toBeInTheDocument();
  });
});

describe('capabilities stay exactly where they were', () => {
  it('owner and admin can settle the night; a player cannot', async () => {
    renderAs('owner');
    await settled();
    expect(screen.getByRole('button', { name: 'Settle night' })).toBeInTheDocument();
  });

  it('admin sees Settle night too — identical to the owner, deliberately', async () => {
    renderAs('admin');
    await settled();
    expect(screen.getByRole('button', { name: 'Settle night' })).toBeInTheDocument();
  });

  it('the player board has no Settle night, whatever the mockup drew', async () => {
    renderAs('player');
    await settled();
    expect(screen.queryByRole('button', { name: 'Settle night' })).not.toBeInTheDocument();
  });

  it('Approve is a tab only admins have', async () => {
    renderAs('admin');
    await settled();
    expect(screen.getByRole('button', { name: /Approve/ })).toBeInTheDocument();
  });

  it('and a player does not', async () => {
    renderAs('player');
    await settled();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
  });
});

describe('history visibility is the same for every role — the current contract', () => {
  it('a player sees the other player’s event, amount included', async () => {
    // Documents today's deliberate design rather than the reference render:
    // the feed narrates the whole room to everyone, and the MATCH_HIGHEST
    // ceiling players are shown is derived from everyone's banks. If per-role
    // filtering ever lands (a server-side change), this test is the one that
    // must be rewritten on purpose.
    renderAs('player');
    await settled();

    const history = screen.getByLabelText('History');
    await waitFor(() => {
      expect(history.textContent).toMatch(/bought in for/);
    });
    expect(history.textContent).toContain('3,000'); // priya's money, seen by a player
  });

  it('the owner sees the same room', async () => {
    renderAs('owner');
    await settled();

    const history = screen.getByLabelText('History');
    await waitFor(() => {
      expect(history.textContent).toMatch(/bought in for/);
    });
    expect(history.textContent).toContain('3,000');
  });
});
