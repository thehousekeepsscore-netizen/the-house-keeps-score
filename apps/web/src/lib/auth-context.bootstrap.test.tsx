import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The startup refresh goes through the shared refresh, and only through it.
 *
 * It used to call the endpoint directly, which made it the one refresh path
 * that did not share the in-flight request with 401-triggered refreshes. The
 * server rotates the cookie on every refresh and reads a duplicate as theft,
 * so that split was a live way to sign a real user out. These pin the new
 * route and the gating around it: nothing is fetched while the phase is
 * `refreshing`, a false answer signs out, a true one proceeds to `/auth/me`.
 */

const { resetSocket, apiFetch, refreshAccessToken, setAccessToken } = vi.hoisted(() => ({
  resetSocket: vi.fn(),
  apiFetch: vi.fn(),
  refreshAccessToken: vi.fn(),
  setAccessToken: vi.fn(),
}));

vi.mock('./socket', () => ({ resetSocket, getSocket: vi.fn() }));
vi.mock('./api-client', async () => {
  const actual = await vi.importActual<typeof import('./api-client')>('./api-client');
  return { ...actual, apiFetch, refreshAccessToken, setAccessToken };
});

import { AuthProvider, useAuth } from './auth-context';

const me = { id: 'u1', email: 'u1@test.local', displayName: 'U1', avatarUrl: null, profileComplete: true };

const Probe: React.FC = () => {
  const { status, phase, user } = useAuth();
  return <span data-testid="state">{`${status}|${phase}|${user?.uid ?? 'none'}`}</span>;
};

function renderProvider() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </MemoryRouter>
  );
}

/** A refresh that resolves when the test says so. */
function deferredRefresh() {
  let resolve!: (ok: boolean) => void;
  refreshAccessToken.mockImplementation(() => new Promise<boolean>((r) => { resolve = r; }));
  return (ok: boolean) => act(async () => { resolve(ok); });
}

beforeEach(() => {
  apiFetch.mockReset();
  refreshAccessToken.mockReset();
  setAccessToken.mockReset();
  resetSocket.mockClear();
});

describe('the boot refresh', () => {
  it('uses the shared refresh, not the endpoint directly', async () => {
    refreshAccessToken.mockResolvedValue(true);
    apiFetch.mockResolvedValue(me);
    renderProvider();

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('authenticated|authenticated|u1'));
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    // No direct call to the refresh endpoint anywhere on the boot path.
    expect(apiFetch.mock.calls.map((c) => c[0])).not.toContain('/auth/refresh');
    expect(apiFetch).toHaveBeenCalledWith('/auth/me');
  });

  it('fetches nothing else while the refresh is in flight, and only then asks who I am', async () => {
    const answer = deferredRefresh();
    renderProvider();

    await waitFor(() => expect(refreshAccessToken).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('state')).toHaveTextContent('loading|refreshing|none');
    expect(apiFetch, 'the gate holds: no request can 401 and race the refresh').not.toHaveBeenCalled();

    apiFetch.mockResolvedValue(me);
    await answer(true);

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('authenticated|authenticated|u1'));
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('a refused refresh signs out without touching the endpoint again', async () => {
    refreshAccessToken.mockResolvedValue(false);
    renderProvider();

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('unauthenticated|unauthenticated|none'));
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('does not store an access token itself — the shared refresh already did', async () => {
    refreshAccessToken.mockResolvedValue(true);
    apiFetch.mockResolvedValue(me);
    renderProvider();

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('authenticated'));
    // The old path set the token from its own response; the shared refresh
    // owns that now, so a second write here would be a second source of truth.
    expect(setAccessToken).not.toHaveBeenCalled();
  });
});
