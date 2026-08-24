import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * How many HTTP requests this screen actually makes, counted at the wire.
 *
 * Every other test in this suite stubs the api modules, which measures nothing
 * about request volume: two helpers that both call `GET /clubs/:id` look like
 * two independent mocks rather than one duplicated round trip. This file mocks
 * `apiFetch` instead — the single choke point every api module goes through —
 * and tallies paths, so the numbers here are the numbers a phone would make.
 *
 * It exists to hold request counts still. Any change that quietly adds a fetch
 * to mount, reconnect or resume has to come through here and change a number
 * on purpose.
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

const fakeSocket = {
  connected: false,
  active: true,
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
  connect: vi.fn(),
};
vi.mock('../lib/socket', () => ({ getSocket: () => fakeSocket, resetSocket: vi.fn() }));

/** Every request the screen makes, in order. */
const requests: string[] = [];

const apiClub = {
  id: 'c1',
  name: 'Test Club',
  code: '0007',
  description: null,
  ownerId: 'host',
  owner: { id: 'host', displayName: 'Host', email: 'host@test.local', avatarUrl: null },
  admins: [{ id: 'host', displayName: 'Host', email: 'host@test.local', avatarUrl: null }],
  members: [{ id: 'p2', displayName: 'Player Two', email: 'p2@test.local', avatarUrl: null }],
  memberCount: 2,
  adminCount: 1,
  maxCapacity: 9,
  buyInMode: 'UNCAPPED',
  minBuyIn: 0,
  maxBuyIn: 0,
  devaluationFactor: 1,
  enableDevaluation: false,
  clubPotBalance: 0,
  leaderboardVisibleToPlayers: true,
  sessionRakeAmount: 0,
  winnersCutPercent: 0,
  rakeEnabled: false,
  rakeMethod: 'PERCENT_PROFIT',
  rakeValue: 0,
  potEnabled: false,
  mismatchStrategy: 'PROPORTIONAL_WINNERS',
  rakeOrder: 'RAKE_FIRST',
  winnerDefinition: 'NET_POSITIVE',
  winnerTopN: 1,
  roundingRule: 'NEAREST',
  isMember: true,
  isAdmin: true,
  isOwner: true,
  createdAt: new Date().toISOString(),
};

vi.mock('../lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('../lib/api-client')>('../lib/api-client');
  return {
    ...actual,
    apiFetch: vi.fn(async (path: string) => {
      requests.push(path);
      if (/^\/clubs\/[^/]+$/.test(path)) return apiClub;
      if (path.endsWith('/offline-sessions/active')) return null;
      return [];
    }),
  };
});

import { ClubDetailView } from './ClubDetailView';
import { ResourceCacheProvider } from '../lib/resource-cache';
import { toClub } from '../lib/clubs-api';
import type { Club } from '../types';

const club = toClub(apiClub as never) as Club;
const currentUser = {
  uid: 'host',
  email: 'host@test.local',
  displayName: 'Host',
  profileComplete: true,
} as never;

/** Requests for one path, e.g. how many times `/clubs/c1` was asked for. */
function countExact(path: string) {
  return requests.filter((r) => r === path).length;
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

function renderClub() {
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
  requests.length = 0;
  fakeSocket.connected = false;
  fakeSocket.emit.mockClear();
  setVisibility('visible');
});

afterEach(() => setVisibility('visible'));

describe('request volume on mount', () => {
  it('asks for the club record exactly once', async () => {
    renderClub();
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    await waitFor(() => expect(countExact('/clubs/c1')).toBeGreaterThan(0));

    // getClub and getClubRoster were two helpers over one endpoint, on two cache
    // keys, so the cache's per-key single-flight could not collapse them: the
    // heaviest endpoint on the screen was fetched twice on every mount and
    // again twice on every resync.
    expect(countExact('/clubs/c1')).toBe(1);
  });

  it('makes no duplicate requests of any kind on mount', async () => {
    renderClub();
    await waitFor(() => expect(countExact('/clubs/c1')).toBeGreaterThan(0));
    // Let any follow-up settle.
    await act(async () => {
      await Promise.resolve();
    });

    const duplicated = [...new Set(requests)].filter((p) => countExact(p) > 1);
    expect(duplicated).toEqual([]);
  });
});

describe('request volume on resume', () => {
  it('does not re-ask for the club record twice per resume', async () => {
    renderClub();
    await waitFor(() => expect(countExact('/clubs/c1')).toBe(1));
    requests.length = 0;

    setVisibility('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    setVisibility('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(countExact('/clubs/c1')).toBeGreaterThan(0));
    expect(countExact('/clubs/c1')).toBe(1);
  });

  it('still refetches on resume — request reduction must not silence recovery', async () => {
    // The whole point of the shipped foreground recovery. A change that reduced
    // requests by not refetching would pass every count assertion above and
    // reintroduce the stale-data bug, so the floor is asserted too.
    renderClub();
    await waitFor(() => expect(countExact('/clubs/c1')).toBe(1));
    requests.length = 0;

    setVisibility('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    setVisibility('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests).toContain('/clubs/c1');
    expect(requests).toContain('/clubs/c1/history');
  });
});
