import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * The club screen renders at all.
 *
 * This file exists because it did not. A `useMemo` referenced `whoIsHere` from
 * inside its callback while `const whoIsHere = useMemo(...)` sat sixty-three
 * lines further down the component — and `useMemo` runs its callback
 * synchronously on the first render, so the read happened while the binding was
 * still in its temporal dead zone:
 *
 *     Cannot access 'whoIsHere' before initialization
 *
 * The whole screen threw into the ErrorBoundary. Not the new live session — the
 * WHOLE screen, old layout included, because the memo sits above the feature
 * flag. It reached production.
 *
 * Nothing that existed caught it. TypeScript does not model the dead zone for a
 * binding read inside a closure. The build succeeded. 271 component tests
 * passed, because every one of them rendered the session components directly
 * with props and this 4,600-line screen had no render test of its own.
 *
 * So that is what this is: not a test of what the screen shows, a test that it
 * mounts. The crash only fires for an admin with a live session, because the
 * memo returns early otherwise — which is why it survived every screenshot
 * taken while signed out.
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
    getClubRoster: vi.fn(),
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

function renderClub() {
  vi.mocked(clubsApi.getClub).mockResolvedValue(club);
  vi.mocked(clubsApi.getClubRoster).mockResolvedValue({});
  vi.mocked(clubRecordsApi.listHistory).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.getLeaderboard).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPotLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPendingChanges).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listAuditLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listDeletedSessions).mockResolvedValue([]);
  vi.mocked(offlineSessionsApi.getActiveSession).mockResolvedValue(session);
  vi.mocked(offlineSessionsApi.listBuyInRequests).mockResolvedValue([approvedBuyIn, pendingBuyIn]);

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

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('the club screen mounts', () => {
  /**
   * Waits for the SESSION to arrive, not merely for the screen to appear.
   *
   * The first attempt at this test asserted the club name and passed against the
   * broken code — the name comes from a prop and renders immediately, long
   * before any fetch resolves. The crash needs `activeSession` AND a pending
   * buy-in, so the memo returns early until both are in state. A mount test
   * that does not wait for them is a test of nothing.
   */
  async function mountAndSettle() {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      const first = args[0];
      errors.push(first instanceof Error ? first.message : String(first));
    });

    renderClub();

    // Both fetches have to land: the session, then its buy-ins.
    await waitFor(() => {
      expect(offlineSessionsApi.listBuyInRequests).toHaveBeenCalled();
    });
    // And one more paint, so the render that consumes them has happened.
    await waitFor(() => {
      expect(screen.queryByText(/Friday Night/i)).toBeInTheDocument();
    });

    spy.mockRestore();
    return errors;
  }

  /** The router's boundary is what a throw during render actually looks like. */
  const crashed = () =>
    screen.queryByText(/Unexpected Application Error/i) !== null;

  it('renders for an admin with a live session and a pending buy-in', async () => {
    const errors = await mountAndSettle();

    expect(crashed()).toBe(false);
    expect(errors.filter((m) => /before initialization|Cannot access/i.test(m))).toEqual([]);
  });

  it('renders the same way with the new live session turned on', async () => {
    // The crash was ABOVE the flag, so both layouts have to be covered.
    localStorage.setItem('flag:next-session', '1');
    const errors = await mountAndSettle();

    expect(crashed()).toBe(false);
    expect(errors.filter((m) => /before initialization|Cannot access/i.test(m))).toEqual([]);
  });
});
