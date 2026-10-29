import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * A night opened by mistake can be closed from the screen that opened it.
 *
 * Until now a host who pressed "Open table" and found nobody coming had no way
 * out: Settle refuses fewer than two players, and the club cannot open another
 * night while this one is active. The only exit was to bank two people, count
 * them and settle a night nobody played into history.
 *
 * The control is offered only while nothing is banked — the moment an approved
 * buy-in exists the exit is void-or-settle and the button is withheld rather
 * than failing — and it goes through the confirm dialog, because it is the one
 * action on this screen that ends a night.
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
    cancelNight: vi.fn(),
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

const NOW = Date.parse('2026-10-28T20:00:00.000Z');
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();

const currentUser = {
  uid: 'host',
  email: 'host@test.local',
  displayName: 'Host',
  photoURL: '',
  profileComplete: true,
} as unknown as User;

type Role = 'owner' | 'player';

function clubAs(role: Role): Club {
  return {
    id: 'c1',
    name: 'Friday Night',
    code: '60781',
    ownerUid: role === 'owner' ? 'host' : 'boss',
    createdBy: role === 'owner' ? 'host' : 'boss',
    adminUids: [],
    memberUids: ['boss', 'host', 'priya'],
    isMember: true,
    isAdmin: role === 'owner',
    isOwner: role === 'owner',
    minBuyIn: 1000,
    maxBuyIn: 5000,
    buyInMode: 'MATCH_HIGHEST',
    memberCount: 3,
    adminCount: 1,
    maxCapacity: 50,
    createdAt: ago(9999),
    potEnabled: false,
    sessionRakeAmount: 0,
    winnersCutPercent: 0,
    mismatchStrategy: 'PROPORTIONAL_WINNERS',
    rakeOrder: 'MISMATCH_FIRST',
    winnerDefinition: 'PROFIT_POSITIVE',
    winnerTopN: 1,
    roundingRule: 'NONE',
  } as unknown as Club;
}

const rules = {
  capturedAt: ago(90),
  sessionRakeAmount: 0, winnersCutPercent: 0, rakeEnabled: false, rakeMethod: 'PERCENT_PROFIT',
  rakeValue: 0, potEnabled: false, mismatchStrategy: 'PROPORTIONAL_WINNERS', rakeOrder: 'MISMATCH_FIRST',
  winnerDefinition: 'PROFIT_POSITIVE', winnerTopN: 1, roundingRule: 'NONE',
} as const;

/** Opened, nobody has bought in yet: the night the host opened by mistake. */
const lobby: PokerSession = {
  id: 's1',
  clubId: 'c1',
  sessionName: 'Tue 28 Oct · Day 1',
  status: 'active',
  activePlayerUids: ['host'],
  pendingSitInUids: [],
  sitInRequestedAt: {},
  cashOuts: [],
  startedBy: 'host',
  createdAt: ago(5),
  startedPlayingAt: null,
  timeExtensions: [],
  timeLimitLiftedAt: null,
  settlingAt: null,
  settlementRules: rules,
};

/** Playing with three seats; the third never took a bank. */
const playing: PokerSession = {
  ...lobby,
  activePlayerUids: ['host', 'priya', 'tara'],
  startedPlayingAt: ago(60),
};

const buyIn = (id: string, userId: string, amount: number): BuyInRequest => ({
  id, sessionId: 's1', clubId: 'c1', userId, userDisplayName: '', amount,
  status: 'approved', requestedBy: userId, createdAt: ago(50),
});

const roster = { boss: { displayName: 'Boss' }, host: { displayName: 'Host' }, priya: { displayName: 'Priya' }, tara: { displayName: 'Tara' } };

function renderAs(role: Role, active: PokerSession, buyIns: BuyInRequest[] = []) {
  const club = clubAs(role);
  vi.mocked(clubsApi.getClub).mockResolvedValue({ ...club, roster } as never);
  vi.mocked(clubRecordsApi.listHistory).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.getLeaderboard).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPotLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPendingChanges).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listAuditLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listDeletedSessions).mockResolvedValue([]);
  vi.mocked(offlineSessionsApi.getActiveSession).mockResolvedValue(active);
  vi.mocked(offlineSessionsApi.listBuyInRequests).mockResolvedValue(buyIns);
  vi.mocked(offlineSessionsApi.beginSettling).mockResolvedValue({ ...active, settlingAt: ago(0) });
  vi.mocked(offlineSessionsApi.cancelNight).mockResolvedValue({ ...active, status: 'cancelled' });
  __resetSheetHistory();

  const element = (
    <ResourceCacheProvider>
      <ClubDetailView club={club} currentUser={currentUser} playerAvatarUrl="" onBackToDashboard={vi.fn()} />
    </ResourceCacheProvider>
  );
  // Mounted at '/': the confirm dialog is a Sheet, and Sheet registers its
  // history entry against window.location, which jsdom pins at '/'.
  const router = createMemoryRouter([{ path: '/', element }], { initialEntries: ['/'] });
  return render(<RouterProvider router={router} />);
}

const loaded = () => waitFor(() => expect(offlineSessionsApi.listBuyInRequests).toHaveBeenCalled());
const cancelControl = () => screen.queryByRole('button', { name: /cancel this night/i });

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

describe('where the way out is offered', () => {
  it('in the lobby, to the host, while nothing is banked', async () => {
    renderAs('owner', lobby);
    await loaded();
    expect(await screen.findByRole('button', { name: /cancel this night/i })).toBeInTheDocument();
  });

  it('on the frozen table too — where a host who pressed Settle on an empty table ends up', async () => {
    renderAs('owner', { ...playing, activePlayerUids: ['host'], settlingAt: ago(1) });
    await loaded();
    await screen.findByText(/settling up/i);
    expect(await screen.findByRole('button', { name: /nothing banked\? cancel this night/i })).toBeInTheDocument();
  });

  it('is withheld in the lobby the moment anybody holds chips', async () => {
    // Priya bought in while the table was still being prepared. The lobby is
    // still the lobby, but the exit is now void-or-settle, so no control.
    renderAs('owner', { ...lobby, activePlayerUids: ['host', 'priya'] }, [buyIn('b1', 'priya', 5000)]);
    await loaded();
    await screen.findByText(/preparing table/i);
    expect(cancelControl()).toBeNull();
  });

  it('is withheld on the frozen table the moment anybody holds chips', async () => {
    renderAs('owner', { ...playing, settlingAt: ago(1) }, [buyIn('b1', 'priya', 5000)]);
    await loaded();
    await screen.findByText(/settling up/i);
    expect(screen.getByRole('button', { name: /count the chips/i })).toBeInTheDocument();
    expect(cancelControl()).toBeNull();
  });

  // A running table shows no cancel control in any state — the way out there
  // is the settling band — which is why the two cases above are the lobby and
  // the band, not the felt.

  it('is never offered to a player', async () => {
    renderAs('player', lobby);
    await loaded();
    await screen.findByText(/preparing table/i);
    expect(cancelControl()).toBeNull();
  });
});

describe('cancelling', () => {
  it('asks first, then closes the table and says so, recording nothing', async () => {
    renderAs('owner', lobby);
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: /cancel this night/i }));

    // The confirm dialog names the consequence and the verb.
    expect(await screen.findByText(/cancel this night\?/i)).toBeInTheDocument();
    expect(screen.getByText(/audit log only/i)).toBeInTheDocument();
    expect(offlineSessionsApi.cancelNight).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /cancel the night/i }));

    await waitFor(() => expect(offlineSessionsApi.cancelNight).toHaveBeenCalledWith('c1', 's1'));
    expect(await screen.findByText(/night cancelled/i)).toBeInTheDocument();
    // The table is gone from this screen without a refetch: the dark state.
    expect(await screen.findByText(/no session running/i)).toBeInTheDocument();
    expect(offlineSessionsApi.settleSession).not.toHaveBeenCalled();
  });

  it('"Keep it open" keeps it open', async () => {
    renderAs('owner', lobby);
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: /cancel this night/i }));
    fireEvent.click(await screen.findByRole('button', { name: /keep it open/i }));
    await waitFor(() => expect(screen.queryByText(/cancel this night\?/i)).not.toBeInTheDocument());
    expect(offlineSessionsApi.cancelNight).not.toHaveBeenCalled();
    expect(screen.getByText(/preparing table/i)).toBeInTheDocument();
  });

  it("surfaces the server's refusal as a warning and leaves the table up", async () => {
    renderAs('owner', lobby);
    vi.mocked(offlineSessionsApi.cancelNight).mockRejectedValueOnce(
      new Error('This night has chips on the table — void the banks or settle it instead')
    );
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: /cancel this night/i }));
    fireEvent.click(await screen.findByRole('button', { name: /cancel the night/i }));

    expect(await screen.findByText(/could not cancel/i)).toBeInTheDocument();
    expect(screen.getByText(/chips on the table/i)).toBeInTheDocument();
    expect(screen.queryByText(/no session running/i)).not.toBeInTheDocument();
  });
});

describe('every other phone', () => {
  it('drops to "no session running" and is told the host closed the table', async () => {
    renderAs('player', lobby);
    await loaded();
    await screen.findByText(/preparing table/i);

    fireSocket('club:session-cancelled', { sessionId: 's1', cancelledBy: 'boss' });

    expect(await screen.findByText(/no session running/i)).toBeInTheDocument();
    expect(await screen.findByText(/the host closed the table/i)).toBeInTheDocument();
  });

  it('does not tell the host twice — their own screen already said so', async () => {
    renderAs('owner', lobby);
    await loaded();
    await screen.findByText(/preparing table/i);

    fireSocket('club:session-cancelled', { sessionId: 's1', cancelledBy: 'host' });

    expect(await screen.findByText(/no session running/i)).toBeInTheDocument();
    expect(screen.queryByText(/the host closed the table/i)).toBeNull();
  });
});

describe('the settle sheet and a seat with no bank', () => {
  it('counts only the players who hold chips, and settles without the empty seat', async () => {
    // Three seated, two banked: Tara sat down and never bought in. She used to
    // need a count of zero before Settle would enable.
    renderAs('owner', playing, [buyIn('b1', 'host', 5000), buyIn('b2', 'priya', 5000)]);
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: /settle night/i }));
    await screen.findByRole('heading', { name: /settle night/i });

    // Scoped to the sheet: Tara's seat is still drawn on the felt behind it,
    // which is right — she is at the table, just not in the count.
    const sheet = within(screen.getByRole('dialog'));
    expect(sheet.getAllByRole('spinbutton')).toHaveLength(2);
    expect(sheet.getByText('Priya')).toBeInTheDocument();
    expect(sheet.queryByText('Tara')).toBeNull();
  });
});
