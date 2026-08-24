import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The three developer routes still render after being code-split.
 *
 * /debug/table and /debug/session were statically imported, so they shipped in
 * the entry chunk — and because they render the real live-session components,
 * they dragged the whole session tree in with them: 38.6 kB reachable only from
 * two unlinked URLs, on the critical path of every visitor including anyone
 * still looking at the login screen.
 *
 * Splitting them is only safe if they still work, and "still works" for a lazy
 * route means the chunk resolves and the component paints — not that the import
 * statement parses. These tests therefore mount the real App at the real path
 * and wait for the real Suspense boundary to settle, which is the only part of
 * this that a broken split would fail.
 */

vi.mock('./lib/auth-context', async () => {
  const actual = await vi.importActual<typeof import('./lib/auth-context')>('./lib/auth-context');
  return {
    ...actual,
    useAuth: () => ({
      user: {
        uid: 'u1',
        email: 'host@test.local',
        displayName: 'Host',
        photoURL: '',
        profileComplete: true,
      },
      status: 'authenticated',
      phase: 'ready',
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

// The debug previews are self-contained fixtures, but App itself mounts the
// dashboard cache plumbing; keep the network out of it.
vi.mock('./lib/clubs-api', async () => {
  const actual = await vi.importActual<typeof import('./lib/clubs-api')>('./lib/clubs-api');
  return {
    ...actual,
    listClubsRaw: vi.fn(async () => []),
    listJoinRequests: vi.fn(async () => []),
    getClub: vi.fn(async () => new Promise(() => {})),
  };
});

vi.mock('./lib/socket', () => ({
  getSocket: () => ({
    connected: false,
    active: true,
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    connect: vi.fn(),
  }),
  resetSocket: vi.fn(),
}));

import App from './App';
import { ResourceCacheProvider } from './lib/resource-cache';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ResourceCacheProvider>
        <App />
      </ResourceCacheProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the code-split developer routes still render', () => {
  it('/debug/table resolves its chunk and paints TablePreview', async () => {
    renderAt('/debug/table');

    // findBy* waits for the Suspense boundary: on a lazy route this is the
    // assertion that the dynamic import actually resolved.
    expect(await screen.findByText('waiting for you')).toBeInTheDocument();
  });

  it('/debug/session resolves its chunk and paints SessionPreview', async () => {
    renderAt('/debug/session');

    // Text only the real LiveSession tree renders — the felt, the queue and the
    // buy-in ceiling. If the chunk failed to resolve, Suspense would still be
    // showing the skeleton and none of this would exist.
    expect(await screen.findByText('Max buy-in')).toBeInTheDocument();
    expect(await screen.findByText('Awaiting approval')).toBeInTheDocument();
  });

  it('/debug/performance is unaffected and still resolves', async () => {
    // Already lazy before this change; asserted so the split cannot regress the
    // route it was modelled on.
    renderAt('/debug/performance');

    expect(await screen.findByText('Performance')).toBeInTheDocument();
  });
});
