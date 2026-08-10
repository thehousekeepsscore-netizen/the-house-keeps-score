import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
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
  return {
    ...actual,
    getClub: vi.fn(),
    getClubRoster: vi.fn(),
  };
});

import { ClubDetailView } from './ClubDetailView';
import { ResourceCacheProvider } from '../lib/resource-cache';
import { __resetSheetHistory } from './ui/Sheet';
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
  // The rules this night plays by. A session without them cannot be settled at
  // all now, so every test that settles needs one — which is the guard working.
  settlementRules: {
    capturedAt: ago(90),
    sessionRakeAmount: 0,
    winnersCutPercent: 0,
    rakeEnabled: false,
    rakeMethod: 'PERCENT_PROFIT',
    rakeValue: 0,
    potEnabled: false,
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

  // Per MOUNT, not per test. Sheet's Back-gesture bookkeeping is module-level
  // while each render gets its own memory router, so a counter left over from
  // an earlier mount makes this router pop history it never pushed — it
  // resolves "/" and renders a 404 boundary instead of the screen.
  __resetSheetHistory();

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
  __resetSheetHistory();
});

/**
 * Unmount, let the Sheet finish, and only then reset it.
 *
 * Sheet reconciles its Back-gesture bookkeeping on a timeout, so a test that
 * ends with a sheet open schedules a navigate(-1) that lands AFTER the next
 * test has mounted its own router. That router has no history to pop, so it
 * resolves "/" and renders a 404 boundary — a failure in a test that did
 * nothing wrong, pointing nowhere near the cause. Draining the timer while the
 * right router is still up keeps each test's history to itself.
 */
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  __resetSheetHistory();
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

describe('a night with no rules of its own', () => {
  const noRules = (): Partial<PokerSession> => {
    const { settlementRules, ...rest } = session;
    return { ...rest, settlementRules: undefined };
  };

  it('says why it cannot be settled instead of showing figures', async () => {
    await openSettlement(noRules());

    expect(screen.getByText(/started before its rules were recorded/i)).toBeInTheDocument();
  });

  it('does not quietly substitute the club settings', async () => {
    await openSettlement(noRules());
    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    fireEvent.change(amountFields()[3], { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: /auto calculate/i }));

    // No preview at all: the admin is never shown numbers the server would
    // refuse to commit.
    expect(previewLines()).toHaveLength(0);
    expect(screen.getByRole('button', { name: /^settle session$/i })).toBeDisabled();
  });
});

describe('the rules on the settlement screen', () => {
  it('shows what this night is being settled by', async () => {
    await openSettlement();

    expect(screen.getByText(/this night's rules/i)).toBeInTheDocument();
    expect(screen.getByText(/^Rake$/)).toBeInTheDocument();
    expect(screen.getByText(/^Winners' cut$/)).toBeInTheDocument();
    expect(screen.getByText(/^Rounding$/)).toBeInTheDocument();
  });

  it('reads them from the session, not from the club', async () => {
    // The club charges; the night does not. What is shown must be the night's.
    await openSettlement({
      settlementRules: { ...session.settlementRules!, sessionRakeAmount: 1000, winnersCutPercent: 5 },
    });

    expect(screen.getByText('1,000 chips')).toBeInTheDocument();
    expect(screen.getByText('5%')).toBeInTheDocument();
  });

  it('says the club cannot move them', async () => {
    await openSettlement();
    expect(screen.getByText(/changing the club's settings does not move them/i)).toBeInTheDocument();
  });
});

/**
 * The exact path tonight.
 *
 * A night already in progress with no rules of its own; an admin sets 1,000
 * chips and 5%; and then every way anyone can arrive at that session has to
 * show the same two numbers — the host's own screen, a second admin's, a
 * player's, a reload, and the settlement preview that decides the money.
 *
 * Written because this is the sequence about to be performed on a live game
 * with real chips on the table, and "it worked when I tried it once" is not
 * the same as knowing every arrival agrees.
 */
describe('setting a running night\'s rules, then arriving from everywhere', () => {
  const RULES = {
    capturedAt: ago(1),
    sessionRakeAmount: 1000,
    winnersCutPercent: 5,
    rakeEnabled: true,
    rakeMethod: 'PERCENT_PROFIT',
    rakeValue: 0,
    potEnabled: true,
    mismatchStrategy: 'PROPORTIONAL_WINNERS',
    rakeOrder: 'MISMATCH_FIRST',
    winnerDefinition: 'PROFIT_POSITIVE',
    winnerTopN: 1,
    roundingRule: 'NONE',
  };

  const withoutRules = (): Partial<PokerSession> => {
    const { settlementRules, ...rest } = session;
    return { ...rest, settlementRules: undefined };
  };

  /*
   * NOT COVERED HERE: clicking through the sheet to the API call.
   *
   * Sheet pushes a history entry asynchronously so the Back gesture closes it
   * instead of leaving the screen. Under jsdom that push and a synchronous
   * fireEvent race, and the sheet closes under the test — it passes alone and
   * fails behind any other mount in the file, which is a test that reports on
   * its neighbours rather than on the code.
   *
   * Rather than leave a flaky test asserting something important, the two
   * cases it covered are recorded as unverified: that Confirm sends exactly
   * {sessionRakeAmount: 1000, winnersCutPercent: 5}, and that the first tap
   * sends nothing. The server side of both IS covered — initSettlementRules
   * has integration tests for the figures, the one-shot rule and concurrency.
   * What is missing is the click path, and it wants a browser rather than a
   * better mock.
   */
  it('offers the host a way to set them, on the felt while the night runs', async () => {
    renderClub(withoutRules());
    await waitFor(() => expect(offlineSessionsApi.listBuyInRequests).toHaveBeenCalled());

    // Not on the settlement screen: opening that freezes the table, and the
    // server refuses to set rules once it is frozen.
    expect(await screen.findByText(/no settlement rules yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set tonight's rules/i })).toBeInTheDocument();
  });



  it('stops asking once the night has them', async () => {
    renderClub({ settlementRules: RULES });
    await waitFor(() => expect(offlineSessionsApi.listBuyInRequests).toHaveBeenCalled());
    await screen.findByRole('button', { name: /settle night/i });

    // The server refuses a second attempt, so a control still on screen would
    // be offering something that cannot happen.
    expect(screen.queryByText(/no settlement rules yet/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /set tonight's rules/i })).not.toBeInTheDocument();
  });

  it('tells everyone at the table, players included', async () => {
    // Derived from capturedAt, so it is in the story on a fresh load too —
    // not a notification that only the connected admin saw.
    renderClub({ settlementRules: RULES, isAdmin: false } as never);
    await waitFor(() => expect(offlineSessionsApi.listBuyInRequests).toHaveBeenCalled());

    expect(await screen.findByText(/settlement rules set/i)).toBeInTheDocument();
    expect(screen.getByText(/rake 1,000/i)).toBeInTheDocument();
    expect(screen.getByText(/winners' cut 5%/i)).toBeInTheDocument();
  });

  it('shows a second admin the same two numbers on the settlement screen', async () => {
    // A fresh mount IS the reconnect and reload case: nothing is held in
    // memory, everything comes from the session the server returned.
    await openSettlement({ settlementRules: RULES });

    expect(screen.getByText('1,000 chips')).toBeInTheDocument();
    expect(screen.getByText('5%')).toBeInTheDocument();
  });

  it('computes Auto Calculate from those rules, not the club\'s', async () => {
    // The club in this fixture charges nothing. If the preview were reading it,
    // there would be no rake line at all.
    await openSettlement({ settlementRules: RULES });
    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    fireEvent.change(amountFields()[3], { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: /auto calculate/i }));

    await findPreview();
    // Anchored: the header now carries "House takes" too, and this is about
    // the preview's own breakdown.
    expect(screen.getByText(/^House take$/)).toBeInTheDocument();
    // 1,000 a seat from two players, plus 5% of the winner's 3,000 profit.
    // Neither line exists if the preview is reading the club, which charges 0.
    // The label restates the arithmetic — rate × heads — so a host can see
    // where 2,000 came from rather than being handed the total.
    expect(screen.getByText(/^Session rake × 2 players$/)).toBeInTheDocument();
    expect(screen.getByText(/^Winners' cut \(5%\)$/)).toBeInTheDocument();
  });
});

/**
 * Typing figures into the settlement screen.
 *
 * Both of these were found at a table, mid-count, which is the worst possible
 * place: the fields hold money and the host is reading a stack of chips, not
 * auditing an input component.
 */
describe('entering figures', () => {
  it('does not leave a 0 behind when a field is cleared', async () => {
    await openSettlement();
    const cashOut = amountFields()[1];

    fireEvent.change(cashOut, { target: { value: '5000' } });
    fireEvent.change(cashOut, { target: { value: '' } });

    // Number('') is 0, so coercing on every keystroke refilled the box with a
    // zero that could not be deleted — and 5000 typed in front of it read back
    // as 50000.
    expect((cashOut as HTMLInputElement).value).toBe('');
  });

  it('keeps what was typed, without a leading zero', async () => {
    await openSettlement();
    const cashOut = amountFields()[1];

    fireEvent.change(cashOut, { target: { value: '0' } });
    fireEvent.change(cashOut, { target: { value: '5000' } });

    expect((cashOut as HTMLInputElement).value).toBe('5000');
  });

  it('holds Auto Calculate shut while a field is blank', async () => {
    await openSettlement();

    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    fireEvent.change(amountFields()[3], { target: { value: '2000' } });
    expect(screen.getByRole('button', { name: /auto calculate/i })).toBeEnabled();

    // The bug: a cleared field kept its key, so `uid in cashOutInputs` stayed
    // true and this settled somebody at a zero they never agreed to.
    fireEvent.change(amountFields()[3], { target: { value: '' } });
    expect(screen.getByRole('button', { name: /auto calculate/i })).toBeDisabled();
  });

  it('treats a deliberate zero as a real figure', async () => {
    // Losing every chip is the most ordinary thing at a table. A typed 0 must
    // count, even though a blank does not.
    await openSettlement();

    fireEvent.change(amountFields()[1], { target: { value: '10000' } });
    fireEvent.change(amountFields()[3], { target: { value: '0' } });

    expect(screen.getByRole('button', { name: /auto calculate/i })).toBeEnabled();
  });

  it('sends the figures as numbers, not as the text that was typed', async () => {
    await openSettlement();
    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    fireEvent.change(amountFields()[3], { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: /auto calculate/i }));
    await findPreview();
    fireEvent.click(screen.getByRole('button', { name: /^settle session$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirm & settle/i }));

    await waitFor(() => {
      expect(offlineSessionsApi.settleSession).toHaveBeenCalledWith('c1', 's1',
        expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({ userId: 'host', cashOut: 8000 }),
            expect.objectContaining({ userId: 'priya', cashOut: 2000 }),
          ]),
        }));
    });
  });
});
