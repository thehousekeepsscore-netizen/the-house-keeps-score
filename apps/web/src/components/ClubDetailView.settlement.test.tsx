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

function renderClub(over: Partial<PokerSession> = {}, clubOver: Partial<Club> = {}) {
  const active = { ...session, ...over };
  // Additive second argument, defaulted, so every existing caller is unchanged.
  // Needed only to prove the winner control ignores the club — which cannot be
  // shown while the club and the night's snapshot always agree.
  const theClub = { ...club, ...clubOver } as Club;
  // The roster travels on the club record now, not a second request.
  vi.mocked(clubsApi.getClub).mockResolvedValue({
    ...theClub,
    roster: { host: { displayName: 'Host' }, priya: { displayName: 'Priya' } },
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
        /*
          Mounted at '/' rather than '/clubs/:clubId', because Sheet registers
          its history entry against window.location — which jsdom pins at '/'
          regardless of where a memory router thinks it is. With the route at
          the club path, opening the settlement screen pushed to '/', matched
          nothing, and took the whole view down with it. Sheet.history.test.tsx
          mounts at '/' for exactly this reason.
        */
        path: '/',
        element: (
          <ResourceCacheProvider>
            <ClubDetailView
              club={theClub}
              currentUser={currentUser}
              playerAvatarUrl=""
              onBackToDashboard={vi.fn()}
            />
          </ResourceCacheProvider>
        ),
      },
    ],
    { initialEntries: ['/'] }
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
async function openSettlement(over: Partial<PokerSession> = {}, clubOver: Partial<Club> = {}) {
  renderClub(over, clubOver);
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

  it('will not arm the commit until every player has a cash-out', async () => {
    await openSettlement();

    const calc = screen.getByRole('button', { name: /^settle session$/i });
    expect(calc).toBeDisabled();
    expect(screen.getByText(/count everyone before you can settle/i)).toBeInTheDocument();

    // One of the two is not enough.
    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    expect(screen.getByRole('button', { name: /^settle session$/i })).toBeDisabled();

    fireEvent.change(amountFields()[3], { target: { value: '2000' } });
    expect(screen.getByRole('button', { name: /^settle session$/i })).toBeEnabled();
  });

  it('shows a preview only — nothing is committed by counting', async () => {
    await openSettlement();
    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    fireEvent.change(amountFields()[3], { target: { value: '2000' } });

    expect(await findPreview()).not.toHaveLength(0);
    expect(offlineSessionsApi.settleSession).not.toHaveBeenCalled();
  });

  it('shows each player their whole arithmetic, not just the answer', async () => {
    await openSettlement();
    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    fireEvent.change(amountFields()[3], { target: { value: '2000' } });

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

  /*
   * WHAT THE HOST IS TOLD WHEN THE MOST IRREVERSIBLE ACT IN THE PRODUCT
   * SUCCEEDS OR FAILS.
   *
   * Success said nothing: the message was written to `settlementSuccess`, a
   * state with no render site anywhere in the file, and the modal simply
   * vanished. Failure said it at the TOP of a modal that runs to several
   * thousand pixels, while the admin was at the bottom where the button they
   * pressed had just returned to "Confirm & Settle".
   *
   * On a money screen "nothing happened" reads as "press it again", which is
   * the behaviour use-action.ts exists to prevent.
   */
  async function commitSettlement() {
    await openSettlement();
    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    fireEvent.change(amountFields()[3], { target: { value: '2000' } });
    await findPreview();
    fireEvent.click(screen.getByRole('button', { name: /^settle session$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirm & settle/i }));
  }

  it('SUCCESS — says the night was settled, and names the figures committed', async () => {
    await commitSettlement();

    // The acknowledgement itself, through the app's own success channel.
    expect(await screen.findByText(/night settled/i)).toBeInTheDocument();
    // Reported from the settlement that was actually committed: 10,000 in
    // (5,000 each) against 10,000 out (8,000 + 2,000).
    expect(screen.getByText(/10,000 Chips in, 10,000 Chips out/i)).toBeInTheDocument();
  });

  it('SUCCESS — still closes the settlement screen, exactly as before', async () => {
    await commitSettlement();
    // The toast is the acknowledgement; the modal is not kept open to carry it.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: /settle night/i })).not.toBeInTheDocument()
    );
  });

  it('FAILURE — shows the server\'s reason beside the button that was pressed', async () => {
    vi.mocked(offlineSessionsApi.settleSession).mockRejectedValueOnce(
      new Error('Session is already settled')
    );
    await commitSettlement();

    const message = await screen.findByText(/session is already settled/i);
    expect(message).toBeInTheDocument();

    /*
     * Position is the point of this fix, so it is asserted rather than assumed.
     * The error must sit with the commit control, not at the top of the modal:
     * in DOM order it comes AFTER the preview and BEFORE the button.
     */
    const preview = screen.getAllByText(/^Profit \/ loss$/i)[0];
    const button = screen.getByRole('button', { name: /^settle session$/i });
    expect(
      preview.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING,
      'error renders after the preview, not above it'
    ).toBeTruthy();
    expect(
      message.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
      'and immediately before the control that failed'
    ).toBeTruthy();
  });

  it('FAILURE — never claims success, and leaves the screen open to correct it', async () => {
    vi.mocked(offlineSessionsApi.settleSession).mockRejectedValueOnce(
      new Error('Session is already settled')
    );
    await commitSettlement();
    await screen.findByText(/session is already settled/i);

    // The safety property: a failed settlement must not produce a success
    // message, and must not close the screen out from under the correction.
    expect(screen.queryByText(/night settled/i)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /settle night/i })).toBeInTheDocument();
  });

  it('DISARMS the commit when a figure changes underneath it', async () => {
    /*
     * This used to assert that the preview VANISHED, which was a fact about the
     * old reveal control rather than about safety: changing anything cleared
     * cashoutCalculated and the whole panel unmounted. Figures now stay on
     * screen and update live, so the disappearance is gone — and it was never
     * the property worth protecting.
     *
     * The property worth protecting is that a commit armed against one set of
     * numbers cannot be completed against a different set. That survives the
     * redesign intact, and it is what this asserts now.
     */
    await openSettlement();
    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    fireEvent.change(amountFields()[3], { target: { value: '2000' } });
    await findPreview();

    // Arm it: the second, deliberate tap appears only once armed.
    fireEvent.click(screen.getByRole('button', { name: /^settle session$/i }));
    expect(await screen.findByRole('button', { name: /confirm & settle/i })).toBeInTheDocument();

    // The host miscounted a stack.
    fireEvent.change(amountFields()[3], { target: { value: '2500' } });

    // The armed confirmation is withdrawn — nothing can be committed against
    // figures that have moved without arming again.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /confirm & settle/i })).not.toBeInTheDocument()
    );
    // And the figures did follow the edit rather than going stale on screen.
    expect(previewLines().length, 'the panel stays, showing the NEW numbers').toBeGreaterThan(0);
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

  it('does not hold the commit shut waiting for a figure it already has', async () => {
    await openSettlement(stoodUp);

    // Only the host's cash-out is outstanding.
    fireEvent.change(amountFields()[1], { target: { value: '2600' } });
    expect(screen.getByRole('button', { name: /^settle session$/i })).toBeEnabled();
  });
});

describe('the summary bar holds still while the count changes it', () => {
  /*
   * The lurch, measured before the fix at 390px: the bar was
   * flex/justify-between, so the instant the last cash-out field got its
   * first digit, DIFF went from "DIFF \u2014" (40px) to a 152px phrase and the
   * OUT label jumped 69px left in the same frame \u2014 and again at every
   * digit-count boundary, and again when the night hit "balanced".
   *
   * The mechanism under contract: IN and OUT are shrink-0 at fixed positions
   * on a plain gap row (no justify-between to redistribute), and DIFF is
   * anchored to the right edge with ml-auto + text-right, growing leftward
   * into space that belongs to nobody. jsdom does no layout, so this asserts
   * the mechanism's classes on the RENDERED bar across every DIFF state; the
   * pixel proof (OUT immobile at 320\u2013430px) is the browser measurement in
   * the PR record.
   */
  const summaryRow = () => {
    const inLabel = screen.getByText(/^IN\b/);
    return inLabel.closest('div')!;
  };
  const spans = () => [...summaryRow().querySelectorAll(':scope > span')] as HTMLElement[];

  const expectStableMechanism = () => {
    const row = summaryRow();
    expect(row.className).not.toContain('justify-between');
    expect(row.className).toContain('gap-3');
    const [inSpan, outSpan, diffSpan] = spans();
    expect(inSpan.className).toContain('shrink-0');
    expect(outSpan.className).toContain('shrink-0');
    expect(diffSpan.className).toContain('ml-auto');
    expect(diffSpan.className).toContain('text-right');
  };

  it('DIFF empty \u2014 the mechanism is in place before a single digit exists', async () => {
    await openSettlement();
    expect(spans()[2].textContent).toMatch(/DIFF/);
    expectStableMechanism();
  });

  it('DIFF as a long phrase, and OUT keeps its own layout slot', async () => {
    await openSettlement();
    fireEvent.change(amountFields()[1], { target: { value: '10' } });
    fireEvent.change(amountFields()[3], { target: { value: '7' } });
    await findPreview();

    expect(spans()[2].textContent).toMatch(/more in than out/);
    expectStableMechanism();
  });

  it('a balanced night \u2014 the shortest text of all, same allocation', async () => {
    await openSettlement();
    fireEvent.change(amountFields()[1], { target: { value: '6000' } });
    fireEvent.change(amountFields()[3], { target: { value: '4000' } });
    await findPreview();

    expect(spans()[2].textContent).toMatch(/balanced/i);
    expectStableMechanism();
  });

  it('transitions between the states never change the mechanism', async () => {
    // empty -> phrase -> balanced -> phrase again, asserted at each stop.
    await openSettlement();
    expectStableMechanism();

    fireEvent.change(amountFields()[1], { target: { value: '100' } });
    fireEvent.change(amountFields()[3], { target: { value: '50' } });
    await findPreview();
    expect(spans()[2].textContent).toMatch(/more in than out/);
    expectStableMechanism();

    fireEvent.change(amountFields()[1], { target: { value: '6000' } });
    fireEvent.change(amountFields()[3], { target: { value: '4000' } });
    await waitFor(() => expect(spans()[2].textContent).toMatch(/balanced/i));
    expectStableMechanism();

    fireEvent.change(amountFields()[3], { target: { value: '4100' } });
    await waitFor(() => expect(spans()[2].textContent).toMatch(/more out than in/));
    expectStableMechanism();
  });
});

describe('a night with no rules of its own', () => {
  const noRules = (): Partial<PokerSession> => {
    const { settlementRules, ...rest } = session;
    return { ...rest, settlementRules: undefined };
  };
  /** Already frozen — the shape Texas Holdem was found in. */
  const frozenNoRules = (): Partial<PokerSession> => ({ ...noRules(), settlingAt: ago(30) });

  /*
   * The recovery path. The server's initSettlementRules endpoint existed,
   * was audited and integration-tested — and had no caller anywhere in the
   * client, so a night that predated rule snapshots was permanently
   * unsettleable: the sheet said "somebody" must set the rules and the
   * product contained no way for anybody to do it. The mock of it in this
   * file's module mock sat unused for the same reason, which is exactly
   * how the gap survived: everything around the hole was tested.
   */

  it('asks for the rules BEFORE freezing the table, since the server only accepts them while playing', async () => {
    renderClub(noRules());
    await waitFor(() => expect(offlineSessionsApi.listBuyInRequests).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole('button', { name: /settle night/i }));

    expect(await screen.findByRole('heading', { name: /set this night's rules/i })).toBeInTheDocument();
    expect(offlineSessionsApi.beginSettling).not.toHaveBeenCalled();
  });

  it('sets the rules and carries on into settling in the same gesture', async () => {
    vi.mocked(offlineSessionsApi.initSettlementRules).mockResolvedValue({
      ...session,
    } as PokerSession);
    renderClub(noRules());
    await waitFor(() => expect(offlineSessionsApi.listBuyInRequests).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: /settle night/i }));
    await screen.findByRole('heading', { name: /set this night's rules/i });

    fireEvent.change(screen.getByLabelText(/rake — chips per player/i), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText(/winners' cut — % of profit/i), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /set rules & settle/i }));

    await waitFor(() => {
      expect(offlineSessionsApi.initSettlementRules).toHaveBeenCalledWith('c1', 's1', {
        sessionRakeAmount: 1000,
        winnersCutPercent: 5,
      });
    });
    // The same gesture continues into the freeze and the count.
    await waitFor(() => expect(offlineSessionsApi.beginSettling).toHaveBeenCalledWith('c1', 's1'));
    expect(await screen.findByRole('heading', { name: /settle night/i })).toBeInTheDocument();
  });

  it('refuses bad figures locally, with the server\u2019s own vocabulary', async () => {
    renderClub(noRules());
    await waitFor(() => expect(offlineSessionsApi.listBuyInRequests).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: /settle night/i }));
    await screen.findByRole('heading', { name: /set this night's rules/i });

    fireEvent.change(screen.getByLabelText(/rake — chips per player/i), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText(/winners' cut — % of profit/i), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: /set rules & settle/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/whole percentage between 0 and 100/i);
    expect(offlineSessionsApi.initSettlementRules).not.toHaveBeenCalled();
  });

  it('shows the server\u2019s refusal in its own words', async () => {
    vi.mocked(offlineSessionsApi.initSettlementRules).mockRejectedValue(
      new Error('This night already has its rules: rake 500 chips, winners\u2019 cut 2%.')
    );
    renderClub(noRules());
    await waitFor(() => expect(offlineSessionsApi.listBuyInRequests).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: /settle night/i }));
    await screen.findByRole('heading', { name: /set this night's rules/i });

    fireEvent.change(screen.getByLabelText(/rake — chips per player/i), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText(/winners' cut — % of profit/i), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /set rules & settle/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already has its rules/i);
    expect(offlineSessionsApi.beginSettling).not.toHaveBeenCalled();
  });

  it('an already-frozen night explains the way out instead of a dead end', async () => {
    // The sheet cannot take the rules here — the server accepts them only in
    // `playing` — so the warning names the exact recovery: back to the table,
    // then Settle night again.
    await openSettlement(frozenNoRules());

    const warning = screen.getByText(/started before its rules were recorded/i);
    // The guidance names the exact control that unblocks the night — which is
    // also on screen, so the match is scoped to the warning's own text.
    expect(warning.textContent).toMatch(/back to the table/i);
    expect(warning.textContent).toMatch(/settle night/i);
  });

  it('does not quietly substitute the club settings', async () => {
    await openSettlement(frozenNoRules());
    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    fireEvent.change(amountFields()[3], { target: { value: '2000' } });

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

  /*
   * WHO COUNTS AS A WINNER IS THE NIGHT'S QUESTION, NOT THE CLUB'S.
   *
   * The winner checkbox read `club.winnerDefinition` while the engine is handed
   * the night's frozen snapshot — and the rules panel at the top of the same
   * modal already printed the snapshot's value. The club's setting stays
   * editable while a night is running, so the two drift apart mid-count.
   *
   * The fixture below is the dangerous direction: the night agreed to MANUAL,
   * the club has since been changed to PROFIT_POSITIVE. Under the old code no
   * checkbox rendered at all, every entry submitted `manualWinner` undefined,
   * MANUAL marked nobody a winner, and any excess had nobody to charge — the
   * engine logs "no winners to deduct from" and the money leaves the books.
   *
   * The whole suite is otherwise PROFIT_POSITIVE, which is exactly why this
   * went unseen: the checkbox never rendered in any test.
   */
  /*
   * AN ACKNOWLEDGEMENT BELONGS TO THE FIGURES IT WAS MADE AGAINST.
   *
   * Under MANUAL, a mismatch hard-blocks the settle button on the client and
   * the server until an admin ticks "I have reconciled this". The tick used to
   * be cleared in exactly one place — reopening the modal — so it survived
   * every subsequent edit.
   *
   * That is worse than it sounds, because ticking the box makes the engine
   * return requiresManualResolution false, which UNMOUNTS the warning and
   * takes the ticked box off screen with it. The acknowledgement then has no
   * representation anywhere: a 300 mismatch is acknowledged, a cash-out is
   * corrected to make it 30,000, and the screen shows no warning at all
   * because the stale flag is still suppressing it.
   *
   * These drive the real screen through the real controls, because the bug is
   * in the wiring between them and not in any single value.
   */
  const MANUAL_RULES = { ...RULES, mismatchStrategy: 'MANUAL' };

  /** Cash-outs that do not sum to the buy-ins, so the engine has a mismatch. */
  async function openWithMismatch() {
    await openSettlement({ settlementRules: MANUAL_RULES });
    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    fireEvent.change(amountFields()[3], { target: { value: '2300' } }); // 10,300 out vs 10,000 in
    return await screen.findByRole('checkbox');
  }

  it('TEST 1 — changing a figure withdraws the acknowledgement', async () => {
    const ack = await openWithMismatch();
    expect(screen.getByText(/manual mismatch resolution/i)).toBeInTheDocument();

    fireEvent.click(ack);
    await waitFor(() =>
      expect(screen.queryByText(/manual mismatch resolution/i)).not.toBeInTheDocument()
    );

    // The typo correction. This is the exact sequence that shipped: the figure
    // moves, and the acknowledgement used to stay behind.
    fireEvent.change(amountFields()[3], { target: { value: '32000' } });

    // The warning must be back, and unticked. If the flag had survived, the
    // engine would still be told the mismatch was acknowledged and nothing
    // would render here at all.
    const again = await screen.findByRole('checkbox');
    expect(screen.getByText(/manual mismatch resolution/i)).toBeInTheDocument();
    expect((again as HTMLInputElement).checked).toBe(false);
  });

  it('TEST 2 — a change that leaves the mismatch identical still withdraws it', async () => {
    /*
     * Deliberate, and the smaller of two evils.
     *
     * The acknowledgement is made by reading the preview, and any edit already
     * invalidates that preview (cashoutCalculated). Letting the tick outlive
     * the panel it was made on is the whole defect. Binding it to the mismatch
     * AMOUNT would preserve this case — but it is a case worth very little:
     * every single-field edit moves mismatchAmount by construction
     * (totalCashOuts − totalBuyIns), so keeping it identical takes two
     * offsetting edits, and the winner tick changes who an excess is charged
     * to, which is the other half of what was acknowledged.
     *
     * So this asserts the conservative behaviour on purpose, rather than
     * claiming a distinction the settlement model does not really support.
     *
     * (Re-typing the SAME value into one field is not a test of this: React
     * fires no change event when the value has not moved, so the handler never
     * runs and nothing is exercised.)
     */
    const ack = await openWithMismatch();
    expect(screen.getAllByText(/300\D*more out than in/i).length).toBeGreaterThan(0);

    fireEvent.click(ack);
    await waitFor(() =>
      expect(screen.queryByText(/manual mismatch resolution/i)).not.toBeInTheDocument()
    );

    // +1,000 on one buy-in and +1,000 on one cash-out. Both totals move; the
    // difference between them does not.
    fireEvent.change(amountFields()[0], { target: { value: '6000' } });
    fireEvent.change(amountFields()[1], { target: { value: '9000' } });

    const again = await screen.findByRole('checkbox');
    expect(
      screen.getAllByText(/300\D*more out than in/i).length,
      'the mismatch really is unchanged'
    ).toBeGreaterThan(0);
    expect((again as HTMLInputElement).checked, 'and it is still withdrawn').toBe(false);
  });

  it('TEST 3 — changing a figure back leaves it withdrawn, not restored', async () => {
    // Determinism: the state depends on what has been acknowledged since the
    // last edit, never on how the figures got where they are.
    const ack = await openWithMismatch();
    fireEvent.click(ack);
    await waitFor(() =>
      expect(screen.queryByText(/manual mismatch resolution/i)).not.toBeInTheDocument()
    );

    fireEvent.change(amountFields()[3], { target: { value: '9999' } });
    fireEvent.change(amountFields()[3], { target: { value: '2300' } }); // back to the acknowledged night

    const again = await screen.findByRole('checkbox');
    expect(screen.getByText(/manual mismatch resolution/i)).toBeInTheDocument();
    expect((again as HTMLInputElement).checked).toBe(false);
  });

  it('and the settle button stays blocked until the new mismatch is acknowledged', async () => {
    // The consequence that makes this a money issue rather than a display one:
    // requiresManualResolution gates the arm control (and the server).
    const ack = await openWithMismatch();
    fireEvent.click(ack);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^settle session$/i })).toBeEnabled()
    );

    fireEvent.change(amountFields()[3], { target: { value: '32000' } });
    await screen.findByRole('checkbox');

    expect(screen.getByRole('button', { name: /^settle session$/i })).toBeDisabled();
  });

  it('THE NIGHT SAYS MANUAL — the winner control appears, though the club has moved on', async () => {
    await openSettlement({ settlementRules: { ...RULES, winnerDefinition: 'MANUAL' } });

    // The club fixture is PROFIT_POSITIVE. Reading it would render nothing.
    const winners = screen.getAllByRole('checkbox');
    expect(winners, 'one per player, from the night\'s rules').toHaveLength(2);
    expect(screen.getAllByText(/^Winner$/i).length).toBeGreaterThan(0);

    // And it is the control, not a badge: it must be tickable.
    fireEvent.click(winners[0]);
    expect((winners[0] as HTMLInputElement).checked).toBe(true);
  });

  it('THE CLUB SAYS MANUAL — still no winner control, because the night did not', async () => {
    /*
     * The mirror direction, and the reason the club override exists. Under the
     * old code a checkbox rendered here and ticking it invalidated the preview
     * and changed nothing — a control that lies about affecting money, because
     * the engine is handed PROFIT_POSITIVE and never reads manualWinner at all.
     */
    await openSettlement({ settlementRules: RULES }, { winnerDefinition: 'MANUAL' });
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('the rules panel and the winner control agree with each other', async () => {
    // They read the same object now. Before, the panel showed the snapshot and
    // the control obeyed the club, inside one modal.
    await openSettlement({ settlementRules: { ...RULES, winnerDefinition: 'MANUAL' } });
    expect(screen.getByText(/^manual$/i)).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });

  it('computes the figures from those rules, not the club\'s', async () => {
    // The club in this fixture charges nothing. If the preview were reading it,
    // there would be no rake line at all.
    await openSettlement({ settlementRules: RULES });
    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    fireEvent.change(amountFields()[3], { target: { value: '2000' } });

    await findPreview();
    // Anchored: the header now carries "House takes" too, and this is about
    // the preview's own breakdown.
    expect(screen.getByText(/^House take$/)).toBeInTheDocument();
    // 1,000 a seat from two players, plus 5% of the winner's 3,000 profit.
    // Neither line exists if the preview is reading the club, which charges 0.
    //
    // The label used to read "× 2 players" and restate the arithmetic. It no
    // longer does: the figure is now the engine's totalSeatFees, which caps a
    // seat fee at what the house actually took from that player, so rate ×
    // heads is not what the line says. SettlementPreview.test.tsx owns the
    // decomposition; this test only cares that the line exists at all, because
    // its existence is what proves the night's rules were used.
    expect(screen.getByText(/^Session rake$/)).toBeInTheDocument();
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

  it('holds the commit shut while a field is blank', async () => {
    await openSettlement();

    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    fireEvent.change(amountFields()[3], { target: { value: '2000' } });
    expect(screen.getByRole('button', { name: /^settle session$/i })).toBeEnabled();

    // The bug: a cleared field kept its key, so `uid in cashOutInputs` stayed
    // true and this settled somebody at a zero they never agreed to.
    fireEvent.change(amountFields()[3], { target: { value: '' } });
    expect(screen.getByRole('button', { name: /^settle session$/i })).toBeDisabled();
  });

  it('treats a deliberate zero as a real figure', async () => {
    // Losing every chip is the most ordinary thing at a table. A typed 0 must
    // count, even though a blank does not.
    await openSettlement();

    fireEvent.change(amountFields()[1], { target: { value: '10000' } });
    fireEvent.change(amountFields()[3], { target: { value: '0' } });

    expect(screen.getByRole('button', { name: /^settle session$/i })).toBeEnabled();
  });

  it('sends the figures as numbers, not as the text that was typed', async () => {
    await openSettlement();
    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    fireEvent.change(amountFields()[3], { target: { value: '2000' } });
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

/**
 * A5, locked before the screen that will break it is built.
 *
 * calculateSettlement coerces every field with `Number(cashOutInputs[uid] || 0)`,
 * and the engine has no way to express "not entered yet" — a blank is a zero.
 * Today nothing shows the consequence, because Calculate stays disabled until
 * every player has a figure, so a coerced zero never reaches the panel.
 *
 * The redesign removes that control and renders results continuously. At that
 * point a half-counted table would show confident nets for players nobody has
 * counted, each one a real-looking loss of exactly their bank.
 *
 * So this asserts the property rather than the mechanism: with a figure missing,
 * NO signed net appears for anyone. It passes today because of the gate, and it
 * has to keep passing when the gate is gone — which is the whole reason for
 * writing it now rather than alongside the code that needs it.
 *
 * The file's own history is the argument: "`uid in cashOutInputs` was the whole
 * test, so a field the host had cleared still counted... Auto Calculate unlocked
 * and settled somebody at zero they never agreed to."
 */
describe('a figure nobody has entered is not a figure', () => {
  it('A5 — with one cash-out missing, no player shows a net', async () => {
    await openSettlement();

    // Two players; count only the first.
    fireEvent.change(amountFields()[1], { target: { value: '8000' } });

    // Nothing is claimed about anybody while a figure is outstanding.
    expect(previewLines(), 'no per-player arithmetic yet').toHaveLength(0);
    // Positive form: an uncounted seat says so.
    expect(screen.getAllByText('—').length, 'uncounted seats read as —').toBeGreaterThan(0);
    // Negative form. NOT anchored at the end: this screen formats with the
    // club's unit ("+3,000 Chips"), and an anchored digits-only pattern matched
    // nothing, so an earlier version of this assertion passed against an empty
    // set while a fabricated net sat on screen beside it.
    expect(
      screen.queryAllByText(/^[+-][\d,]+/),
      'no signed net may appear while a cash-out is blank'
    ).toHaveLength(0);
  });

  it('A5 — a cleared field withdraws the figures again', async () => {
    await openSettlement();
    fireEvent.change(amountFields()[1], { target: { value: '8000' } });
    fireEvent.change(amountFields()[3], { target: { value: '2000' } });
    // The Calculate gate is still here in 7A; 7B is what removes it. The
    // invariant below is about the blank, not about how the figures got shown.
    await findPreview();

    // Blank is not zero. Clearing it must take the results away, not settle
    // that player at nothing.
    fireEvent.change(amountFields()[3], { target: { value: '' } });

    expect(previewLines()).toHaveLength(0);
    expect(screen.getAllByText('—').length, 'and the seats read as uncounted again').toBeGreaterThan(0);
    expect(screen.queryAllByText(/^[+-][\d,]+/)).toHaveLength(0);
  });
});

/**
 * The structure the device measurement was taken against.
 *
 * The iPhone run measured a Sheet: a flex column whose content scrolls in its
 * own overflow-y-auto child, with the action row OUTSIDE that child so the
 * keyboard cannot take it away. The settlement screen was a hand-rolled div
 * with none of that — one scrolling box, actions at the bottom of the scroll.
 *
 * So the measurement said nothing about this screen until it had the same
 * shape. This asserts the shape, so a later refactor cannot quietly return the
 * screen to a structure the evidence does not cover.
 *
 * It does NOT claim the keyboard behaves the same here. That needs the device
 * again, and it is the next commit's job.
 */
describe('the settlement screen is the structure that was measured', () => {
  it('is a Sheet: scrolling content, with the action row outside it', async () => {
    await openSettlement();
    const panel = screen.getByRole('dialog');

    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(panel.className, 'the measured height cap').toContain('max-h-[90dvh]');
    expect(panel.className, 'the wider desktop panel, per size="lg"').toContain('sm:max-w-lg');
    expect(panel.className).toContain('flex');
    expect(panel.className).toContain('safe-bottom');

    const scroller = Array.from(panel.children).find((c) =>
      c.className.includes('overflow-y-auto')
    );
    expect(scroller, 'content scrolls in its own child').toBeDefined();

    // The action row is a SIBLING of the scroller, not inside it. This is the
    // property the keyboard measurement depended on.
    const settle = screen.getByRole('button', { name: /^settle session$/i });
    expect(scroller!.contains(settle), 'the commit control must not scroll with the figures').toBe(false);
    expect(panel.contains(settle)).toBe(true);

    // And the summary is sticky inside the scroller, which is what commit 4
    // will have to reposition when the keyboard displaces the viewport.
    const sticky = scroller!.querySelector('.sticky');
    expect(sticky, 'pinned IN/OUT/DIFF').not.toBeNull();
    expect(sticky!.textContent).toMatch(/IN/);
  });
});

/**
 * The count's amount fields must not make iOS zoom the page.
 *
 * MEASURED on an iPhone against production, not inferred from a screenshot:
 *
 *   keyboard down   scale 1.0     viewport 402   scrollWidth 402   offsetLeft 0
 *   keyboard up     scale 1.3333  viewport 302   scrollWidth 402   offsetLeft 100
 *
 * 402 / 1.3333 = 302, and 402 − 302 = 100 — so offsetLeft 100 is the largest
 * offset there is, meaning Safari scrolled fully right and hid exactly 100 CSS
 * px of the left edge. That is the clipping: the IN column and the player names
 * fall off the side while OUT and DIFF stay in view.
 *
 * The cause is font size, not layout. 1.3333 is exactly 16/12 — iOS zooms a
 * focused input below 16px up to its readability threshold — and the same
 * device reports no overflow at all with the keyboard down.
 *
 * These assert the class rather than a computed pixel size on purpose:
 * Tailwind's stylesheet is not loaded in jsdom, so getComputedStyle would
 * report a default and pass whatever the class said. The mapping relied on
 * (`text-base` is 1rem is 16px) is Tailwind's, not ours.
 */
describe('the count does not make iOS zoom the page', () => {
  /** Tailwind sizes at or above iOS's 16px threshold. */
  const NO_ZOOM = ['text-base', 'text-lg', 'text-xl', 'text-2xl'];
  /** text-xs is 12px, text-sm is 14px — iOS zooms both. */
  const ZOOMS = ['text-xs', 'text-sm'];

  it('renders every amount field at 16px or larger', async () => {
    await openSettlement();
    const fields = amountFields();

    // Guard against passing because nothing rendered, which is what makes a
    // className assertion worthless.
    expect(fields.length).toBeGreaterThan(0);

    for (const f of fields) {
      const classes = f.className.split(/\s+/);
      expect(
        NO_ZOOM.some((s) => classes.includes(s)),
        `amount field is below the 16px threshold: "${f.className}"`
      ).toBe(true);
    }
  });

  it('leaves no amount field at a size iOS would zoom', async () => {
    // A separate claim from the one above: a class list could carry both a
    // zooming and a non-zooming size, and which wins is decided by the
    // stylesheet, not by the order of this array.
    await openSettlement();

    for (const f of amountFields()) {
      const classes = f.className.split(/\s+/);
      expect(
        ZOOMS.filter((s) => classes.includes(s)),
        `amount field still carries a zooming size: "${f.className}"`
      ).toEqual([]);
    }
  });

  it('asks iOS for a numeric pad rather than the punctuation keyboard', async () => {
    // Observed on a real iPhone: these fields opened the numbers-and-punctuation
    // layout — `- / : ; ( ) ₹ & @ "` with an ABC key — because `type="number"`
    // alone does not choose a keyboard on iOS. At a table, entering 13000 on a
    // punctuation keyboard is slower and easier to fumble than on a ten-key pad.
    //
    // `decimal` rather than `numeric`: both give the pad, and decimal keeps the
    // separator available rather than making a fractional value unenterable.
    await openSettlement();
    const fields = amountFields();

    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) {
      expect(f.getAttribute('inputmode'), `field "${f.className}" has no numeric hint`).toBe(
        'decimal'
      );
    }
  });

  it('still pins IN / OUT / DIFF, so the fix does not cost #55', async () => {
    // The clipping was only ever visible because #55 keeps this on screen with
    // the keyboard up. Fixing the horizontal problem must not lose the vertical
    // one it exposed.
    await openSettlement();

    const panel = screen.getByRole('dialog');
    const scroller = Array.from(panel.children).find((c) =>
      c.className.includes('overflow-y-auto')
    );
    const sticky = scroller!.querySelector('.sticky');
    expect(sticky, 'pinned IN/OUT/DIFF').not.toBeNull();
    expect(sticky!.textContent).toMatch(/IN/);
  });
});
