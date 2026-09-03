import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * Editing a settled night: whether the buy-in is a field or a figure.
 *
 * The server derives a night's buy-ins from approved banks and says so on the
 * record (`buyInSource: 'approved-banks'`); on any edit of such a night it
 * derives them again and ignores the form. A field for that number would
 * accept typing that changes nothing, so the edit form shows it as the settle
 * sheet does (#90): a figure, captioned with where it came from.
 *
 * Every other record keeps the field. That is not a leftover: most settled
 * nights in production predate the stamp, and one of them holds buy-ins typed
 * on purpose that no bank can reproduce. The server honours the form for those,
 * so the form must offer one. The branch is on the marker, never on sourceType.
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
import type { NormalizedSession } from '../lib/clubRecords-api';
import { Club } from '../types';
import type { AppUser as User } from '../lib/auth-types';

const currentUser = {
  uid: 'host',
  email: 'host@test.local',
  displayName: 'Host',
  photoURL: '',
  profileComplete: true,
} as unknown as User;

const club = {
  id: 'c1',
  name: 'Friday Night',
  code: '60781',
  ownerUid: 'host',
  createdBy: 'host',
  adminUids: [],
  memberUids: ['host', 'priya'],
  isMember: true,
  isAdmin: true,
  isOwner: true,
  minBuyIn: 1000,
  maxBuyIn: 5000,
  buyInMode: 'MATCH_HIGHEST',
  memberCount: 2,
  adminCount: 1,
  maxCapacity: 50,
  createdAt: '2026-08-01T00:00:00.000Z',
  potEnabled: false,
  rakeEnabled: false,
  sessionRakeAmount: 0,
  winnersCutPercent: 0,
  mismatchStrategy: 'PROPORTIONAL_WINNERS',
  rakeOrder: 'MISMATCH_FIRST',
  winnerDefinition: 'PROFIT_POSITIVE',
  winnerTopN: 1,
  roundingRule: 'NONE',
  clubPotBalance: 0,
} as unknown as Club;

const players = [
  { name: 'Host', buyIn: 5000, cashOut: 6000, profit: 1000, userId: 'host' },
  { name: 'Priya', buyIn: 5000, cashOut: 4000, profit: -1000, userId: 'priya' },
];

/** One settled night, shaped as the history endpoint returns it. */
function night(id: string, over: Partial<NormalizedSession> = {}): NormalizedSession {
  return {
    id,
    sourceType: 'cashout',
    date: '2026-08-30',
    createdAt: '2026-08-30T21:00:00.000Z',
    sessionType: 'Offline Session',
    notes: null,
    totalBuyIns: 10000,
    totalCashOuts: 10000,
    winnersCut: 0,
    rake: 0,
    playersCount: 2,
    playerStats: players,
    dayNumber: 1,
    dayTitle: 'Day 1',
    ...over,
  };
}

function renderHistory(items: NormalizedSession[]) {
  vi.mocked(clubsApi.getClub).mockResolvedValue({
    ...club,
    roster: { host: { displayName: 'Host' }, priya: { displayName: 'Priya' } },
  } as never);
  vi.mocked(clubRecordsApi.listHistory).mockResolvedValue(items);
  vi.mocked(clubRecordsApi.getLeaderboard).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPotLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPendingChanges).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listAuditLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listDeletedSessions).mockResolvedValue([]);
  vi.mocked(offlineSessionsApi.getActiveSession).mockResolvedValue(null as never);
  vi.mocked(offlineSessionsApi.listBuyInRequests).mockResolvedValue([]);
  __resetSheetHistory();

  const element = (
    <ResourceCacheProvider>
      <ClubDetailView
        club={club}
        currentUser={currentUser}
        playerAvatarUrl=""
        onBackToDashboard={vi.fn()}
      />
    </ResourceCacheProvider>
  );
  // The tab bar navigates to /clubs/:clubId/:tab, so the router has to know
  // that shape or the History tap lands on a 404 boundary (roles test).
  const router = createMemoryRouter(
    [
      { path: '/clubs/:clubId', element },
      { path: '/clubs/:clubId/:tab', element },
    ],
    { initialEntries: ['/clubs/c1'] }
  );
  return render(<RouterProvider router={router} />);
}

/** History tab → expand the one night → its Edit control → the edit form. */
async function openEditFor(item: NormalizedSession) {
  renderHistory([item]);
  await waitFor(() => expect(clubRecordsApi.listHistory).toHaveBeenCalled());
  fireEvent.click(screen.getAllByRole('button', { name: /history/i })[0]);
  fireEvent.click(await screen.findByText(item.dayTitle));
  fireEvent.click(await screen.findByTitle(/edit session date/i));
  // The edit form is a plain overlay, not a Sheet, so it has no dialog role;
  // its heading is the anchor, and the form beneath it is the scope.
  const heading = await screen.findByRole('heading', { name: /edit session/i });
  const form = heading.closest('.furniture')?.querySelector('form');
  if (!form) throw new Error('edit form not found beneath its heading');
  return within(form as HTMLElement);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('a night the server settled from approved banks', () => {
  it('shows each buy-in as a figure, not a field', async () => {
    const form = await openEditFor(night('cs1', { buyInSource: 'approved-banks' }));

    const shown = form.getByTestId('edit-buyin-0');
    expect(shown.querySelector('input'), 'no input hiding inside it').toBeNull();
    expect(shown).toHaveTextContent('5,000');
    expect(form.getByTestId('edit-buyin-1')).toHaveTextContent('5,000');
  });

  it('says where the figure comes from', async () => {
    const form = await openEditFor(night('cs1', { buyInSource: 'approved-banks' }));
    expect(form.getAllByText(/from approved banks/i)).toHaveLength(2);
  });

  it('leaves the cash-out typeable', async () => {
    const form = await openEditFor(night('cs1', { buyInSource: 'approved-banks' }));
    const numbers = form.getAllByRole('spinbutton');
    expect(numbers, 'one number field per player: the cash-out').toHaveLength(2);
  });
});

describe('a night settled before the server derived buy-ins', () => {
  it('keeps the buy-in as a field', async () => {
    // No marker: the eight pre-#90 production nights, and the 9 Aug one whose
    // buy-ins hold corrections no bank can reproduce.
    const form = await openEditFor(night('cs2'));

    expect(form.queryByTestId('edit-buyin-0')).toBeNull();
    expect(form.queryByText(/from approved banks/i)).toBeNull();
    // Two number fields per player: buy-in and cash-out.
    expect(form.getAllByRole('spinbutton')).toHaveLength(4);
  });

  it('is decided by the marker, not by sourceType', async () => {
    // Same sourceType as the stamped night above; the only difference is the
    // marker, and the only difference on screen must follow from it.
    const form = await openEditFor(night('cs3', { sourceType: 'cashout' }));
    expect(form.queryByTestId('edit-buyin-0')).toBeNull();
  });
});

describe('a back-dated night', () => {
  it('is unchanged: buy-in stays a field', async () => {
    const form = await openEditFor(night('h1', { sourceType: 'historical' }));

    expect(form.queryByTestId('edit-buyin-0')).toBeNull();
    expect(form.getAllByRole('spinbutton')).toHaveLength(4);
  });
});
