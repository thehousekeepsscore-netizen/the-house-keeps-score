import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * The dashboard's tabs are addresses, not component state.
 *
 * Before this, browser Back on /browse or /create left the application: nothing
 * on this screen had ever added a history entry, so the platform's own Back
 * gesture — on a phone, the edge swipe, which is muscle memory — threw the user
 * out of the app rather than moving them one step back.
 *
 * These tests drive the real component through a real router, because the bug
 * they guard against is not visible in the component's own render output. The
 * tab looked perfectly correct the whole time; it was the history stack that
 * was empty.
 */

// ResourceCacheProvider reads the signed-in identity so it can wipe the cache
// when it changes. These tests are about addresses, so a fixed identity is
// enough and saves standing up the whole auth stack.
vi.mock('../lib/auth-context', async () => {
  const actual = await vi.importActual<typeof import('../lib/auth-context')>('../lib/auth-context');
  return {
    ...actual,
    useAuth: () => ({
      user: { uid: 'u1', email: 'host@test.local', displayName: 'Host', profileComplete: true },
      status: 'authenticated',
      logout: vi.fn(),
      authError: null,
      clearAuthError: vi.fn(),
    }),
  };
});

vi.mock('../lib/clubs-api', async () => {
  const actual = await vi.importActual<typeof import('../lib/clubs-api')>('../lib/clubs-api');
  return { ...actual, listClubsRaw: vi.fn(), listJoinRequests: vi.fn() };
});

import { ClubDashboardView } from './ClubDashboardView';
import { ResourceCacheProvider } from '../lib/resource-cache';
import { TAB_TO_PATH } from '../lib/dashboard-tabs';
import * as clubsApi from '../lib/clubs-api';

const currentUser = {
  uid: 'u1',
  email: 'host@test.local',
  displayName: 'Host',
  photoURL: '',
  profileComplete: true,
} as unknown as React.ComponentProps<typeof ClubDashboardView>['currentUser'];

function renderDashboardAt(initialPath: string) {
  const element = (
    <ClubDashboardView
      currentUser={currentUser}
      playerAvatarUrl=""
      onSelectClub={() => {}}
      onProceedToLobby={() => {}}
      onSignOut={() => {}}
    />
  );

  // One route per tab, generated from the same map App.tsx uses — so if a tab
  // ever loses its route in the real app, it loses it here too.
  const router = createMemoryRouter(
    Object.values(TAB_TO_PATH).map((path) => ({ path, element })),
    { initialEntries: [initialPath] }
  );

  render(
    <ResourceCacheProvider>
      <RouterProvider router={router} />
    </ResourceCacheProvider>
  );

  return router;
}

describe('dashboard tabs are addressable', () => {
  // test-setup.ts restores all mocks after every test, which strips the
  // implementations a vi.mock factory installs at import time. They are set
  // here instead so every test starts with them in place.
  //
  // Empty lists are enough: these tests are about addresses, not content, and
  // an empty dashboard still renders every tab and the whole nav bar.
  beforeEach(() => {
    vi.mocked(clubsApi.listClubsRaw).mockResolvedValue([]);
    vi.mocked(clubsApi.listJoinRequests).mockResolvedValue([]);
  });

  it('opens the tab named by the URL, not always the default', async () => {
    const router = renderDashboardAt(TAB_TO_PATH.browse);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(TAB_TO_PATH.browse)
    );
    expect(await screen.findByText(/browse all active poker clubs/i)).toBeInTheDocument();
  });

  it('pushes a history entry when a tab is selected', async () => {
    const user = userEvent.setup();
    const router = renderDashboardAt(TAB_TO_PATH.myClubs);

    await user.click(await screen.findByRole('button', { name: /browse/i }));

    await waitFor(() => expect(router.state.location.pathname).toBe(TAB_TO_PATH.browse));
  });

  it('Back returns to the previous tab instead of leaving the app', async () => {
    const user = userEvent.setup();
    const router = renderDashboardAt(TAB_TO_PATH.myClubs);

    await user.click(await screen.findByRole('button', { name: /browse/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe(TAB_TO_PATH.browse));

    // The gesture under test: on a phone this is the edge swipe.
    await router.navigate(-1);

    await waitFor(() => expect(router.state.location.pathname).toBe(TAB_TO_PATH.myClubs));
  });

  it('Forward returns to the tab Back left, so the pair is symmetric', async () => {
    const user = userEvent.setup();
    const router = renderDashboardAt(TAB_TO_PATH.myClubs);

    await user.click(await screen.findByRole('button', { name: /browse/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe(TAB_TO_PATH.browse));

    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.pathname).toBe(TAB_TO_PATH.myClubs));

    await router.navigate(1);
    await waitFor(() => expect(router.state.location.pathname).toBe(TAB_TO_PATH.browse));
  });

  it('walks a three-tab trail back one step at a time', async () => {
    const user = userEvent.setup();
    const router = renderDashboardAt(TAB_TO_PATH.myClubs);

    await user.click(await screen.findByRole('button', { name: /browse/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe(TAB_TO_PATH.browse));

    await user.click(await screen.findByRole('button', { name: /create/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe(TAB_TO_PATH.create));

    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.pathname).toBe(TAB_TO_PATH.browse));

    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.pathname).toBe(TAB_TO_PATH.myClubs));
  });
});
