import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * Events that say what happened.
 *
 * A declined request used to reach its asker as the request vanishing, and a
 * settled night as the table disappearing. The events now carry the reason
 * (to the asker only) and each player's own result (to that player only);
 * these tests guard that this screen says so — to the right person, once —
 * and that the host's reject sheet is where the reason comes from.
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
    decideBuyInRequest: vi.fn(),
    decideSitIn: vi.fn(),
    decideCashOut: vi.fn(),
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
  return { ...actual, getClub: vi.fn() };
});

const socketHandlers = new Map<string, Set<(...a: unknown[]) => void>>();
const fakeSocket = {
  connected: true,
  active: true,
  on: vi.fn((e: string, fn: (...a: unknown[]) => void) => {
    if (!socketHandlers.has(e)) socketHandlers.set(e, new Set());
    socketHandlers.get(e)!.add(fn);
  }),
  off: vi.fn((e: string, fn: (...a: unknown[]) => void) => socketHandlers.get(e)?.delete(fn)),
  emit: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  timeout: vi.fn((_ms: number) => ({ emitWithAck: async () => ({ ok: true }) })),
};
vi.mock('../lib/socket', () => ({ getSocket: () => fakeSocket, resetSocket: vi.fn() }));
const fireSocket = (event: string, payload: unknown) => {
  [...(socketHandlers.get(event) ?? [])].forEach((fn) => fn(payload));
};

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
  socketHandlers.clear();
  __resetSheetHistory();
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  __resetSheetHistory();
});

const apiRow = (id: string, userId: string, amount: number, status: string) => ({
  id, sessionId: 's1', clubId: 'c1', userId, amount, status, requestedBy: userId, approvedBy: 'boss', createdAt: ago(5),
});
const subscribed = () => waitFor(() => expect(socketHandlers.has('club:session-settled')).toBe(true));

describe('a declined request says so, to the person who asked', () => {
  it('tells the asker their bank was declined, with the figure and the host\'s reason', async () => {
    renderAs('player', playing, [...banked, bank('b9', 'host', 2500, 'pending')]);
    await loaded(); await subscribed();
    fireSocket('club:buyin-decided', {
      sessionId: 's1', requestId: 'b9', userId: 'host', approve: false, decidedBy: 'boss',
      reason: 'Settle up last week first', request: apiRow('b9', 'host', 2500, 'rejected'),
    });
    expect(await screen.findByText(/buy-in declined/i)).toBeInTheDocument();
    expect(screen.getByText(/2,500 Chips was declined/i)).toBeInTheDocument();
    expect(screen.getByText(/Settle up last week first/)).toBeInTheDocument();
  });

  it('says nothing about somebody else\'s declined bank', async () => {
    renderAs('player', playing, [...banked, bank('b9', 'priya', 2500, 'pending')]);
    await loaded(); await subscribed();
    fireSocket('club:buyin-decided', {
      sessionId: 's1', requestId: 'b9', userId: 'priya', approve: false, decidedBy: 'boss',
      request: apiRow('b9', 'priya', 2500, 'rejected'),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/buy-in declined/i)).toBeNull();
  });

  it('says nothing when the bank was approved', async () => {
    renderAs('player', playing, [...banked, bank('b9', 'host', 2500, 'pending')]);
    await loaded(); await subscribed();
    fireSocket('club:buyin-decided', {
      sessionId: 's1', requestId: 'b9', userId: 'host', approve: true, decidedBy: 'boss',
      request: apiRow('b9', 'host', 2500, 'approved'),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/buy-in declined/i)).toBeNull();
  });

  it('tells the asker their seat request was declined', async () => {
    const waiting = { ...playing, activePlayerUids: ['boss', 'priya'], pendingSitInUids: ['host'], sitInRequestedAt: { host: ago(2) } };
    renderAs('player', waiting, [bank('b1', 'boss', 5000), bank('b3', 'priya', 5000)]);
    await loaded(); await subscribed();
    fireSocket('club:sitin-decided', { sessionId: 's1', userId: 'host', approved: false, decidedBy: 'boss', reason: 'Table is full' });
    expect(await screen.findByText(/seat request declined/i)).toBeInTheDocument();
    expect(screen.getByText(/Table is full/)).toBeInTheDocument();
  });

  it('tells the asker their count was sent back', async () => {
    renderAs('player', playing);
    await loaded(); await subscribed();
    fireSocket('club:cashout-decided', { sessionId: 's1', userId: 'host', approved: false, decidedBy: 'boss' });
    expect(await screen.findByText(/count sent back/i)).toBeInTheDocument();
  });
});

describe('a settled night tells each player their own result', () => {
  it('names the night and the figure this phone was sent', async () => {
    renderAs('player', playing);
    await loaded(); await subscribed();
    fireSocket('club:session-settled', { sessionId: 's1', recordId: 'r1', title: 'Thu 29 Oct · Day 1', settledBy: 'boss', you: { net: 1800 } });
    expect(await screen.findByText(/night settled/i)).toBeInTheDocument();
    expect(screen.getByText(/you finished \+1,800 Chips/)).toBeInTheDocument();
  });

  it('tells someone who did not play that it is settled, and no number', async () => {
    renderAs('player', playing);
    await loaded(); await subscribed();
    fireSocket('club:session-settled', { sessionId: 's1', recordId: 'r1', title: 'Thu 29 Oct · Day 1', settledBy: 'boss' });
    expect(await screen.findByText(/is settled\. Results are in History/i)).toBeInTheDocument();
    expect(screen.queryByText(/you finished/i)).toBeNull();
  });

  it('does not tell the host who settled it a second time', async () => {
    renderAs('owner', playing);
    await loaded(); await subscribed();
    fireSocket('club:session-settled', { sessionId: 's1', recordId: 'r1', title: 'Thu 29 Oct · Day 1', settledBy: 'host', you: { net: -500 } });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/night settled/i)).toBeNull();
  });

  it('stays silent for an event with no title — an API that has not caught up', async () => {
    renderAs('player', playing);
    await loaded(); await subscribed();
    fireSocket('club:session-settled', { sessionId: 's1' });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/night settled/i)).toBeNull();
  });
});

describe('the host says why', () => {
  it('sends the typed reason with a rejected bank', async () => {
    vi.mocked(offlineSessionsApi.decideBuyInRequest).mockResolvedValue(null);
    renderAs('owner', playing, [...banked, bank('b9', 'priya', 2500, 'pending')]);
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: /reject priya/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/tell priya why/i), { target: { value: '  Settle up first  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^reject$/i }));
    await waitFor(() =>
      expect(offlineSessionsApi.decideBuyInRequest).toHaveBeenCalledWith('c1', 's1', 'b9', false, 'Settle up first'));
  });

  it('sends no reason when the box is left empty', async () => {
    vi.mocked(offlineSessionsApi.decideBuyInRequest).mockResolvedValue(null);
    renderAs('owner', playing, [...banked, bank('b9', 'priya', 2500, 'pending')]);
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: /reject priya/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^reject$/i }));
    await waitFor(() =>
      expect(offlineSessionsApi.decideBuyInRequest).toHaveBeenCalledWith('c1', 's1', 'b9', false, undefined));
  });

  it('sends the reason with a declined seat request', async () => {
    const waiting = { ...playing, activePlayerUids: ['boss', 'host'], pendingSitInUids: ['priya'], sitInRequestedAt: { priya: ago(2) } };
    vi.mocked(offlineSessionsApi.decideSitIn).mockResolvedValue({ ...waiting, pendingSitInUids: [], sitInRequestedAt: {} });
    renderAs('owner', waiting, [bank('b1', 'boss', 5000), bank('b2', 'host', 5000)]);
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: /reject priya/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/tell priya why/i), { target: { value: 'Table is full' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^reject$/i }));
    await waitFor(() =>
      expect(offlineSessionsApi.decideSitIn).toHaveBeenCalledWith('c1', 's1', 'priya', false, 'Table is full'));
  });

  it('sends the reason with a count sent back', async () => {
    const counting = { ...playing, cashOuts: [{ userId: 'priya', amount: 3000, status: 'pending' as const, requestedAt: ago(1) }] };
    vi.mocked(offlineSessionsApi.decideCashOut).mockResolvedValue({ ...counting, cashOuts: [] });
    renderAs('owner', counting);
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: /reject priya/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/tell priya why/i), { target: { value: 'Two stacks short' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^reject$/i }));
    await waitFor(() =>
      expect(offlineSessionsApi.decideCashOut).toHaveBeenCalledWith('c1', 's1', 'priya', false, undefined, 'Two stacks short'));
  });
});
