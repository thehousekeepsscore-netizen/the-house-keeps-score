import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * Finishing a poker night, end to end.
 *
 * The engine that decides the money has been complete and tested for a long
 * time; what was missing was any way for a host to reach it. "Settle night"
 * froze the table and opened a sheet that said settlement was still being
 * built, so a night could be started, played and frozen — but never ended.
 *
 * This drives the whole workflow through the real screen: freeze, count,
 * calculate, review, confirm. It is deliberately not a test of the arithmetic
 * (settlementEngine.test.ts owns that, on both copies of the engine) but of the
 * path to it, which is the part that did not exist.
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
  return {
    ...actual,
    getActiveSession: vi.fn(),
    listBuyInRequests: vi.fn(),
    beginSettling: vi.fn(),
    resumeNight: vi.fn(),
    settleSession: vi.fn(),
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
  return {
    ...actual,
    getClub: vi.fn(),
    getClubRoster: vi.fn(),
  };
});

import { ClubDetailView } from './ClubDetailView';
import { ResourceCacheProvider } from '../lib/resource-cache';
import * as offlineSessionsApi from '../lib/offlineSessions-api';
import * as clubsApi from '../lib/clubs-api';
import * as clubRecordsApi from '../lib/clubRecords-api';
import { Club, PokerSession, BuyInRequest } from '../types';
import type { AppUser as User } from '../lib/auth-types';

const NOW = Date.parse('2026-08-08T21:00:00.000Z');
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();

const currentUser = {
  uid: 'host',
  email: 'host@test.local',
  displayName: 'Host',
  photoURL: '',
  profileComplete: true,
} as unknown as User;

/** Rake off, pot off — this file is about the workflow, not the arithmetic. */
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
  createdAt: ago(9999),
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

const session: PokerSession = {
  id: 's1',
  clubId: 'c1',
  sessionName: 'Fri 8 Aug · Day 1',
  status: 'active',
  activePlayerUids: ['host', 'priya'],
  pendingSitInUids: [],
  sitInRequestedAt: {},
  cashOuts: [],
  startedBy: 'host',
  createdAt: ago(120),
  startedPlayingAt: ago(90),
  timeExtensions: [],
  timeLimitLiftedAt: null,
  settlingAt: null,
};

const buyIn = (id: string, userId: string, amount: number): BuyInRequest => ({
  id,
  sessionId: 's1',
  clubId: 'c1',
  userId,
  userDisplayName: '',
  amount,
  status: 'approved',
  requestedBy: userId,
  createdAt: ago(80),
});

function renderClub(over: Partial<PokerSession> = {}) {
  const active = { ...session, ...over };
  vi.mocked(clubsApi.getClub).mockResolvedValue(club);
  vi.mocked(clubsApi.getClubRoster).mockResolvedValue({
    host: { displayName: 'Host' },
    priya: { displayName: 'Priya' },
  } as never);
  vi.mocked(clubRecordsApi.listHistory).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.getLeaderboard).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPotLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPendingChanges).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listAuditLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listDeletedSessions).mockResolvedValue([]);
  vi.mocked(offlineSessionsApi.getActiveSession).mockResolvedValue(active);
  vi.mocked(offlineSessionsApi.listBuyInRequests).mockResolvedValue([
    buyIn('b1', 'host', 5000),
    buyIn('b2', 'priya', 5000),
  ]);
  // The freeze hands back a session carrying settlingAt, exactly as the server does.
  vi.mocked(offlineSessionsApi.beginSettling).mockResolvedValue({
    ...active,
    settlingAt: ago(0),
  });
  vi.mocked(offlineSessionsApi.settleSession).mockResolvedValue([]);

  const router = createMemoryRouter(
    [
      {
        path: '/clubs/:clubId',
        element: (
          <ResourceCacheProvider>
            <ClubDetailView
              club={club}
              currentUser={currentUser}
              playerAvatarUrl=""
              onBackToDashboard={vi.fn()}
            />
          </ResourceCacheProvider>
        ),
      },
    ],
    { initialEntries: ['/clubs/c1'] }
  );
  return render(<RouterProvider router={router} />);
}

/**
 * Mount, wait for the night to land, then press the control that starts it all.
 *
 * Which control that is depends on the phase, and deliberately so: the footer
 * carries it while the night runs, and the frozen band carries it once it does
 * not. Both call the same handler.
 */
async function openSettlement(over: Partial<PokerSession> = {}) {
  renderClub(over);
  await waitFor(() => {
    expect(offlineSessionsApi.listBuyInRequests).toHaveBeenCalled();
  });
  const door = over.settlingAt ? /count the chips/i : /settle night/i;
  fireEvent.click(await screen.findByRole('button', { name: door }));
  await screen.findByRole('heading', { name: /settle night/i });
}

/** The settlement screen's own inputs, in the order the players are listed. */
const amountFields = () =>
  screen.getAllByRole('spinbutton') as HTMLInputElement[];

/**
 * Anchors on a per-player line rather than the totals box.
 *
 * "Total buy-ins" is now on screen twice over by design — once per player and
 * once as the night's total — so it cannot identify the preview on its own.
 */
const previewLines = () => screen.queryAllByText(/^Profit \/ loss$/i);
const findPreview = () => screen.findAllByText(/^Profit \/ loss$/i);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('settling a night', () => {
  it('freezes the table before it opens the screen', async () => {
    await openSettlement();

    expect(offlineSessionsApi.beginSettling).toHaveBeenCalledWith('c1', 's1');
  });

  it('says the table is frozen, so the count can be trusted', async () => {
    await openSettlement();

    expect(screen.getByText(/table is frozen/i)).toBeInTheDocument();
  });

  it('does not freeze a second time when the host reopens it', async () => {
    // Already settling: asking again is refused by the server, which would lock
    // the host out of the screen the freeze exists to open.
    await openSettlement({ settlingAt: ago(1) });

    expect(offlineSessionsApi.beginSettling).not.toHaveBeenCalled();
  });

  it('lists every player who participated, exactly once', async () => {
    await openSettlement();

    // Two players, each with a buy-in and a cash-out field.
    expect(amountFields()).toHaveLength(4);
  });

  it('pre-fills what each player has already put up', async () => {
    await openSettlement();

    const fields = amountFields();
    expect(fields[0].value).toBe('5000');
    expect(fields[2].value).toBe('5000');
  });

  it('keeps Auto Calculate shut until every player has a cash-out', async () => {
    await openSettlement();

    const calc = screen.getByRole('button', { name: /auto calculate/i });
    expect(calc).toBeDisabled();
    expect(screen.getByText(/enter a cash-out for every player/i)).toBeInTheDocument();

    // One of the two is not enough.
    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    expect(screen.getByRole('button', { name: /auto calculate/i })).toBeDisabled();

    fireEvent.change(amountFields()[3], { target: { value: '2000' } });
    expect(screen.getByRole('button', { name: /auto calculate/i })).toBeEnabled();
  });

  it('shows a preview only — nothing is committed by calculating', async () => {
    await openSettlement();
    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    fireEvent.change(amountFields()[3], { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: /auto calculate/i }));

    expect(await findPreview()).not.toHaveLength(0);
    expect(offlineSessionsApi.settleSession).not.toHaveBeenCalled();
  });

  it('shows each player their whole arithmetic, not just the answer', async () => {
    await openSettlement();
    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    fireEvent.change(amountFields()[3], { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: /auto calculate/i }));

    await findPreview();
    // Buy-in, cash-out and the difference, per player — the three lines that
    // turn a bare final figure into something a host can defend at the table.
    expect(screen.getAllByText(/^Total buy-ins$/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/^Final cash-out$/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/^Profit \/ loss$/i).length).toBeGreaterThanOrEqual(2);
  });

  it('takes a second, deliberate tap to commit', async () => {
    await openSettlement();
    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    fireEvent.change(amountFields()[3], { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: /auto calculate/i }));
    await findPreview();

    fireEvent.click(screen.getByRole('button', { name: /^settle session$/i }));
    // Arming the confirmation is not settling.
    expect(offlineSessionsApi.settleSession).not.toHaveBeenCalled();

    const confirm = await screen.findByRole('button', { name: /confirm & settle/i });
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(offlineSessionsApi.settleSession).toHaveBeenCalledWith(
        'c1',
        's1',
        expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({ userId: 'host', buyIn: 5000, cashOut: 8000 }),
            expect.objectContaining({ userId: 'priya', buyIn: 5000, cashOut: 2000 }),
          ]),
        })
      );
    });
  });

  it('re-locks the preview when a figure changes underneath it', async () => {
    await openSettlement();
    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    fireEvent.change(amountFields()[3], { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: /auto calculate/i }));
    await findPreview();

    // The host miscounted a stack. The reviewed figures are no longer the
    // entered ones, so the commit must not stay armed against them.
    fireEvent.change(amountFields()[3], { target: { value: '2500' } });

    expect(previewLines()).toHaveLength(0);
    expect(screen.getByRole('button', { name: /^settle session$/i })).toBeDisabled();
  });
});

describe('a player who stood up early', () => {
  const stoodUp: Partial<PokerSession> = {
    activePlayerUids: ['host'],
    cashOuts: [{ userId: 'priya', amount: 7400, status: 'confirmed', requestedAt: ago(20) }],
  };

  it('still settles, rather than vanishing from the night', async () => {
    await openSettlement(stoodUp);

    // Host has both fields; Priya's cash-out is locked, so she contributes a
    // buy-in field only. Three, not two: she is still in the settlement.
    expect(amountFields()).toHaveLength(3);
  });

  it('has the agreed count locked, not re-typed from memory', async () => {
    await openSettlement(stoodUp);

    expect(screen.getByText(/stood up/i)).toBeInTheDocument();
    expect(screen.getByText('7,400')).toBeInTheDocument();
  });

  it('does not hold Auto Calculate shut waiting for a figure it already has', async () => {
    await openSettlement(stoodUp);

    // Only the host's cash-out is outstanding.
    fireEvent.change(amountFields()[1], { target: { value: '2600' } });
    expect(screen.getByRole('button', { name: /auto calculate/i })).toBeEnabled();
  });
});
