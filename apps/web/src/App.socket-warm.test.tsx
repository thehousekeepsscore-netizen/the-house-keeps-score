import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * The socket handshake starts before the club screen exists.
 *
 * ClubDetailView is lazily loaded, so opening a club spends a chunk download
 * and a club fetch in ClubRoute first. Until this, the handshake began after
 * all of that — ClubDetailView's own effect was the first caller of
 * getSocket() — which meant the socket was reliably not connected when that
 * effect ran, and the screen took the cold path: fetch everything, connect a
 * few hundred milliseconds later, then force the same eight requests again.
 *
 * Starting the handshake here overlaps it with work already happening, so the
 * screen usually mounts onto a connected socket and takes the branch that
 * emits club:join without a second round.
 */

const getSocketSpy = vi.fn(() => ({
  connected: false,
  active: true,
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('./lib/socket', () => ({
  getSocket: () => getSocketSpy(),
  resetSocket: vi.fn(),
}));

vi.mock('./lib/auth-context', async () => {
  const actual = await vi.importActual<typeof import('./lib/auth-context')>('./lib/auth-context');
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

vi.mock('./lib/clubs-api', async () => {
  const actual = await vi.importActual<typeof import('./lib/clubs-api')>('./lib/clubs-api');
  return { ...actual, getClub: vi.fn(async () => new Promise(() => {})) };
});

import { ClubRoute } from './App';
import { ResourceCacheProvider } from './lib/resource-cache';

const currentUser = {
  uid: 'host',
  email: 'host@test.local',
  displayName: 'Host',
  profileComplete: true,
} as never;

function renderRoute() {
  const router = createMemoryRouter(
    [
      {
        path: '/clubs/:clubId',
        element: (
          <ResourceCacheProvider>
            <ClubRoute currentUser={currentUser} playerAvatarUrl="" />
          </ResourceCacheProvider>
        ),
      },
    ],
    { initialEntries: ['/clubs/c1'] }
  );
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  getSocketSpy.mockClear();
});

describe('opening a club starts the handshake before the screen loads', () => {
  it('creates the socket while the club route is still resolving', () => {
    // getClub never settles here, so the route is still on its skeleton — the
    // handshake has to have started anyway, which is the whole point.
    renderRoute();

    expect(getSocketSpy).toHaveBeenCalled();
  });

  it('does not open a second connection when the route re-renders', () => {
    const { rerender } = renderRoute();
    const afterMount = getSocketSpy.mock.calls.length;

    rerender(<div />);

    expect(getSocketSpy.mock.calls.length).toBe(afterMount);
  });
});
