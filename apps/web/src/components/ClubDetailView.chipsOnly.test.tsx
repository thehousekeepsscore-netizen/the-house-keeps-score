import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * Chips are the only unit.
 *
 * The app used to let a club declare "N chips = ₹1" and offered a Chips/₹
 * switch on History and the Leaderboard, an "Equivalent Real Bank Cash" line
 * on the buy-in sheet, and a ratio badge on the club card. All of that is
 * gone. Two production clubs still have the old setting stored on their row,
 * and a stale client or an old cached response could still hand this screen
 * an object carrying those fields — so the club in these tests carries them,
 * and the screen must ignore them completely.
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
import type { NormalizedSession } from '../lib/clubRecords-api';

const NOW = Date.parse('2026-09-03T21:00:00.000Z');
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();

const currentUser = {
  uid: 'host',
  email: 'host@test.local',
  displayName: 'Host',
  photoURL: '',
  profileComplete: true,
} as unknown as User;

/**
 * A club exactly as one of the two production clubs would arrive from a
 * pre-removal server or cache: the old setting ON at 5 chips per rupee. The
 * fields are not on the Club type any more, hence the cast.
 */
const clubWithStaleRatio = {
  id: 'c1',
  name: 'Texas Holdem',
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
  createdAt: ago(9999),
  enableDevaluation: true,
  devaluationFactor: 5,
} as unknown as Club;

/** One settled night with figures that would have read differently in rupees. */
const settledNight: NormalizedSession = {
  id: 'cs1',
  sourceType: 'cashout',
  date: '2026-09-01',
  createdAt: '2026-09-01T20:00:00.000Z',
  sessionType: 'Offline Session',
  notes: null,
  totalBuyIns: 25000,
  totalCashOuts: 25000,
  winnersCut: 0,
  rake: 0,
  playersCount: 2,
  playerStats: [
    { name: 'Host', buyIn: 10000, cashOut: 17500, profit: 7500, userId: 'host' },
    { name: 'Priya', buyIn: 15000, cashOut: 7500, profit: -7500, userId: 'priya' },
  ],
  dayNumber: 1,
  dayTitle: 'Day 1',
};

function renderClub() {
  vi.mocked(clubsApi.getClub).mockResolvedValue({
    ...clubWithStaleRatio,
    roster: { host: { displayName: 'Host' }, priya: { displayName: 'Priya' } },
  } as never);
  vi.mocked(clubRecordsApi.listHistory).mockResolvedValue([settledNight]);
  vi.mocked(clubRecordsApi.getLeaderboard).mockResolvedValue([
    { userId: 'host', name: 'Host', netProfit: 7500, sessionsPlayed: 1, totalBuyIns: 10000, totalCashOuts: 17500, biggestWin: 7500, biggestLoss: 0 },
    { userId: 'priya', name: 'Priya', netProfit: -7500, sessionsPlayed: 1, totalBuyIns: 15000, totalCashOuts: 7500, biggestWin: 0, biggestLoss: -7500 },
  ]);
  vi.mocked(clubRecordsApi.listPotLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPendingChanges).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listAuditLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listDeletedSessions).mockResolvedValue([]);
  vi.mocked(offlineSessionsApi.getActiveSession).mockResolvedValue(null);
  vi.mocked(offlineSessionsApi.listBuyInRequests).mockResolvedValue([]);
  __resetSheetHistory();

  const element = (
    <ResourceCacheProvider>
      <ClubDetailView
        club={clubWithStaleRatio}
        currentUser={currentUser}
        playerAvatarUrl=""
        onBackToDashboard={vi.fn()}
      />
    </ResourceCacheProvider>
  );
  // Tabs navigate to /clubs/:clubId/:tab, so both routes are needed.
  const router = createMemoryRouter(
    [
      { path: '/clubs/:clubId', element },
      { path: '/clubs/:clubId/:tab', element },
    ],
    { initialEntries: ['/clubs/c1'] }
  );
  return render(<RouterProvider router={router} />);
}

const settled = () => waitFor(() => expect(clubsApi.getClub).toHaveBeenCalled());

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a club whose row still carries the old ratio', () => {
  it('shows no ratio badge on the club card', async () => {
    renderClub();
    await settled();
    expect(screen.queryByText(/chips = ₹1/i)).toBeNull();
  });

  it('offers no Chips/₹ switch on History, and every figure there is in chips', async () => {
    renderClub();
    await settled();
    fireEvent.click(screen.getAllByRole('button', { name: /history/i })[0]);
    await screen.findByText(/Completed Sessions:/i);

    expect(screen.queryByRole('button', { name: '₹' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^chips$/i })).toBeNull();
    // Expand the night to reach the per-player figures.
    fireEvent.click(screen.getByText('Day 1'));
    expect(await screen.findByText('+7,500 Chips')).toBeInTheDocument();
    expect(screen.getByText('-7,500 Chips')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('₹');
  });

  it('offers no switch on the Leaderboard either, and reads in chips', async () => {
    renderClub();
    await settled();
    fireEvent.click(screen.getAllByRole('button', { name: /leaderboard|ranks/i })[0]);
    // The leader appears on the podium and in the table, so at least one.
    expect((await screen.findAllByText('+7,500 Chips')).length).toBeGreaterThanOrEqual(1);

    expect(screen.queryByRole('button', { name: '₹' })).toBeNull();
    expect(document.body.textContent).not.toContain('₹');
    // Not the rupee reading the stale factor would have produced.
    expect(document.body.textContent).not.toContain('1,500');
  });
});
