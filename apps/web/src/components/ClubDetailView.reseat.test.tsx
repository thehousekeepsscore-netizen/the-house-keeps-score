import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * Which player the sit-back-down button is actually about.
 *
 * This file exists because of a bug that shipped, and because of what happened
 * when the fix for it was checked. #41 corrected an admin pressing "Sit back
 * down" on somebody else's sheet and asking for a seat FOR THEMSELVES — the
 * viewed player's id was never sent:
 *
 *     requestSitIn(club.id, activeSession.id)          // sheetUid dropped
 *
 * Sixteen API tests and two component tests covered that change. Then the old
 * line was put back to see what failed, and NOTHING DID: typecheck passed and
 * all 432 web tests passed. The API tests call the service directly, and the
 * PlayerSheet tests hand it a mocked `onSitBackDown` prop, so neither one is
 * looking at the wire between them — which is exactly where the defect lived.
 *
 * So this asserts the one thing no other test does: that the id the sheet is
 * OPEN ON is the id that reaches the API client.
 *
 * It is deliberately incurious about wording. PlayerSheet.test.tsx owns the
 * labels; a regression test that also pins copy would fail on a rewording and
 * teach people to edit it without reading it. The button is found by the part
 * of the phrase both variants share.
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

// requestSitIn is the subject. The rest are stubbed for the same reason the
// render test stubs them: an unmocked fetcher resolves undefined and the cache
// throws, which looks nothing like the thing under test.
vi.mock('../lib/offlineSessions-api', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/offlineSessions-api')>('../lib/offlineSessions-api');
  return {
    ...actual,
    getActiveSession: vi.fn(),
    listBuyInRequests: vi.fn(),
    requestSitIn: vi.fn(),
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

/**
 * The sheet is replaced by a prop recorder, and that is the design of this
 * test rather than a shortcut around a difficulty.
 *
 * What is under test is ONE closure in ClubDetailView: the one that decides
 * which id `requestSitIn` is called with. Rendering the real sheet would drag
 * in `ui/Sheet`, which pushes and reconciles history entries through
 * module-level state — a mechanism with nothing to do with this wire, and one
 * that does not behave in jsdom the way it does in a browser.
 *
 * So the seam is the prop boundary: ClubDetailView hands the sheet a subject
 * and a callback, and both are captured here. PlayerSheet.test.tsx already owns
 * everything on the far side of that boundary — the labels, the states, which
 * control appears when. Neither file tests the other's half, and between them
 * the whole path is covered.
 */
let sheetProps: { userId: string; isSelf: boolean; onSitBackDown: () => void } | null = null;

vi.mock('./session/PlayerSheet', () => ({
  PlayerSheet: (props: { userId: string; isSelf: boolean; onSitBackDown: () => void }) => {
    sheetProps = props;
    return null;
  },
}));

import { ClubDetailView } from './ClubDetailView';
import { ResourceCacheProvider } from '../lib/resource-cache';
import * as offlineSessionsApi from '../lib/offlineSessions-api';
import * as clubsApi from '../lib/clubs-api';
import * as clubRecordsApi from '../lib/clubRecords-api';
import { Club, PokerSession, BuyInRequest } from '../types';
import type { AppUser as User } from '../lib/auth-types';

const NOW = Date.parse('2026-08-18T21:00:00.000Z');
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();

const RAHUL_STACK = 7200;

const currentUser = {
  uid: 'host',
  email: 'host@test.local',
  displayName: 'Host',
  photoURL: '',
  profileComplete: true,
} as unknown as User;

/** The host is an admin AND seated — the shape the bug needed to bite. */
const club = {
  id: 'c1',
  name: 'Friday Night',
  code: '60781',
  ownerUid: 'host',
  createdBy: 'host',
  adminUids: [],
  memberUids: ['host', 'rahul'],
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
} as unknown as Club;

const bank = (userId: string, id: string): BuyInRequest => ({
  id,
  sessionId: 's1',
  clubId: 'c1',
  userId,
  userDisplayName: '',
  amount: 5000,
  status: 'approved',
  requestedBy: userId,
  createdAt: ago(90),
});

/**
 * @param standing whose confirmed cash-out is on the table — the person whose
 *   seat therefore reads `cashedOut`, and who is NOT in activePlayerUids.
 */
function sessionWith(standing: string, seated: string[]): PokerSession {
  return {
    id: 's1',
    clubId: 'c1',
    sessionName: 'Fri 18 Aug · Day 1',
    status: 'active',
    activePlayerUids: seated,
    pendingSitInUids: [],
    sitInRequestedAt: {},
    cashOuts: [{ userId: standing, amount: RAHUL_STACK, status: 'confirmed' }],
    startedBy: 'host',
    createdAt: ago(120),
    startedPlayingAt: ago(90),
    timeExtensions: [],
    timeLimitLiftedAt: null,
    settlingAt: null,
  } as unknown as PokerSession;
}

function renderClub(session: PokerSession) {
  // The roster travels on the club record now, not a second request.
  vi.mocked(clubsApi.getClub).mockResolvedValue({
    ...club,
    roster: {
      host: { displayName: 'Host', avatarUrl: '' },
      rahul: { displayName: 'Rahul', avatarUrl: '' },
    },
  } as never);
  vi.mocked(clubRecordsApi.listHistory).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.getLeaderboard).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPotLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPendingChanges).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listAuditLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listDeletedSessions).mockResolvedValue([]);
  vi.mocked(offlineSessionsApi.getActiveSession).mockResolvedValue(session);
  vi.mocked(offlineSessionsApi.listBuyInRequests).mockResolvedValue([
    bank('host', 'b-host'),
    bank('rahul', 'b-rahul'),
  ]);
  vi.mocked(offlineSessionsApi.requestSitIn).mockResolvedValue(session);

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
 * Opens the sheet by pressing the person, which is how anybody does it. Going
 * through the real control rather than reaching for state is the point: the
 * wire under test starts at that press.
 *
 * Somebody who has stood up is no longer on the felt — they are in TheRoom, the
 * strip beside it — so this finds them by the one thing that identifies them in
 * either place and in either test: their stack. Matching the phrase would pin
 * copy this file has no business owning, and there is a second reason here:
 * TheRoom writes its own label ("cashed out with") instead of deriving one from
 * seat-vocabulary, which says in as many words that the person stood up and
 * only the ledger cashed out. That drift is real and is not this test's to fix.
 */
async function openSheetOfPersonWhoStoodUp(user: ReturnType<typeof userEvent.setup>) {
  const seat = await screen.findByRole('button', { name: /7,200/ }, { timeout: 8000 });
  await user.click(seat);
  await waitFor(() => expect(sheetProps).not.toBeNull(), { timeout: 5000 });
  return sheetProps!;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sheetProps = null;
});

describe('the sit-back-down action acts on the sheet it is open on', () => {
  it('AN ADMIN VIEWING ANOTHER PLAYER SENDS THAT PLAYER S ID', async () => {
    /*
     * The regression. Restore the old line —
     *   requestSitIn(club.id, activeSession.id)
     * — and this fails on the third argument, which is the whole point: it is
     * the only test in the suite that would.
     */
    const user = userEvent.setup();
    renderClub(sessionWith('rahul', ['host']));

    const sheet = await openSheetOfPersonWhoStoodUp(user);
    expect(sheet.userId, 'the sheet is open on the player, not the admin').toBe('rahul');
    expect(sheet.isSelf).toBe(false);

    await act(async () => {
      sheet.onSitBackDown();
    });

    await waitFor(() => expect(offlineSessionsApi.requestSitIn).toHaveBeenCalledTimes(1));
    expect(offlineSessionsApi.requestSitIn).toHaveBeenCalledWith('c1', 's1', 'rahul');

    // Said explicitly, because passing the admin's own id is the exact bug and
    // "some third argument" is not the assertion anybody wants here.
    const [, , target] = vi.mocked(offlineSessionsApi.requestSitIn).mock.calls[0];
    expect(target, 'must be the viewed player, never the admin').not.toBe('host');
  });

  it('a player asking for their own seat sends no target at all', async () => {
    // The host is the one who stood up, so the sheet is their own. Backward
    // compatibility is the claim: no body on the wire, exactly as before #41.
    const user = userEvent.setup();
    renderClub(sessionWith('host', ['rahul']));

    const sheet = await openSheetOfPersonWhoStoodUp(user);
    expect(sheet.userId).toBe('host');
    expect(sheet.isSelf).toBe(true);

    await act(async () => {
      sheet.onSitBackDown();
    });

    await waitFor(() => expect(offlineSessionsApi.requestSitIn).toHaveBeenCalledTimes(1));
    expect(offlineSessionsApi.requestSitIn).toHaveBeenCalledWith('c1', 's1', undefined);
  });
});
