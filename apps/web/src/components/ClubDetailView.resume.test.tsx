import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * The club screen actually recovers when the user comes back to it.
 *
 * use-foreground-recovery.test.tsx proves the hook behaves correctly. It cannot
 * prove the screen uses it — and that gap is not hypothetical: deleting the
 * `useForegroundRecovery(...)` call from ClubDetailView left all 518 tests
 * passing. The feature could have been removed entirely and CI would have
 * stayed green.
 *
 * So this file asserts the wiring end to end: a real resume event on a mounted
 * club screen must produce real refetches. It is deliberately about the
 * connection between the two pieces, not about either piece in isolation.
 *
 * The socket here reports `connected: true` throughout, because that is the
 * failure being fixed — a socket the OS quietly killed while the tab was in the
 * background, still claiming to be up. If the refetch only happened for a
 * visibly disconnected socket, the reported bug would survive untouched.
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

/**
 * Reports connected throughout — see the note above — and, by default, ANSWERS:
 * the resume now asks a socket claiming `connected` to prove it, by
 * acknowledging the room join within a bounded timeout. A fake that could not
 * answer would read as dead and be reconnected, which is the behaviour under
 * test below, not the baseline.
 */
const emitWithAck = vi.fn(async (_event: string, _arg: unknown) => ({ ok: true }));
const fakeSocket = {
  connected: true,
  active: true,
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  timeout: vi.fn((_ms: number) => ({ emitWithAck })),
};

vi.mock('../lib/socket', () => ({
  getSocket: () => fakeSocket,
  resetSocket: vi.fn(),
}));

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
import * as clubsApi from '../lib/clubs-api';
import * as clubRecordsApi from '../lib/clubRecords-api';
import * as offlineSessionsApi from '../lib/offlineSessions-api';
import type { Club } from '../types';

const club = {
  id: 'c1',
  name: 'Test Club',
  code: '0007',
  createdBy: 'host',
  ownerUid: 'host',
  adminUids: ['host'],
  memberUids: ['host'],
} as unknown as Club;

const currentUser = {
  uid: 'host',
  email: 'host@test.local',
  displayName: 'Host',
  profileComplete: true,
} as never;

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

function fireVisibility(state: DocumentVisibilityState) {
  setVisibility(state);
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function renderClub() {
  vi.mocked(clubsApi.getClub).mockResolvedValue(club);
  vi.mocked(clubRecordsApi.listHistory).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.getLeaderboard).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPotLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPendingChanges).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listAuditLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listDeletedSessions).mockResolvedValue([]);
  vi.mocked(offlineSessionsApi.getActiveSession).mockResolvedValue(null);
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

beforeEach(() => {
  vi.clearAllMocks();
  fakeSocket.connected = true;
  setVisibility('visible');
});

afterEach(() => {
  setVisibility('visible');
});

describe('the club screen refetches when the user returns to the app', () => {
  it('refetches on resume even though the socket claims to be connected', async () => {
    renderClub();
    await waitFor(() => expect(clubsApi.getClub).toHaveBeenCalled());

    // Everything the mount asked for has been asked. Anything after this point
    // is the resume doing its job.
    vi.clearAllMocks();

    fireVisibility('hidden');
    fireVisibility('visible');

    await waitFor(() => expect(clubsApi.getClub).toHaveBeenCalledTimes(1));
    expect(clubRecordsApi.listHistory).toHaveBeenCalledTimes(1);
    expect(clubRecordsApi.getLeaderboard).toHaveBeenCalledTimes(1);
    expect(offlineSessionsApi.getActiveSession).toHaveBeenCalledTimes(1);

    // The socket was never reconnected — it already believed it was up. The
    // data came back anyway, which is the whole point.
    expect(fakeSocket.connect).not.toHaveBeenCalled();
  });

  it('does not refetch when the page is merely hidden', async () => {
    renderClub();
    await waitFor(() => expect(clubsApi.getClub).toHaveBeenCalled());
    vi.clearAllMocks();

    fireVisibility('hidden');

    expect(clubsApi.getClub).not.toHaveBeenCalled();
    expect(clubRecordsApi.listHistory).not.toHaveBeenCalled();
  });

  it('re-joins the club room on resume, not just refetches', async () => {
    // A reconnected socket lands in a new connection with no rooms, so the
    // refetch alone would leave the screen fresh once and then deaf again.
    renderClub();
    await waitFor(() => expect(clubsApi.getClub).toHaveBeenCalled());
    fakeSocket.emit.mockClear();

    fireVisibility('hidden');
    fireVisibility('visible');

    await waitFor(() => expect(fakeSocket.emit).toHaveBeenCalledWith('club:join', 'c1'));
  });

  it('asks a connected socket to prove it, and leaves one that answers alone', async () => {
    // The zombie case: a socket that says `connected` after a screen lock may
    // be dead underneath, and the heartbeat takes 45 seconds to notice. The
    // screen asks the server to acknowledge the join it already sends; an
    // answer means the socket is fine and nothing is torn down.
    renderClub();
    await waitFor(() => expect(clubsApi.getClub).toHaveBeenCalled());
    vi.clearAllMocks();

    fireVisibility('hidden');
    fireVisibility('visible');

    await waitFor(() => expect(emitWithAck).toHaveBeenCalledWith('club:join', 'c1'));
    expect(fakeSocket.timeout).toHaveBeenCalled();
    await act(async () => {});
    expect(fakeSocket.disconnect).not.toHaveBeenCalled();
    expect(fakeSocket.connect).not.toHaveBeenCalled();
  });

  it('forces a reconnect when a connected socket does not answer in time', async () => {
    renderClub();
    await waitFor(() => expect(clubsApi.getClub).toHaveBeenCalled());
    vi.clearAllMocks();
    emitWithAck.mockRejectedValueOnce(new Error('operation has timed out'));

    fireVisibility('hidden');
    fireVisibility('visible');

    await waitFor(() => expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1));
    expect(fakeSocket.connect).toHaveBeenCalledTimes(1);
  });

  it('reconnects as well as refetching when the socket is actually down', async () => {
    renderClub();
    await waitFor(() => expect(clubsApi.getClub).toHaveBeenCalled());
    vi.clearAllMocks();

    fakeSocket.connected = false;
    fireVisibility('hidden');
    fireVisibility('visible');

    expect(fakeSocket.connect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(clubsApi.getClub).toHaveBeenCalledTimes(1));
  });
});
