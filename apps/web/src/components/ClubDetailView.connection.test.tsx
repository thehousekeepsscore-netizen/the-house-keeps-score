import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * What the connection badge says, and — the point of this file — when it says
 * nothing at all.
 *
 * `socket-connection.ts` models four states and separates `never-connected`
 * from `disconnected` on purpose: the first is a socket opening for the first
 * time, which is not a fault. This screen used to collapse the two into one
 * 'reconnecting' value, so every cold open showed a pulsing "Reconnecting"
 * warning for the length of the handshake — around half a second — naming a
 * recovery that had never happened because the socket had never connected once.
 *
 * The library had 21 tests and the mapping that consumed it had none, which is
 * exactly how the distinction was created and then quietly discarded. These
 * tests sit at the consumer, so `never-connected` can never map to
 * 'reconnecting' again without something going red.
 */

/** Hoisted so the module mock below can close over it. */
const { fakeSocket } = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  const socket = {
    connected: false,
    active: true,
    on(e: string, fn: (...a: unknown[]) => void) {
      if (!listeners.has(e)) listeners.set(e, new Set());
      listeners.get(e)!.add(fn);
    },
    off(e: string, fn: (...a: unknown[]) => void) {
      listeners.get(e)?.delete(fn);
    },
    emit: () => undefined,
    connect: () => undefined,
    disconnect: () => undefined,
    /** Drive a real socket.io event through the listeners the screen attached. */
    fire(e: string, ...a: unknown[]) {
      [...(listeners.get(e) ?? [])].forEach((fn) => fn(...a));
    },
    reset() {
      listeners.clear();
      socket.connected = false;
      socket.active = true;
    },
  };
  return { fakeSocket: socket };
});

vi.mock('../lib/socket', () => ({
  getSocket: () => fakeSocket,
  resetSocket: vi.fn(),
}));

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
  return { ...actual, getClub: vi.fn() };
});

import { ClubDetailView } from './ClubDetailView';
import { ResourceCacheProvider } from '../lib/resource-cache';
import * as offlineSessionsApi from '../lib/offlineSessions-api';
import * as clubsApi from '../lib/clubs-api';
import * as clubRecordsApi from '../lib/clubRecords-api';
import { Club, PokerSession } from '../types';
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

const club = {
  id: 'c1',
  name: 'Friday Night',
  code: '60781',
  ownerUid: 'host',
  createdBy: 'host',
  adminUids: [],
  memberUids: ['host', 'priya'],
  isMember: true,
  isAdmin: true,
  isOwner: true,
  minBuyIn: 1000,
  maxBuyIn: 5000,
  buyInMode: 'MATCH_HIGHEST',
  memberCount: 2,
  adminCount: 1,
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

function renderClub() {
  vi.mocked(clubsApi.getClub).mockResolvedValue(club);
  vi.mocked(clubRecordsApi.listHistory).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.getLeaderboard).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPotLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPendingChanges).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listAuditLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listDeletedSessions).mockResolvedValue([]);
  vi.mocked(offlineSessionsApi.getActiveSession).mockResolvedValue(session);
  vi.mocked(offlineSessionsApi.listBuyInRequests).mockResolvedValue([]);

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

/** Mount and wait for the screen the badge lives on. */
async function mountClub() {
  renderClub();
  await waitFor(() => {
    expect(screen.queryByText(/Friday Night/i)).toBeInTheDocument();
  });
}

const reconnectingShown = () => screen.queryAllByText(/reconnecting/i).length > 0;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  fakeSocket.reset();
});

describe('the connection badge', () => {
  it('says nothing while the socket is still opening for the first time', async () => {
    // never-connected. THE REGRESSION: this is a cold open, not a recovery.
    await mountClub();

    expect(reconnectingShown(), 'a first connect is not a reconnection').toBe(false);
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Offline$/i)).not.toBeInTheDocument();
  });

  it('says nothing once the socket is up', async () => {
    await mountClub();
    await act(async () => {
      fakeSocket.connected = true;
      fakeSocket.fire('connect');
    });

    expect(reconnectingShown()).toBe(false);
  });

  it('warns only once a socket that WAS up goes down', async () => {
    // disconnected — the state 'Reconnecting' is actually true of.
    await mountClub();
    await act(async () => {
      fakeSocket.connected = true;
      fakeSocket.fire('connect');
    });
    expect(reconnectingShown()).toBe(false);

    await act(async () => {
      fakeSocket.connected = false;
      fakeSocket.fire('disconnect');
    });

    expect(reconnectingShown(), 'a real drop still has to be reported').toBe(true);
  });

  it('still reports a refused handshake as terminal, not as reconnecting', async () => {
    await mountClub();
    await act(async () => {
      // socket.io destroys a socket whose handshake was refused: nothing retries.
      fakeSocket.active = false;
      fakeSocket.fire('connect_error', new Error('Invalid or expired access token'));
    });

    expect(screen.queryAllByText(/session expired/i).length).toBeGreaterThan(0);
    expect(reconnectingShown(), 'nothing is going to retry, so do not promise it').toBe(false);
  });
});
