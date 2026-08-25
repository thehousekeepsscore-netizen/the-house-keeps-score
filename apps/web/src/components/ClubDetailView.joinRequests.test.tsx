import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * Who can see the join-request queue on a club.
 *
 * The API is the gate — #33 refuses a non-admin with a 403 whatever the screen
 * does — so these tests are about not OFFERING an action that would be refused,
 * which is a different and lesser claim. A UI test that passed here while the
 * API was open would prove nothing about safety.
 *
 * The harness is lifted from ClubDetailView.render.test.tsx: this screen fetches
 * a dozen resources on mount, and a fetcher left unmocked resolves undefined and
 * takes the cache down in a way that looks nothing like the thing under test.
 */

vi.mock('../lib/auth-context', async () => {
  const actual = await vi.importActual<typeof import('../lib/auth-context')>('../lib/auth-context');
  return {
    ...actual,
    useAuth: () => ({
      user: { uid: 'host', email: 'host@test.local', displayName: 'Host', profileComplete: true },
      status: 'authenticated',
      logout: vi.fn(),
      authError: null,
      clearAuthError: vi.fn(),
    }),
  };
});

// The screen fetches on mount. These tests are about whether it renders, so the
// network is stubbed to resolve with a live night rather than mocked per call.
vi.mock('../lib/offlineSessions-api', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/offlineSessions-api')>('../lib/offlineSessions-api');
  return {
    ...actual,
    getActiveSession: vi.fn(),
    listBuyInRequests: vi.fn(),
  };
});

// Every resource the screen loads on mount. Named from the source rather than
// guessed: a fetcher left unmocked returns undefined and the cache explodes on
// `.then`, which looks nothing like the bug under test.
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
  return {
    ...actual,
    getClub: vi.fn(),
    listJoinRequests: vi.fn(),
    decideJoinRequest: vi.fn(),
  };
});

import { ClubDetailView } from './ClubDetailView';
import { ResourceCacheProvider } from '../lib/resource-cache';
import * as offlineSessionsApi from '../lib/offlineSessions-api';
import * as clubsApi from '../lib/clubs-api';
import * as clubRecordsApi from '../lib/clubRecords-api';
import { Club, PokerSession, BuyInRequest } from '../types';
import type { AppUser as User } from '../lib/auth-types';

const NOW = Date.parse('2026-08-08T21:00:00.000Z');
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();

const currentUser = {
  uid: 'host',
  email: 'host@test.local',
  displayName: 'Host',
  photoURL: '',
  profileComplete: true,
} as unknown as User;

/**
 * An admin looking at a live night — the only shape that reaches the crash.
 *
 * The memo returns early unless `isAdmin && activeSession`, so a player, or an
 * admin with no session running, never gets there. That is precisely why this
 * went out: every browser check in the session that built it was either signed
 * out or looking at a club with nothing running.
 */
const club = {
  id: 'c1',
  name: 'Friday Night',
  code: '60781',
  ownerUid: 'host',
  createdBy: 'host',
  adminUids: ['coadmin'],
  memberUids: ['host', 'priya', 'coadmin'],
  isMember: true,
  isAdmin: true,
  isOwner: true,
  minBuyIn: 1000,
  maxBuyIn: 5000,
  buyInMode: 'MATCH_HIGHEST',
  memberCount: 3,
  adminCount: 2,
  maxCapacity: 50,
  createdAt: ago(9999),
} as unknown as Club;

const session: PokerSession = {
  id: 's1',
  clubId: 'c1',
  sessionName: 'Fri 8 Aug · Day 1',
  status: 'active',
  activePlayerUids: ['host', 'priya'],
  pendingSitInUids: [],
  sitInRequestedAt: {},
  cashOuts: [],
  startedBy: 'host',
  createdAt: ago(120),
  startedPlayingAt: ago(90),
  timeExtensions: [],
  timeLimitLiftedAt: null,
  settlingAt: null,
};

/** A pending buy-in, so the queue-building memo has a row to walk. */
const pendingBuyIn: BuyInRequest = {
  id: 'b-pending',
  sessionId: 's1',
  clubId: 'c1',
  userId: 'priya',
  userDisplayName: '',
  amount: 3000,
  status: 'pending',
  requestedBy: 'priya',
  createdAt: ago(2),
};

const approvedBuyIn: BuyInRequest = {
  ...pendingBuyIn,
  id: 'b-approved',
  userId: 'host',
  amount: 5000,
  status: 'approved',
  requestedBy: 'host',
  createdAt: ago(80),
};


const joinRequest = {
  id: 'jr-1',
  clubId: 'c1',
  clubName: 'Friday Night',
  userId: 'hopeful',
  userDisplayName: 'Priya Shah',
  status: 'pending' as const,
  createdAt: ago(30),
};

function renderClubAs(role: 'owner' | 'admin' | 'member', entry = '/clubs/c1/pending-approvals') {
  const shaped = {
    ...club,
    isOwner: role === 'owner',
    isAdmin: role !== 'member',
    ownerUid: role === 'owner' ? 'host' : 'someone-else',
    createdBy: role === 'owner' ? 'host' : 'someone-else',
    adminUids: role === 'admin' ? ['host'] : [],
  } as unknown as Club;

  vi.mocked(clubsApi.getClub).mockResolvedValue(shaped);
  vi.mocked(clubsApi.listJoinRequests).mockResolvedValue([joinRequest]);
  vi.mocked(clubRecordsApi.listHistory).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.getLeaderboard).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPotLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPendingChanges).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listAuditLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listDeletedSessions).mockResolvedValue([]);
  vi.mocked(offlineSessionsApi.getActiveSession).mockResolvedValue(null as never);
  vi.mocked(offlineSessionsApi.listBuyInRequests).mockResolvedValue([]);

  const router = createMemoryRouter(
    [
      {
        path: '/clubs/:clubId/:tab?',
        element: (
          <ResourceCacheProvider>
            <ClubDetailView
              club={shaped}
              currentUser={currentUser}
              playerAvatarUrl=""
              onBackToDashboard={vi.fn()}
            />
          </ResourceCacheProvider>
        ),
      },
    ],
    // Tabs are addresses on this screen, so the test navigates to one rather
    // than clicking through — clicking pushed a URL the memory router had no
    // route for and rendered a 404 instead of the tab.
    { initialEntries: [entry] }
  );
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('the join-request queue on a club', () => {
  it('an owner can reach it', async () => {
    renderClubAs('owner');
    expect(await screen.findByTestId('join-request-list')).toBeInTheDocument();
    expect(await screen.findByText('Priya Shah')).toBeInTheDocument();
  });

  it('an admin can reach it', async () => {
    renderClubAs('admin');
    expect(await screen.findByTestId('join-request-list')).toBeInTheDocument();
  });

  it('a plain member is not offered it', async () => {
    renderClubAs('member');
    await waitFor(() => expect(clubsApi.getClub).toHaveBeenCalled());

    // No Approvals tab, and therefore nowhere the list could be rendered.
    expect(screen.queryByRole('button', { name: /Approvals/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('join-request-list')).not.toBeInTheDocument();
  });

  it('does not even fetch join requests for a plain member', async () => {
    renderClubAs('member');
    await waitFor(() => expect(clubsApi.getClub).toHaveBeenCalled());
    // A null resource key skips the request entirely rather than issuing it and
    // discarding the answer.
    expect(clubsApi.listJoinRequests).not.toHaveBeenCalled();
  });

  it('does not repeat the club name, because the surface already is one club', async () => {
    renderClubAs('owner');
    const list = await screen.findByTestId('join-request-list');
    expect(list).not.toHaveTextContent('Friday Night');
  });
});
