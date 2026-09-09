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

  /**
   * Below: the socket admits it is down. Measured on the production bundle,
   * this case used to cost two full passes — one on resume, one 1.3 seconds
   * later when socket.io reconnected. Now the resume re-joins and reconnects
   * but leaves the refetch to `connect`, which covers the whole gap; a bounded
   * fallback refetches over HTTP if no `connect` comes.
   */

  /**
   * A `connect` as the socket would deliver it: every listener still
   * registered, in order. More than one exists — useSocketConnection tracks
   * state on the same event — and an effect that re-ran has removed its old
   * listener with `off`, so those are excluded rather than fired twice.
   */
  const connectHandler = () => {
    const live = new Set(
      fakeSocket.on.mock.calls.filter(([event]) => event === 'connect').map(([, fn]) => fn as () => void)
    );
    for (const [event, fn] of fakeSocket.off.mock.calls) if (event === 'connect') live.delete(fn as () => void);
    if (live.size === 0) throw new Error('no connect listener registered');
    return () => { for (const fn of live) fn(); };
  };

  it('DOWN + connect — reconnects, re-joins on both triggers, and refetches exactly once', async () => {
    renderClub();
    await waitFor(() => expect(clubsApi.getClub).toHaveBeenCalled());
    const onConnect = connectHandler();
    vi.clearAllMocks();
    vi.useFakeTimers();
    try {
      fakeSocket.connected = false;
      fireVisibility('hidden');
      fireVisibility('visible');

      expect(fakeSocket.connect).toHaveBeenCalledTimes(1);
      expect(fakeSocket.emit).toHaveBeenCalledWith('club:join', 'c1');
      // Nothing yet: the refetch waits for the socket.
      expect(clubsApi.getClub).not.toHaveBeenCalled();

      await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
      fakeSocket.connected = true;
      await act(async () => { onConnect(); });

      expect(clubsApi.getClub).toHaveBeenCalledTimes(1);
      expect(clubRecordsApi.listHistory).toHaveBeenCalledTimes(1);
      expect(clubRecordsApi.listPotLog).toHaveBeenCalledTimes(1);
      expect(offlineSessionsApi.getActiveSession).toHaveBeenCalledTimes(1);
      // Both triggers re-joined the room.
      expect(fakeSocket.emit.mock.calls.filter(([e, id]) => e === 'club:join' && id === 'c1')).toHaveLength(2);

      // And the fallback never adds a second pass.
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(clubsApi.getClub).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('DOWN, no connect — still refetches, over HTTP, after the fallback', async () => {
    renderClub();
    await waitFor(() => expect(clubsApi.getClub).toHaveBeenCalled());
    vi.clearAllMocks();
    vi.useFakeTimers();
    try {
      fakeSocket.connected = false;
      fireVisibility('hidden');
      fireVisibility('visible');
      expect(fakeSocket.connect).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(2999); });
      expect(clubsApi.getClub).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(clubsApi.getClub).toHaveBeenCalledTimes(1);
      expect(clubRecordsApi.listHistory).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('connect alone refetches once; a duplicate connect moments later does not', async () => {
    renderClub();
    await waitFor(() => expect(clubsApi.getClub).toHaveBeenCalled());
    const onConnect = connectHandler();
    vi.clearAllMocks();

    await act(async () => { onConnect(); });
    await act(async () => { onConnect(); });
    expect(clubsApi.getClub).toHaveBeenCalledTimes(1);
    expect(clubRecordsApi.listHistory).toHaveBeenCalledTimes(1);
    expect(fakeSocket.emit.mock.calls.filter(([e]) => e === 'club:join')).toHaveLength(2);
  });

  it('a probe-forced reconnect after a connected resume refetches again — the first pass ran over a dead socket', async () => {
    renderClub();
    await waitFor(() => expect(clubsApi.getClub).toHaveBeenCalled());
    const onConnect = connectHandler();
    vi.clearAllMocks();
    emitWithAck.mockRejectedValueOnce(new Error('operation has timed out'));

    fireVisibility('hidden');
    fireVisibility('visible');
    await waitFor(() => expect(clubsApi.getClub).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1));

    // The real probe waits three seconds before giving up; the `connect` that
    // follows is well outside the duplicate guard.
    vi.useFakeTimers();
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      await act(async () => { onConnect(); });
      expect(clubsApi.getClub).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
