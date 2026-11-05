import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * A request to join the wrong club can be taken back.
 *
 * The browse card used to show a disabled "Request pending" and nothing else,
 * so the request sat there until an admin noticed. It now offers "Cancel
 * request" beside the status; a failure is shown beside the button, not in an
 * alert, and the list refreshes either way.
 */

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
  return { ...actual, listClubsRaw: vi.fn(), listJoinRequests: vi.fn(), cancelJoinRequest: vi.fn() };
});

import { ClubDashboardView } from './ClubDashboardView';
import { ResourceCacheProvider } from '../lib/resource-cache';
import { TAB_TO_PATH } from '../lib/dashboard-tabs';
import * as clubsApi from '../lib/clubs-api';
import type { ClubJoinRequest } from '../types';

type RawClub = Awaited<ReturnType<typeof clubsApi.listClubsRaw>>[number];

const currentUser = {
  uid: 'u1', email: 'host@test.local', displayName: 'Host', photoURL: '', profileComplete: true,
} as unknown as React.ComponentProps<typeof ClubDashboardView>['currentUser'];

const club = {
  id: 'c2', name: 'The Standing Eight', code: '22222', description: '', memberCount: 4, adminCount: 1,
  maxCapacity: 50, isMember: false, isAdmin: false, isOwner: false, admins: [], members: [],
} as unknown as RawClub;

const pending: ClubJoinRequest = {
  id: 'jr1', clubId: 'c2', clubName: 'The Standing Eight', userId: 'u1', userDisplayName: 'Host',
  status: 'pending', createdAt: '2026-10-29T10:00:00.000Z',
};

function renderAt(path: string) {
  const element = (
    <ClubDashboardView
      currentUser={currentUser}
      playerAvatarUrl=""
      onSelectClub={() => {}}
      onProceedToLobby={() => {}}
      onSignOut={() => {}}
    />
  );
  const router = createMemoryRouter(Object.values(TAB_TO_PATH).map((p) => ({ path: p, element })), {
    initialEntries: [path],
  });
  render(
    <ResourceCacheProvider>
      <RouterProvider router={router} />
    </ResourceCacheProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(clubsApi.listClubsRaw).mockResolvedValue([club]);
});

describe('a pending request to join', () => {
  it('offers Cancel request beside its status on the browse card', async () => {
    vi.mocked(clubsApi.listJoinRequests).mockResolvedValue([pending]);
    renderAt(TAB_TO_PATH.browse);
    expect(await screen.findByText(/request pending/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel request/i })).toBeInTheDocument();
  });

  it('cancels it and refreshes, so the card offers to ask again', async () => {
    vi.mocked(clubsApi.listJoinRequests).mockResolvedValueOnce([pending]).mockResolvedValue([]);
    vi.mocked(clubsApi.cancelJoinRequest).mockResolvedValue();
    renderAt(TAB_TO_PATH.browse);
    fireEvent.click(await screen.findByRole('button', { name: /cancel request/i }));

    await waitFor(() => expect(clubsApi.cancelJoinRequest).toHaveBeenCalledWith('c2', 'jr1'));
    expect(await screen.findByRole('button', { name: /request to join/i })).toBeInTheDocument();
  });

  it('shows a failure beside the button, never an alert', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.mocked(clubsApi.listJoinRequests).mockResolvedValue([pending]);
    vi.mocked(clubsApi.cancelJoinRequest).mockRejectedValue(new Error('This request has already been decided'));
    renderAt(TAB_TO_PATH.browse);
    fireEvent.click(await screen.findByRole('button', { name: /cancel request/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already been decided/i);
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it('can also be cancelled from the sent-requests list', async () => {
    vi.mocked(clubsApi.listJoinRequests).mockResolvedValue([pending]);
    vi.mocked(clubsApi.cancelJoinRequest).mockResolvedValue();
    renderAt(TAB_TO_PATH.requests);
    fireEvent.click(await screen.findByRole('button', { name: /cancel request to join the standing eight/i }));
    await waitFor(() => expect(clubsApi.cancelJoinRequest).toHaveBeenCalledWith('c2', 'jr1'));
  });
});
