import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * The asker's own ways out, on the club screen.
 *
 * A player's pending request used to render in the host's queue chrome, with
 * approve and reject ticks the server refused, and no way to take it back. It
 * is now a receipt — "waiting for the host" — with one action: Withdraw.
 * And a member can leave the club from their profile sheet; the owner cannot.
 */

vi.mock('../lib/auth-context', async () => {
  const actual = await vi.importActual<typeof import('../lib/auth-context')>('../lib/auth-context');
  return {
    ...actual,
    useAuth: () => ({
      user: { uid: 'host', email: 'host@test.local', displayName: 'Host', profileComplete: true },
      status: 'authenticated',
      logout: vi.fn(),
      updateProfile: vi.fn(),
      authError: null,
      clearAuthError: vi.fn(),
    }),
  };
});

vi.mock('../lib/offlineSessions-api', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/offlineSessions-api')>('../lib/offlineSessions-api');
  return {
    ...actual,
    getActiveSession: vi.fn(),
    listBuyInRequests: vi.fn(),
    withdrawBuyInRequest: vi.fn(),
    withdrawSitIn: vi.fn(),
    withdrawCashOut: vi.fn(),
  };
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
  return { ...actual, getClub: vi.fn(), leaveClub: vi.fn() };
});

import { ClubDetailView } from './ClubDetailView';
import { ResourceCacheProvider } from '../lib/resource-cache';
import { __resetSheetHistory } from './ui/Sheet';
import * as offlineSessionsApi from '../lib/offlineSessions-api';
import * as clubsApi from '../lib/clubs-api';
import * as clubRecordsApi from '../lib/clubRecords-api';
import type { Club, PokerSession, BuyInRequest } from '../types';
import type { AppUser as User } from '../lib/auth-types';

const NOW = Date.parse('2026-10-29T20:00:00.000Z');
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();

const currentUser = {
  uid: 'host', email: 'host@test.local', displayName: 'Host', photoURL: '', profileComplete: true,
} as unknown as User;

type Role = 'owner' | 'player';

function clubAs(role: Role): Club {
  return {
    id: 'c1', name: 'Friday Night', code: '60781',
    ownerUid: role === 'owner' ? 'host' : 'boss',
    createdBy: role === 'owner' ? 'host' : 'boss',
    adminUids: [], memberUids: ['boss', 'host', 'priya'],
    isMember: true, isAdmin: role === 'owner', isOwner: role === 'owner',
    minBuyIn: 1000, maxBuyIn: 5000, buyInMode: 'UNCAPPED',
    memberCount: 3, adminCount: 1, maxCapacity: 50, createdAt: ago(9999),
    potEnabled: false, sessionRakeAmount: 0, winnersCutPercent: 0,
    mismatchStrategy: 'PROPORTIONAL_WINNERS', rakeOrder: 'MISMATCH_FIRST',
    winnerDefinition: 'PROFIT_POSITIVE', winnerTopN: 1, roundingRule: 'NONE',
  } as unknown as Club;
}

const rules = {
  capturedAt: ago(90), sessionRakeAmount: 0, winnersCutPercent: 0, rakeEnabled: false,
  rakeMethod: 'PERCENT_PROFIT', rakeValue: 0, potEnabled: false, mismatchStrategy: 'PROPORTIONAL_WINNERS',
  rakeOrder: 'MISMATCH_FIRST', winnerDefinition: 'PROFIT_POSITIVE', winnerTopN: 1, roundingRule: 'NONE',
} as const;

const playing: PokerSession = {
  id: 's1', clubId: 'c1', sessionName: 'Thu 29 Oct · Day 1', status: 'active',
  activePlayerUids: ['boss', 'host', 'priya'], pendingSitInUids: [], sitInRequestedAt: {}, cashOuts: [],
  startedBy: 'boss', createdAt: ago(120), startedPlayingAt: ago(90), timeExtensions: [],
  timeLimitLiftedAt: null, settlingAt: null, settlementRules: rules,
};

const bank = (id: string, userId: string, amount: number, status: BuyInRequest['status'] = 'approved'): BuyInRequest => ({
  id, sessionId: 's1', clubId: 'c1', userId, userDisplayName: '', amount, status, requestedBy: userId, createdAt: ago(5),
});

const roster = { boss: { displayName: 'Boss' }, host: { displayName: 'Host' }, priya: { displayName: 'Priya' } };
const banked = [bank('b1', 'boss', 5000), bank('b2', 'host', 5000), bank('b3', 'priya', 5000)];

function renderAs(role: Role, active: PokerSession | null, buyIns: BuyInRequest[] = banked) {
  const club = clubAs(role);
  const onBack = vi.fn();
  vi.mocked(clubsApi.getClub).mockResolvedValue({ ...club, roster } as never);
  vi.mocked(clubRecordsApi.listHistory).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.getLeaderboard).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPotLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPendingChanges).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listAuditLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listDeletedSessions).mockResolvedValue([]);
  vi.mocked(offlineSessionsApi.getActiveSession).mockResolvedValue(active);
  vi.mocked(offlineSessionsApi.listBuyInRequests).mockResolvedValue(buyIns);
  __resetSheetHistory();
  const element = (
    <ResourceCacheProvider>
      <ClubDetailView club={club} currentUser={currentUser} playerAvatarUrl="" onBackToDashboard={onBack} />
    </ResourceCacheProvider>
  );
  const router = createMemoryRouter([{ path: '/', element }], { initialEntries: ['/'] });
  render(<RouterProvider router={router} />);
  return { onBack };
}

const loaded = () => waitFor(() => expect(offlineSessionsApi.getActiveSession).toHaveBeenCalled());

beforeEach(() => {
  vi.clearAllMocks();
  __resetSheetHistory();
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  __resetSheetHistory();
});

describe("a player's own waiting request", () => {
  it('is a receipt with Withdraw, not the host\'s approve and reject', async () => {
    renderAs('player', playing, [...banked, bank('b9', 'host', 2500, 'pending')]);
    await loaded();
    expect(await screen.findByText(/waiting for the host/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^withdraw$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reject/i })).toBeNull();
  });

  it('asks first, then withdraws the bank and says so', async () => {
    vi.mocked(offlineSessionsApi.withdrawBuyInRequest).mockResolvedValue(bank('b9', 'host', 2500, 'withdrawn'));
    renderAs('player', playing, [...banked, bank('b9', 'host', 2500, 'pending')]);
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: /^withdraw$/i }));
    expect(await screen.findByText(/withdraw your request\?/i)).toBeInTheDocument();
    expect(offlineSessionsApi.withdrawBuyInRequest).not.toHaveBeenCalled();

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^withdraw$/i }));
    await waitFor(() => expect(offlineSessionsApi.withdrawBuyInRequest).toHaveBeenCalledWith('c1', 's1', 'b9'));
    expect(await screen.findByText(/request withdrawn/i)).toBeInTheDocument();
    // The row is gone: the patched request is no longer pending.
    await waitFor(() => expect(screen.queryByText(/waiting for the host/i)).toBeNull());
  });

  it('"Keep it" keeps it', async () => {
    renderAs('player', playing, [...banked, bank('b9', 'host', 2500, 'pending')]);
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: /^withdraw$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /keep it/i }));
    await waitFor(() => expect(screen.queryByText(/withdraw your request\?/i)).toBeNull());
    expect(offlineSessionsApi.withdrawBuyInRequest).not.toHaveBeenCalled();
    expect(screen.getByText(/waiting for the host/i)).toBeInTheDocument();
  });

  it('withdraws a seat request through its own route', async () => {
    const waiting = { ...playing, activePlayerUids: ['boss', 'priya'], pendingSitInUids: ['host'], sitInRequestedAt: { host: ago(2) } };
    vi.mocked(offlineSessionsApi.withdrawSitIn).mockResolvedValue({ ...waiting, pendingSitInUids: [], sitInRequestedAt: {} });
    renderAs('player', waiting, [bank('b1', 'boss', 5000), bank('b3', 'priya', 5000)]);
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: /^withdraw$/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^withdraw$/i }));
    await waitFor(() => expect(offlineSessionsApi.withdrawSitIn).toHaveBeenCalledWith('c1', 's1'));
    expect(offlineSessionsApi.withdrawBuyInRequest).not.toHaveBeenCalled();
  });

  it('withdraws an early count through its own route', async () => {
    const counting = { ...playing, cashOuts: [{ userId: 'host', amount: 3000, status: 'pending' as const, requestedAt: ago(1) }] };
    vi.mocked(offlineSessionsApi.withdrawCashOut).mockResolvedValue({ ...counting, cashOuts: [] });
    renderAs('player', counting);
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: /^withdraw$/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^withdraw$/i }));
    await waitFor(() => expect(offlineSessionsApi.withdrawCashOut).toHaveBeenCalledWith('c1', 's1'));
  });

  it("surfaces the server's refusal and leaves the row", async () => {
    vi.mocked(offlineSessionsApi.withdrawBuyInRequest).mockRejectedValue(new Error('This request has already been decided'));
    renderAs('player', playing, [...banked, bank('b9', 'host', 2500, 'pending')]);
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: /^withdraw$/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^withdraw$/i }));
    expect(await screen.findByText(/could not withdraw/i)).toBeInTheDocument();
    expect(screen.getByText(/already been decided/i)).toBeInTheDocument();
  });

  it("an admin sees somebody else's request as a decision, not a receipt", async () => {
    renderAs('owner', playing, [...banked, bank('b9', 'priya', 2500, 'pending')]);
    await loaded();
    expect(await screen.findByRole('button', { name: /approve priya/i })).toBeInTheDocument();
    expect(screen.queryByText(/waiting for the host/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /^withdraw$/i })).toBeNull();
  });
});

describe('leaving the club', () => {
  const openProfile = async () => {
    fireEvent.click(screen.getAllByRole('button', { name: /profile/i })[0]);
    await screen.findByRole('button', { name: /sign out/i });
  };

  it('a member leaves from their profile, after a confirm, and is taken to the dashboard', async () => {
    vi.mocked(clubsApi.leaveClub).mockResolvedValue();
    const { onBack } = renderAs('player', null);
    await loaded();
    await openProfile();
    fireEvent.click(screen.getByRole('button', { name: /leave friday night/i }));

    expect(await screen.findByText(/leave friday night\?/i)).toBeInTheDocument();
    expect(screen.getByText(/past results stay on the ranks/i)).toBeInTheDocument();
    expect(clubsApi.leaveClub).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^leave club$/i }));
    await waitFor(() => expect(clubsApi.leaveClub).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(onBack).toHaveBeenCalled());
  });

  it("surfaces the server's refusal and stays in the club", async () => {
    vi.mocked(clubsApi.leaveClub).mockRejectedValue(
      new Error("You're part of tonight's night — leave once it has been settled or cancelled")
    );
    const { onBack } = renderAs('player', null);
    await loaded();
    await openProfile();
    fireEvent.click(screen.getByRole('button', { name: /leave friday night/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^leave club$/i }));
    expect(await screen.findByText(/could not leave/i)).toBeInTheDocument();
    expect(screen.getByText(/part of tonight/i)).toBeInTheDocument();
    expect(onBack).not.toHaveBeenCalled();
  });

  it('is never offered to the owner', async () => {
    renderAs('owner', null);
    await loaded();
    await openProfile();
    expect(screen.queryByRole('button', { name: /leave friday night/i })).toBeNull();
  });
});
