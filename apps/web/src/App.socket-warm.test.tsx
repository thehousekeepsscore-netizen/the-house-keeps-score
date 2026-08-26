import React, { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * The handshake starts when the person signs in, not when they open a club.
 *
 * A Socket.IO connection costs two sequential round trips — the engine.io
 * handshake for a sid, then the namespace CONNECT — which is around half a
 * second against production. The club fetches leave in about twelve
 * milliseconds. So while this lived in ClubRoute, one line above the club
 * fetch, it started at the same instant as the requests it was meant to get
 * ahead of and lost every time: `connect` landed late, its resync refetched all
 * eight resources, and a cold open cost nineteen requests instead of nine.
 *
 * Moving the start to the authenticated App means the handshake overlaps
 * whatever the person does on the dashboard first. The saving is not asserted
 * here — request volume is counted at the wire in
 * ClubDetailView.requests.test.tsx, which already pins both paths at nine.
 * What this file protects is the part that makes that reachable: the socket
 * begins connecting on sign-in, exactly once, and never before there is a
 * token to authenticate it with.
 */

/**
 * Mirrors the real module's singleton, so "did this open a second connection?"
 * is a question the test can actually answer. A plain spy counts calls;
 * getSocket() is deliberately callable many times, and the property worth
 * protecting is that only one socket is ever constructed.
 */
let socketsConstructed = 0;
let singleton: Record<string, unknown> | null = null;
const getSocketSpy = vi.fn(() => {
  if (!singleton) {
    socketsConstructed += 1;
    singleton = { connected: false, active: true, on: vi.fn(), off: vi.fn(), emit: vi.fn(), connect: vi.fn() };
  }
  return singleton;
});

vi.mock('./lib/socket', () => ({
  getSocket: () => getSocketSpy(),
  resetSocket: vi.fn(),
}));

/** Swapped per test so the auth gate can be exercised in both positions. */
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
  return {
    ...actual,
    listClubsRaw: vi.fn(async () => []),
    listJoinRequests: vi.fn(async () => []),
    getClub: vi.fn(async () => new Promise(() => {})),
  };
});

import App, { ClubRoute } from './App';
import { ResourceCacheProvider } from './lib/resource-cache';

const authedUser = {
  uid: 'host',
  email: 'host@test.local',
  displayName: 'Host',
  photoURL: '',
  profileComplete: true,
};

function renderApp(wrapper: 'plain' | 'strict' = 'plain') {
  const tree = (
    <MemoryRouter initialEntries={['/']}>
      <ResourceCacheProvider>
        <App />
      </ResourceCacheProvider>
    </MemoryRouter>
  );
  return render(wrapper === 'strict' ? <StrictMode>{tree}</StrictMode> : tree);
}

beforeEach(() => {
  getSocketSpy.mockClear();
  socketsConstructed = 0;
  singleton = null;
  authState = { user: null, status: 'unauthenticated' };
});

describe('the socket opens on authentication', () => {
  it('starts connecting once the app has an authenticated identity', () => {
    authState = { user: authedUser, status: 'authenticated' };

    renderApp();

    expect(getSocketSpy).toHaveBeenCalled();
    expect(socketsConstructed).toBe(1);
  });

  it('does not open a socket while signed out', () => {
    // The handshake carries the access token, and the server middleware
    // refuses one without it. That refusal is terminal — socket.io calls
    // destroy(), so nothing retries and the connection reports auth-error for
    // the life of the tab. Connecting earlier must not mean connecting logged
    // out, which is the failure this asserts against.
    authState = { user: null, status: 'unauthenticated' };

    renderApp();

    expect(getSocketSpy).not.toHaveBeenCalled();
    expect(socketsConstructed).toBe(0);
  });

  it('does not open a socket while auth is still resolving', () => {
    // 'loading' is the boot refresh deciding whether there is a session at
    // all. There is no token yet, so this is the signed-out case wearing a
    // different label.
    authState = { user: null, status: 'loading' };

    renderApp();

    expect(getSocketSpy).not.toHaveBeenCalled();
  });
});

describe('one socket, however many renders', () => {
  it('does not construct a second socket when the app re-renders', () => {
    authState = { user: authedUser, status: 'authenticated' };
    const { rerender } = renderApp();

    rerender(
      <MemoryRouter initialEntries={['/']}>
        <ResourceCacheProvider>
          <App />
        </ResourceCacheProvider>
      </MemoryRouter>
    );

    expect(socketsConstructed).toBe(1);
  });

  it('does not construct a second socket under StrictMode', () => {
    // StrictMode mounts, unmounts and remounts every effect in development, so
    // an effect that opened a connection per invocation would open two — and
    // the second would be invisible in production, which is the worst place to
    // find it. getSocket() is idempotent by construction; this holds it that
    // way.
    authState = { user: authedUser, status: 'authenticated' };

    renderApp('strict');

    expect(getSocketSpy).toHaveBeenCalled();
    expect(socketsConstructed).toBe(1);
  });
});

describe('the club route no longer starts the handshake itself', () => {
  it('opens no socket of its own', () => {
    // The start used to live here. Leaving it in place as well would not be
    // harmless-but-redundant: it would put the decision about when to connect
    // in two places, and the next person to move one would have no way to know
    // the other existed.
    authState = { user: authedUser, status: 'authenticated' };

    const router = createMemoryRouter(
      [
        {
          path: '/clubs/:clubId',
          element: (
            <ResourceCacheProvider>
              <ClubRoute currentUser={authedUser as never} playerAvatarUrl="" />
            </ResourceCacheProvider>
          ),
        },
      ],
      { initialEntries: ['/clubs/c1'] }
    );
    render(<RouterProvider router={router} />);

    expect(getSocketSpy).not.toHaveBeenCalled();
    expect(socketsConstructed).toBe(0);
  });
});
