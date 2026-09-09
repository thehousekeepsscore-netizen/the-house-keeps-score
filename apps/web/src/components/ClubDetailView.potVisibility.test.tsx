import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * The club pot is the owner's to see, and even the owner asks first.
 *
 * The balance card and the ledger tab were admin-wide, the balance itself was
 * printed in the open, and whoever settled a night was told what the house
 * took. Now: the card, the tab and the ledger request exist for the owner
 * alone; the card starts masked and the WHOLE card is the toggle (Option B —
 * the card no longer opens the ledger; a link beneath it does); and an admin
 * settling a night gets the totals with no pot line in the acknowledgement.
 *
 * The admin here receives a club WITHOUT a clubPotBalance key, exactly as the
 * API now serves one — absent, not zero.
 */

vi.mock('../lib/auth-context', async () => {
  const actual = await vi.importActual<typeof import('../lib/auth-context')>('../lib/auth-context');
  return {
    ...actual,
    useAuth: () => ({
      user: { uid: 'me', email: 'me@test.local', displayName: 'Me', profileComplete: true },
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
    initSettlementRules: vi.fn(),
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
  return { ...actual, getClub: vi.fn(), listJoinRequests: vi.fn() };
});

import { ClubDetailView } from './ClubDetailView';
import { ResourceCacheProvider } from '../lib/resource-cache';
import { __resetSheetHistory } from './ui/Sheet';
import * as offlineSessionsApi from '../lib/offlineSessions-api';
import * as clubsApi from '../lib/clubs-api';
import * as clubRecordsApi from '../lib/clubRecords-api';
import type { Club, PokerSession, BuyInRequest } from '../types';
import type { AppUser as User } from '../lib/auth-types';

const NOW = Date.parse('2026-09-04T21:00:00.000Z');
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();

const currentUser = {
  uid: 'me',
  email: 'me@test.local',
  displayName: 'Me',
  photoURL: '',
  profileComplete: true,
} as unknown as User;

/** The production figure, so a leak is a distinctive string and not a round number. */
const BALANCE = 583_491;

type Role = 'owner' | 'admin';

/**
 * The club as the API serves it to each role: the owner's copy carries the
 * balance, the admin's copy has no such key at all.
 */
function clubAs(role: Role): Club {
  const base = {
    id: 'c1',
    name: 'All In Poker 2026',
    code: '60781',
    ownerUid: role === 'owner' ? 'me' : 'boss',
    createdBy: role === 'owner' ? 'me' : 'boss',
    adminUids: role === 'admin' ? ['me'] : [],
    memberUids: ['boss', 'me', 'priya'],
    isMember: true,
    isAdmin: true,
    isOwner: role === 'owner',
    minBuyIn: 1000,
    maxBuyIn: 5000,
    buyInMode: 'MATCH_HIGHEST',
    memberCount: 3,
    adminCount: 1,
    maxCapacity: 50,
    createdAt: ago(9999),
    potEnabled: true,
    rakeEnabled: false,
    sessionRakeAmount: 1000,
    winnersCutPercent: 0,
    mismatchStrategy: 'PROPORTIONAL_WINNERS',
    rakeOrder: 'MISMATCH_FIRST',
    winnerDefinition: 'PROFIT_POSITIVE',
    winnerTopN: 1,
    roundingRule: 'NONE',
  };
  return (role === 'owner' ? { ...base, clubPotBalance: BALANCE } : base) as unknown as Club;
}

/** A running night with a 1,000-chip seat fee, so settling it moves the pot. */
const session: PokerSession = {
  id: 's1',
  clubId: 'c1',
  sessionName: 'Thu 4 Sep · Day 1',
  status: 'active',
  activePlayerUids: ['me', 'priya'],
  pendingSitInUids: [],
  sitInRequestedAt: {},
  cashOuts: [],
  startedBy: 'me',
  createdAt: ago(120),
  startedPlayingAt: ago(90),
  timeExtensions: [],
  timeLimitLiftedAt: null,
  settlingAt: null,
  settlementRules: {
    capturedAt: ago(90),
    sessionRakeAmount: 1000,
    winnersCutPercent: 0,
    rakeEnabled: false,
    rakeMethod: 'PERCENT_PROFIT',
    rakeValue: 0,
    potEnabled: true,
    mismatchStrategy: 'PROPORTIONAL_WINNERS',
    rakeOrder: 'MISMATCH_FIRST',
    winnerDefinition: 'PROFIT_POSITIVE',
    winnerTopN: 1,
    roundingRule: 'NONE',
  },
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

const roster = { boss: { displayName: 'Boss' }, me: { displayName: 'Me' }, priya: { displayName: 'Priya' } };

function renderAs(role: Role, active: PokerSession | null = null) {
  const club = clubAs(role);
  vi.mocked(clubsApi.getClub).mockResolvedValue({ ...club, roster } as never);
  vi.mocked(clubsApi.listJoinRequests).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listHistory).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.getLeaderboard).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPotLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPendingChanges).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listAuditLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listDeletedSessions).mockResolvedValue([]);
  vi.mocked(offlineSessionsApi.getActiveSession).mockResolvedValue(active);
  vi.mocked(offlineSessionsApi.listBuyInRequests).mockResolvedValue(
    active ? [buyIn('b1', 'me', 5000), buyIn('b2', 'priya', 5000)] : []
  );
  vi.mocked(offlineSessionsApi.beginSettling).mockResolvedValue(
    active ? { ...active, settlingAt: ago(0) } : (null as never)
  );
  vi.mocked(offlineSessionsApi.settleSession).mockResolvedValue([]);
  __resetSheetHistory();

  const element = (
    <ResourceCacheProvider>
      <ClubDetailView club={club} currentUser={currentUser} playerAvatarUrl="" onBackToDashboard={vi.fn()} />
    </ResourceCacheProvider>
  );
  // Mounted at '/' when a Sheet will open (see the settlement suite for why),
  // and with the tab routes so the Pot tab can be reached by its own URL.
  const router = createMemoryRouter(
    [
      { path: '/', element },
      { path: '/clubs/:clubId', element },
      { path: '/clubs/:clubId/:tab', element },
    ],
    { initialEntries: ['/'] }
  );
  return render(<RouterProvider router={router} />);
}

const loaded = () => waitFor(() => expect(clubsApi.getClub).toHaveBeenCalled());
const balanceText = () => screen.getByTestId('club-pot-balance').textContent ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  __resetSheetHistory();
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  __resetSheetHistory();
});

describe('as the owner', () => {
  it('shows the card with the balance masked — a brass strip, not the figure', async () => {
    renderAs('owner');
    await loaded();
    const card = await screen.findByRole('button', { name: /show club pot balance/i });
    expect(card).toHaveAttribute('aria-pressed', 'false');
    // The mask is a material with no text: nothing hints even the length.
    expect(balanceText()).toBe('');
    expect(document.body.textContent).not.toContain('583,491');
    expect(document.body.textContent).toContain('tap to show');
  });

  it('the card itself toggles: masked, revealed, masked again', async () => {
    renderAs('owner');
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: /show club pot balance/i }));
    expect(balanceText()).toBe('583,491 Chips');
    const card = screen.getByRole('button', { name: /hide club pot balance/i });
    expect(card).toHaveAttribute('aria-pressed', 'true');
    expect(document.body.textContent).toContain('tap to hide');

    fireEvent.click(card);
    expect(balanceText()).toBe('');
    expect(document.body.textContent).not.toContain('583,491');
    expect(screen.getByRole('button', { name: /show club pot balance/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('starts masked again on a fresh mount — a reveal is not remembered', async () => {
    renderAs('owner');
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: /show club pot balance/i }));
    expect(balanceText()).toBe('583,491 Chips');
    cleanup();

    renderAs('owner');
    await loaded();
    await screen.findByRole('button', { name: /show club pot balance/i });
    expect(balanceText()).toBe('');
  });

  it('clicking the card does not open the ledger', async () => {
    renderAs('owner');
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: /show club pot balance/i }));
    fireEvent.click(screen.getByRole('button', { name: /hide club pot balance/i }));
    expect(screen.queryByText(/club pot ledger & transactions/i)).toBeNull();
  });

  it('the dedicated link beneath the card opens the ledger', async () => {
    renderAs('owner');
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: /view club pot ledger/i }));
    expect(await screen.findByText(/club pot ledger & transactions \(owner only\)/i)).toBeInTheDocument();
    await waitFor(() => expect(clubRecordsApi.listPotLog).toHaveBeenCalledWith('c1'));
  });
});

describe('as an admin', () => {
  it('has no balance card, no ledger link and no pot line anywhere', async () => {
    renderAs('admin');
    await loaded();
    // Something the admin does see, so the absence below is not a blank screen.
    expect(await screen.findByText('All In Poker 2026')).toBeInTheDocument();

    expect(screen.queryByTestId('club-pot-balance')).toBeNull();
    expect(screen.queryByRole('button', { name: /club pot balance/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /view club pot ledger/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/club pot/i);
  });

  it('never asks the API for the ledger, which would refuse anyway', async () => {
    renderAs('admin');
    await loaded();
    await screen.findByText('All In Poker 2026');
    // Everything else the screen fetches on mount has landed by now.
    await waitFor(() => expect(clubRecordsApi.listHistory).toHaveBeenCalled());
    expect(clubRecordsApi.listPotLog).not.toHaveBeenCalled();
  });

  it('cannot reach the ledger tab by its URL', async () => {
    const club = clubAs('admin');
    vi.mocked(clubsApi.getClub).mockResolvedValue({ ...club, roster } as never);
    vi.mocked(clubsApi.listJoinRequests).mockResolvedValue([]);
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
      [{ path: '/clubs/:clubId', element }, { path: '/clubs/:clubId/:tab', element }],
      { initialEntries: ['/clubs/c1/pot'] }
    );
    render(<RouterProvider router={router} />);
    await loaded();
    await screen.findByText('All In Poker 2026');
    expect(screen.queryByText(/club pot ledger/i)).toBeNull();
    expect(clubRecordsApi.listPotLog).not.toHaveBeenCalled();
  });
});

/**
 * Settling a night with the house taking a seat fee. The preview and the
 * acknowledgement toast both used to name the pot to whoever pressed the
 * button; the owner still gets both, behind the same eye, and an admin gets
 * neither.
 */
async function settleNight(role: Role) {
  renderAs(role, session);
  await waitFor(() => expect(offlineSessionsApi.listBuyInRequests).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole('button', { name: /settle night/i }));
  await screen.findByRole('heading', { name: /settle night/i });
  const fields = screen.getAllByRole('spinbutton') as HTMLInputElement[];
  // 10,000 in and 10,000 counted out, so nothing is mismatched; the seat fee
  // (1,000 a head) comes off the cash-outs and is what moves the pot: +2,000.
  fireEvent.change(fields[0], { target: { value: '8000' } });
  fireEvent.change(fields[1], { target: { value: '2000' } });
  await screen.findAllByText(/^Profit \/ loss$/i);
}

describe('settling a night', () => {
  it('OWNER — the preview names the pot, with the balance masked until the eye is pressed', async () => {
    await settleNight('owner');
    expect(screen.getByText('Club Pot')).toBeInTheDocument();
    // The contribution (2 × 1,000 seat fee) is stated beside the label; the balance is not.
    expect(screen.getByText('Club Pot').closest('div.p-3')?.textContent).toBe('Club Pot•••••• + 2,000 Chips••••••');
    expect(document.body.textContent).not.toContain('583,491');
    expect(document.body.textContent).not.toContain('585,491');

    fireEvent.click(screen.getByRole('button', { name: /show club pot balance/i }));
    expect(document.body.textContent).toContain('583,491 Chips');
    expect(document.body.textContent).toContain('585,491 Chips');
  });

  it('OWNER — the acknowledgement names the pot contribution', async () => {
    await settleNight('owner');
    fireEvent.click(screen.getByRole('button', { name: /^settle session$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirm & settle/i }));
    expect(await screen.findByText(/night settled/i)).toBeInTheDocument();
    expect(screen.getByText(/club pot \+2,000/i)).toBeInTheDocument();
  });

  it('ADMIN — the preview has no pot line at all, not even the contribution', async () => {
    await settleNight('admin');
    expect(screen.queryByText('Club Pot')).toBeNull();
    expect(screen.queryByRole('button', { name: /club pot balance/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/club pot/i);
    // Positive control: the rest of the preview is there.
    expect(screen.getByText(/^House take$/)).toBeInTheDocument();
  });

  it('ADMIN — the acknowledgement gives the totals and nothing about the pot', async () => {
    await settleNight('admin');
    fireEvent.click(screen.getByRole('button', { name: /^settle session$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirm & settle/i }));
    expect(await screen.findByText(/night settled/i)).toBeInTheDocument();
    expect(screen.getByText(/10,000 Chips in, 10,000 Chips out/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/club pot/i);
  });
});
