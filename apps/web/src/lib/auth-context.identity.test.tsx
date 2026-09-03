import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The socket does not survive a change of identity.
 *
 * Signing out here is pure client state — no page reload — so anything holding
 * server state across the transition carries it to the next person. The socket
 * is the worse of the two the app guards: its rooms live on the server, keyed
 * to a connection the new user never opened, so without this the next person on
 * that tab receives live events for clubs they are not in.
 *
 * This became worth pinning down when the handshake moved to the authenticated
 * App. Before, the socket was opened by the club screen, so a signed-out user
 * had no socket by construction. Now it opens on sign-in, which puts real
 * weight on the reset firing on the way back out — and nothing asserted it.
 *
 * The transitions are driven through the provider's own login/logout rather
 * than by feeding it a uid prop, because the reset watches state the provider
 * owns. A harness that sets the uid from outside would assert against its own
 * input and pass no matter what the provider did.
 */

const { resetSocket, apiFetch, refreshAccessToken } = vi.hoisted(() => ({
  resetSocket: vi.fn(),
  apiFetch: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

vi.mock('./socket', () => ({ resetSocket, getSocket: vi.fn() }));

vi.mock('./api-client', async () => {
  const actual = await vi.importActual<typeof import('./api-client')>('./api-client');
  // The boot refresh now goes through the shared refreshAccessToken rather
  // than apiFetch, so the double has to answer it; false = no session.
  return { ...actual, apiFetch, refreshAccessToken, setAccessToken: vi.fn() };
});

import { AuthProvider, useAuth } from './auth-context';
import { ApiError } from './api-client';

const userRow = (uid: string) => ({
  id: uid,
  email: `${uid}@test.local`,
  displayName: uid,
  avatarUrl: null,
  profileComplete: true,
});

let controls: ReturnType<typeof useAuth>;

const Harness: React.FC = () => {
  controls = useAuth();
  return <span data-testid="uid">{controls.user?.uid ?? 'none'}</span>;
};

function renderProvider() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <Harness />
      </AuthProvider>
    </MemoryRouter>
  );
}

/** The boot refresh, answered as "no session" so tests start signed out. */
function noSession() {
  refreshAccessToken.mockResolvedValue(false);
  apiFetch.mockRejectedValue(new ApiError(401, 'Unauthorized'));
}

async function signIn(uid: string) {
  apiFetch.mockResolvedValueOnce({ accessToken: `token-${uid}`, user: userRow(uid) });
  await act(async () => {
    await controls.login(`${uid}@test.local`, 'pw');
  });
}

async function signOut() {
  apiFetch.mockResolvedValueOnce({});
  await act(async () => {
    await controls.logout();
  });
}

beforeEach(() => {
  resetSocket.mockClear();
  apiFetch.mockReset();
  refreshAccessToken.mockReset();
  noSession();
});

describe('a change of identity drops the shared socket', () => {
  it('does not reset when the first identity arrives', async () => {
    // Signing in is not a change of identity. Resetting here would tear down
    // the socket the App effect opens on exactly this transition, every boot.
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('uid')).toHaveTextContent('none'));

    await signIn('a');

    expect(screen.getByTestId('uid')).toHaveTextContent('a');
    expect(resetSocket).not.toHaveBeenCalled();
  });

  it('resets on sign-out, so the socket cannot outlive the session', async () => {
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('uid')).toHaveTextContent('none'));
    await signIn('a');

    await signOut();

    expect(screen.getByTestId('uid')).toHaveTextContent('none');
    expect(resetSocket).toHaveBeenCalledTimes(1);
  });

  it('resets again when a different person signs in on the same tab', async () => {
    // The full handover: A signs out, B signs in. B must not inherit A's
    // rooms, and the reset on the way out is what guarantees it.
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('uid')).toHaveTextContent('none'));
    await signIn('a');
    await signOut();
    resetSocket.mockClear();

    await signIn('b');

    expect(screen.getByTestId('uid')).toHaveTextContent('b');
    // Signing in from signed-out is a first identity again, so no second
    // teardown is needed — the socket A had was already destroyed above.
    expect(resetSocket).not.toHaveBeenCalled();
  });
});
