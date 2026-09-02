import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Signing out takes the club screen down before anyone else can sign in.
 *
 * This pins an invariant, not a feature — and it is load-bearing for the socket.
 * `resetSocket()` replaces the module singleton on any change of identity, while
 * `useSocketConnection` seeds its state from a `useState` initialiser that runs
 * once per MOUNT. Handed a replacement socket without remounting, it keeps
 * reporting the old one's state: "Live" for a socket that has never connected,
 * which is the failure the four-state type exists to prevent.
 *
 * That is unreachable today for exactly one reason. `App` renders
 * `{!authUser ? <LoginPage /> : ...}`, and uid can only travel
 * null -> A -> null -> B, never A -> B: the startup bootstrap runs once behind
 * `startupRan`, and login/register are reachable only from LoginPage, which is
 * only rendered when there is no user. So the club tree always unmounts on the
 * way through null, and the initialiser re-runs against the new socket.
 *
 * The trigger is tested (auth-context.identity.test.tsx) and the state machine
 * is tested (socket-connection.test.tsx). This is the seam between them: the
 * architectural guarantee that keeps the latent bug latent. If someone later
 * keeps a screen mounted across a change of identity, or adds a second
 * `resetSocket()` caller, this fails and points at the reason — instead of
 * shipping a silent "Live" during a real outage.
 *
 * WHICH ASSERTION DOES THE WORK, measured rather than assumed.
 *
 * Only the LoginPage assertion discriminates. Retaining the last identity so
 * the tree stays mounted was tried as a mutation, and the club name still
 * vanished and the listener count still fell to zero — because a SECOND,
 * independent mechanism also tears the screen down: ResourceCacheProvider wipes
 * the cache on a change of identity, so `club:c1` goes empty and ClubRoute
 * falls back to its skeleton, unmounting ClubDetailView anyway.
 *
 * That redundancy is good news for the socket — the bug is unreachable through
 * two doors, not one — but it means the two assertions below it are backstops,
 * not the guard. They would catch a regression that defeated BOTH mechanisms.
 * The LoginPage assertion is the one that fails when the auth gate goes.
 */

/** Tracks live listeners, so "did the club screen let go of the socket?" is answerable. */
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
    liveListeners: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    reset: () => listeners.clear(),
  };
  return { fakeSocket: socket };
});

vi.mock('./lib/socket', () => ({
  getSocket: () => fakeSocket,
  resetSocket: vi.fn(),
}));

/** Swapped per phase of the test, the way a real sign-out swaps it. */
let authState: { user: unknown; status: string } = { user: null, status: 'unauthenticated' };

vi.mock('./lib/auth-context', async () => {
  const actual = await vi.importActual<typeof import('./lib/auth-context')>('./lib/auth-context');
  return {
    ...actual,
    useAuth: () => ({
      ...authState,
      phase: authState.status,
      logout: vi.fn(),
      authError: null,
      clearAuthError: vi.fn(),
      login: vi.fn(),
      register: vi.fn(),
      loginWithGoogle: vi.fn(),
      updateProfile: vi.fn(),
    }),
  };
});

vi.mock('./lib/clubs-api', async () => {
  const actual = await vi.importActual<typeof import('./lib/clubs-api')>('./lib/clubs-api');
  return { ...actual, getClub: vi.fn(), listClubsRaw: vi.fn(), listJoinRequests: vi.fn() };
});

vi.mock('./lib/offlineSessions-api', async () => {
  const actual =
    await vi.importActual<typeof import('./lib/offlineSessions-api')>('./lib/offlineSessions-api');
  return { ...actual, getActiveSession: vi.fn(), listBuyInRequests: vi.fn() };
});

vi.mock('./lib/clubRecords-api', async () => {
  const actual =
    await vi.importActual<typeof import('./lib/clubRecords-api')>('./lib/clubRecords-api');
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

import App from './App';
import { ResourceCacheProvider } from './lib/resource-cache';
import * as clubsApi from './lib/clubs-api';
import * as clubRecordsApi from './lib/clubRecords-api';
import * as offlineSessionsApi from './lib/offlineSessions-api';
import { Club } from './types';

const authedUser = {
  uid: 'host',
  email: 'host@test.local',
  displayName: 'Host',
  photoURL: '',
  profileComplete: true,
};

const club = {
  id: 'c1',
  name: 'Friday Night',
  code: '60781',
  ownerUid: 'host',
  createdBy: 'host',
  adminUids: [],
  memberUids: ['host'],
  isMember: true,
  isAdmin: true,
  isOwner: true,
  minBuyIn: 1000,
  maxBuyIn: 5000,
  buyInMode: 'MATCH_HIGHEST',
  memberCount: 1,
  adminCount: 1,
  maxCapacity: 50,
  createdAt: new Date('2026-01-01').toISOString(),
} as unknown as Club;

/*
 * A FRESH element each time, deliberately.
 *
 * React bails out of re-rendering when handed the identical element reference,
 * so reusing one constant would make rerender() a no-op and the test would
 * assert against the signed-in tree while believing it had signed out.
 */
const tree = () => (
  <MemoryRouter initialEntries={['/clubs/c1']}>
    <ResourceCacheProvider>
      <App />
    </ResourceCacheProvider>
  </MemoryRouter>
);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  fakeSocket.reset();
  authState = { user: null, status: 'unauthenticated' };
  vi.mocked(clubsApi.getClub).mockResolvedValue(club);
  vi.mocked(clubsApi.listClubsRaw).mockResolvedValue([]);
  vi.mocked(clubsApi.listJoinRequests).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listHistory).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.getLeaderboard).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPotLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPendingChanges).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listAuditLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listDeletedSessions).mockResolvedValue([]);
  vi.mocked(offlineSessionsApi.getActiveSession).mockResolvedValue(null as never);
  vi.mocked(offlineSessionsApi.listBuyInRequests).mockResolvedValue([]);
});

describe('the club tree does not survive a change of identity', () => {
  it('unmounts on sign-out, and lets go of the socket, before anyone else can sign in', async () => {
    authState = { user: authedUser, status: 'authenticated' };
    const { rerender } = render(tree());

    // The club screen is really up, and really holding the socket.
    await waitFor(() => {
      expect(screen.getByText(/Friday Night/i)).toBeInTheDocument();
    });
    const heldWhileSignedIn = fakeSocket.liveListeners();
    expect(heldWhileSignedIn, 'the club screen attaches socket listeners').toBeGreaterThan(0);

    // Sign out. uid goes to null, which is the only route to another identity.
    authState = { user: null, status: 'unauthenticated' };
    rerender(tree());

    // THE GUARD. The auth gate is what makes A -> B impossible without a
    // remount, and this is the only assertion here that fails when it goes.
    await waitFor(() => {
      expect(
        screen.queryByText(/Welcome back/i),
        'signing out must replace the club tree with the sign-in screen'
      ).toBeInTheDocument();
    });

    // Backstops. Both also hold via the cache's own identity clear, so they do
    // not discriminate on their own — see the note above.
    expect(
      screen.queryByText(/Friday Night/i),
      'the club tree must not outlive the identity it was opened under'
    ).not.toBeInTheDocument();

    expect(
      fakeSocket.liveListeners(),
      'its socket listeners must be detached before a new identity mounts — ' +
        'useSocketConnection only re-seeds its state on mount'
    ).toBe(0);
  });
});
