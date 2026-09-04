import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * The Club Rules page says what the engine charges.
 *
 * It used to render the older single-rule rake — a "Rake Enabled" switch with
 * a method and a value — which the settlement engine no longer reads. A club
 * charging a 1,000-chip seat fee and a 5% winners' cut every night therefore
 * read as "rake off" on its own rules page, while every settlement collected
 * both. The page now shows the two charges from the two fields the engine
 * uses, and nothing from the fields it does not.
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
import { __resetSheetHistory } from './ui/Sheet';
import * as offlineSessionsApi from '../lib/offlineSessions-api';
import * as clubsApi from '../lib/clubs-api';
import * as clubRecordsApi from '../lib/clubRecords-api';
import type { Club } from '../types';
import type { AppUser as User } from '../lib/auth-types';

const currentUser = {
  uid: 'host',
  email: 'host@test.local',
  displayName: 'Host',
  photoURL: '',
  profileComplete: true,
} as unknown as User;

/** Shaped like the production club whose rules page read "rake off". */
const chargingClub = {
  id: 'c1',
  name: 'All In Poker 2026',
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
  createdAt: '2026-08-31T08:29:15.244Z',
  // What the engine reads.
  sessionRakeAmount: 1000,
  winnersCutPercent: 5,
  potEnabled: true,
  // The legacy single-rule rake, off — which the page used to show instead.
  rakeEnabled: false,
  rakeMethod: 'PERCENT_PROFIT',
  rakeValue: 5,
  mismatchStrategy: 'PROPORTIONAL_WINNERS',
  rakeOrder: 'MISMATCH_FIRST',
  winnerDefinition: 'PROFIT_POSITIVE',
  winnerTopN: 1,
  roundingRule: 'NONE',
} as unknown as Club;

const freeClub = {
  ...chargingClub,
  id: 'c2',
  name: 'Free Table',
  sessionRakeAmount: 0,
  winnersCutPercent: 0,
  // Legacy switch ON here, to prove the page no longer reads it either way.
  rakeEnabled: true,
} as unknown as Club;

function renderClub(club: Club) {
  vi.mocked(clubsApi.getClub).mockResolvedValue({ ...club, roster: { host: { displayName: 'Host' } } } as never);
  vi.mocked(clubRecordsApi.listHistory).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.getLeaderboard).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPotLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPendingChanges).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listAuditLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listDeletedSessions).mockResolvedValue([]);
  vi.mocked(offlineSessionsApi.getActiveSession).mockResolvedValue(null);
  vi.mocked(offlineSessionsApi.listBuyInRequests).mockResolvedValue([]);
  __resetSheetHistory();

  const element = (
    <ResourceCacheProvider>
      <ClubDetailView club={club} currentUser={currentUser} playerAvatarUrl="" onBackToDashboard={vi.fn()} />
    </ResourceCacheProvider>
  );
  const router = createMemoryRouter(
    [
      { path: '/clubs/:clubId', element },
      { path: '/clubs/:clubId/:tab', element },
    ],
    { initialEntries: [`/clubs/${club.id}`] }
  );
  return render(<RouterProvider router={router} />);
}

/** The real path: Profile → "<club> — Club Settings". */
async function openRules(club: Club) {
  renderClub(club);
  await waitFor(() => expect(clubsApi.getClub).toHaveBeenCalled());
  fireEvent.click(screen.getAllByRole('button', { name: /profile/i })[0]);
  fireEvent.click(await screen.findByRole('button', { name: /club settings/i }));
  await screen.findByText(/rules were fixed when the club was created/i);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the Club Rules page shows the charges the engine applies', () => {
  it('reads the seat fee and the winners cut from the fields the engine uses', async () => {
    await openRules(chargingClub);

    expect(screen.getByTestId('rules-seat-fee')).toHaveTextContent('1,000 Chips per player');
    expect(screen.getByTestId('rules-winners-cut')).toHaveTextContent('5%');
  });

  it('no longer offers the legacy rake switch, method or value', async () => {
    await openRules(chargingClub);

    expect(screen.queryByLabelText(/rake enabled/i)).toBeNull();
    expect(screen.queryByText(/rake method/i)).toBeNull();
    expect(screen.queryByText(/rake value/i)).toBeNull();
    // A club with the legacy switch off and live charges must not read as "rake off".
    expect(document.body.textContent).not.toMatch(/rake enabled/i);
  });

  it('says "none" for either charge at zero, regardless of the legacy switch', async () => {
    await openRules(freeClub);

    expect(screen.getByTestId('rules-seat-fee')).toHaveTextContent('none');
    expect(screen.getByTestId('rules-winners-cut')).toHaveTextContent('none');
    expect(screen.queryByLabelText(/rake enabled/i)).toBeNull();
  });

  it('keeps the collection-order rule visible, which the dead switch used to hide', async () => {
    await openRules(chargingClub);
    expect(screen.getByText(/rake collection order/i)).toBeInTheDocument();
  });
});
