import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * What each role actually sees on the session board.
 *
 * The board's permission model is one boolean derived inside the component --
 * isAdmin, which includes the owner -- so these tests drive it the only honest
 * way: three club fixtures that differ in ownerUid/adminUids, evaluated by the
 * component's own derivation against the signed-in uid. No role prop exists,
 * and none is invented here; a harness that set "role" directly would assert
 * against its own input.
 *
 * Two of these are redesign guarantees, the rest are the existing permission
 * surface pinned down so a restyle cannot quietly move it:
 *
 *   - The section under the table is titled HISTORY (it was "Live").
 *   - The header names the role: the owner reads Owner, a non-owner admin
 *     reads Admin, a player reads neither. A label only -- the capabilities
 *     asserted around it are identical for owner and admin, deliberately.
 *   - Settle night is admin-only. The reference design drew it on the player
 *     board; the product does not grant it, so the test pins its absence.
 *   - The Approve tab is admin-only.
 *   - The feed shows EVERY player's events to EVERY role. That is the current
 *     product's deliberate design (see LiveFeed.tsx -- the feed is the point,
 *     for players especially), and under MATCH_HIGHEST players need the room's
 *     banks to know the table ceiling. Restricting players to their own events
 *     would need server-side filtering that does not exist; if that lands, this
 *     is the test that must change -- knowingly, not by accident.
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
  return { ...actual, getClub: vi.fn(), listJoinRequests: vi.fn() };
});

const socketHandlers = new Map<string, Set<(...a: unknown[]) => void>>();
const fakeSocket = {
  connected: false,
  active: true,
  on: vi.fn((e: string, fn: (...a: unknown[]) => void) => {
    if (!socketHandlers.has(e)) socketHandlers.set(e, new Set());
    socketHandlers.get(e)!.add(fn);
  }),
  off: vi.fn((e: string, fn: (...a: unknown[]) => void) => socketHandlers.get(e)?.delete(fn)),
  emit: vi.fn(),
  connect: vi.fn(),
};
vi.mock('../lib/socket', () => ({ getSocket: () => fakeSocket, resetSocket: vi.fn() }));

import { ClubDetailView } from './ClubDetailView';
import { ResourceCacheProvider } from '../lib/resource-cache';
import * as offlineSessionsApi from '../lib/offlineSessions-api';
import * as clubsApi from '../lib/clubs-api';
import * as clubRecordsApi from '../lib/clubRecords-api';
import { Club, PokerSession, BuyInRequest } from '../types';
import type { AppUser as User } from '../lib/auth-types';

const NOW = Date.now();
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();

const currentUser = {
  uid: 'me',
  email: 'me@test.local',
  displayName: 'Me',
  photoURL: '',
  profileComplete: true,
} as unknown as User;

/** The signed-in uid is 'me'; ownership fields are what vary per role. */
function clubAs(role: 'owner' | 'admin' | 'player'): Club {
  return {
    id: 'c1',
    name: 'Friday Night',
    code: '60781',
    ownerUid: role === 'owner' ? 'me' : 'somebody-else',
    createdBy: role === 'owner' ? 'me' : 'somebody-else',
    adminUids: role === 'admin' ? ['me'] : ['somebody-else'],
    memberUids: ['me', 'priya', 'somebody-else'],
    isMember: true,
    minBuyIn: 1000,
    maxBuyIn: 5000,
    buyInMode: 'MATCH_HIGHEST',
    memberCount: 3,
    adminCount: 1,
    maxCapacity: 50,
    createdAt: ago(9999),
  } as unknown as Club;
}

const session: PokerSession = {
  id: 's1',
  clubId: 'c1',
  sessionName: 'Fri · Day 1',
  status: 'active',
  activePlayerUids: ['me', 'priya'],
  pendingSitInUids: [],
  sitInRequestedAt: {},
  cashOuts: [],
  startedBy: 'somebody-else',
  createdAt: ago(120),
  startedPlayingAt: ago(90),
  timeExtensions: [],
  timeLimitLiftedAt: null,
  settlingAt: null,
};

const buyIn = (id: string, userId: string, amount: number, minsAgo: number): BuyInRequest => ({
  id,
  sessionId: 's1',
  clubId: 'c1',
  userId,
  userDisplayName: '',
  amount,
  status: 'approved',
  requestedBy: userId,
  createdAt: ago(minsAgo),
});

function renderAs(
  role: 'owner' | 'admin' | 'player',
  // Overridable, because renderAs mocks this itself: a test that sets the
  // fixture before calling in gets silently stomped — which is exactly how
  // the first version of the pending-queue test ended up asserting against
  // an approved-only night while believing a request was pending. The club
  // override exists for the same reason: the pot-header tests stepped on the
  // same rake before it did.
  buyIns: BuyInRequest[] = [buyIn('b-mine', 'me', 5000, 80), buyIn('b-priya', 'priya', 3000, 40)],
  clubOverride?: Partial<Club>,
  // `null` is meaningful: a club with no active session renders a different
  // header entirely. `undefined` keeps the default live night.
  sessionOverride: PokerSession | null | undefined = undefined
) {
  const club = { ...clubAs(role), ...clubOverride };
  vi.mocked(clubsApi.getClub).mockResolvedValue(club);
  vi.mocked(clubsApi.listJoinRequests).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listHistory).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.getLeaderboard).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPotLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listPendingChanges).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listAuditLog).mockResolvedValue([]);
  vi.mocked(clubRecordsApi.listDeletedSessions).mockResolvedValue([]);
  vi.mocked(offlineSessionsApi.getActiveSession).mockResolvedValue(sessionOverride === undefined ? session : (sessionOverride as never));
  // Two players' money, so "does a role see the OTHER player's event" is a
  // question the fixture can answer.
  vi.mocked(offlineSessionsApi.listBuyInRequests).mockResolvedValue(buyIns);

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
  // Both route shapes, mirroring App: the screen navigates between its own
  // tabs as /clubs/:clubId/:tab, and a router without that route turns a
  // pot-card tap into a 404 error boundary.
  const router = createMemoryRouter(
    [
      { path: '/clubs/:clubId', element },
      { path: '/clubs/:clubId/:tab', element },
    ],
    { initialEntries: ['/clubs/c1'] }
  );
  return render(<RouterProvider router={router} />);
}

/** The felt has painted once the ceiling line is up. */
async function settled() {
  await waitFor(() => expect(screen.getByText(/Max buy-in/i)).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  socketHandlers.clear();
  localStorage.clear();
});

describe('the section under the table is TONIGHT', () => {
  it('is titled Tonight — not Live, and not History', async () => {
    // The feed was renamed twice for the same reason arrived at in stages:
    // "Live" described the transport, and "History" collided with the
    // bottom-nav tab of the same name three hundred pixels below — one word,
    // two objects, one viewport. "Tonight" is the brief's own phrase for this
    // section (§11, the story of the evening), and collides with nothing.
    renderAs('player');
    await settled();

    const section = await screen.findByLabelText('Tonight');
    expect(section.querySelector('span.uppercase')?.textContent).toBe('Tonight');
    expect(screen.queryByText('Live', { selector: 'span' })).not.toBeInTheDocument();
    expect(screen.queryByText('History', { selector: 'span.uppercase' })).not.toBeInTheDocument();
  });
});

describe('the header names the role', () => {
  it('the owner reads Owner', async () => {
    renderAs('owner');
    await settled();
    expect(screen.getByText('· Owner')).toBeInTheDocument();
    expect(screen.queryByText('· Admin')).not.toBeInTheDocument();
  });

  it('a non-owner admin reads Admin', async () => {
    renderAs('admin');
    await settled();
    expect(screen.getByText('· Admin')).toBeInTheDocument();
    expect(screen.queryByText('· Owner')).not.toBeInTheDocument();
  });

  it('a player reads neither', async () => {
    renderAs('player');
    await settled();
    expect(screen.queryByText('· Owner')).not.toBeInTheDocument();
    expect(screen.queryByText('· Admin')).not.toBeInTheDocument();
  });
});

describe('capabilities stay exactly where they were', () => {
  it('owner and admin can settle the night; a player cannot', async () => {
    renderAs('owner');
    await settled();
    expect(screen.getByRole('button', { name: 'Settle night' })).toBeInTheDocument();
  });

  it('admin sees Settle night too — identical to the owner, deliberately', async () => {
    renderAs('admin');
    await settled();
    expect(screen.getByRole('button', { name: 'Settle night' })).toBeInTheDocument();
  });

  it('the player board has no Settle night, whatever the mockup drew', async () => {
    renderAs('player');
    await settled();
    expect(screen.queryByRole('button', { name: 'Settle night' })).not.toBeInTheDocument();
  });

  it('Approve is a tab only admins have', async () => {
    renderAs('admin');
    await settled();
    expect(screen.getByRole('button', { name: /Approve/ })).toBeInTheDocument();
  });

  it('and a player does not', async () => {
    renderAs('player');
    await settled();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
  });
});

describe('the session-less pot club header — the crush that hid the club\u2019s own name', () => {
  /*
   * On a pot-enabled club with no active session, an admin\u2019s header carries
   * the pot-balance card AND Start New Session — ~336px of unshrinkable
   * actions in a justify-between row that never wrapped. The flex-1 identity
   * block was crushed to nothing and its shrink-0 contents overflowed their
   * own box: measured in production at 320 and 390, the pot card rendered on
   * top of the back button and the club code, and the club\u2019s name vanished.
   * The no-pot club stayed clean, which is what isolated the trigger — and is
   * why no earlier audit saw it: every previous pass used a club with a live
   * session, where this header variant never renders.
   *
   * Contract, not geometry (jsdom does no layout): the row must be allowed to
   * wrap below sm. Pixels were verified in the browser.
   */
  const potClub = (): Club => ({
    ...clubAs('owner'),
    potEnabled: true,
    sessionRakeAmount: 750,
    winnersCutPercent: 3,
  });

  const renderSessionless = () => renderAs('owner', [], potClub(), null);

  it('the header row wraps on phones, and the identity CLAIMS the line', async () => {
    renderSessionless();
    await screen.findByText(/Start New Session/i);

    const title = screen.getByRole('heading', { name: 'Friday Night' });
    const row = title.closest('.max-w-7xl');
    expect(row).not.toBeNull();
    expect(row!.className).toContain('flex-wrap');
    expect(row!.className).toContain('sm:flex-nowrap');

    /*
     * The half this contract missed the first time. #87 shipped with
     * flex-wrap and still crushed at 390px, because wrapping is decided from
     * flex-basis and flex-1 leaves the identity's basis at 0% — the browser
     * summed 0 + 336 <= 358 and never broke the line. basis-full makes the
     * wrap deterministic on phones; sm:basis-0 restores the desktop row.
     * Production proved the classes matter individually, so they are pinned
     * individually.
     */
    const identity = row!.firstElementChild as HTMLElement;
    expect(identity.className).toContain('basis-full');
    expect(identity.className).toContain('sm:basis-0');
    expect(identity.className).not.toContain('flex-1');
  });

  it('the History toolbar wraps rather than clipping its last chip', async () => {
    // 320px gives this row ~254px and its content wants ~304: without wrap
    // the "Completed Sessions" chip was clipped mid-word off the card edge.
    renderAs('owner');
    await settled();
    fireEvent.click(screen.getAllByRole('button', { name: /history/i })[0]);

    const chip = await screen.findByText(/Completed Sessions:/i);
    const toolbar = chip.closest('.gap-2');
    expect(toolbar).not.toBeNull();
    expect(toolbar!.className).toContain('flex-wrap');
  });

  it('the pot explainer states THIS club\u2019s charges', async () => {
    renderSessionless();
    const potCard = await screen.findByTitle('View Club Pot Ledger');
    fireEvent.click(potCard);

    const blurb = await screen.findByText(/Accumulated from/i);
    expect(blurb.textContent).toContain('750');
    expect(blurb.textContent).toContain("3% winners' cut");
    expect(blurb.textContent).toContain('per player');
    // The fossil figures must be gone: they were wrong for the first real
    // pot-enabled club to ever read them.
    expect(blurb.textContent).not.toContain('5%');
    expect(blurb.textContent).not.toContain('₹1,000/game');
  });
});

describe('the plaque holds the rule, identically for every role', () => {
  it('names the night and the ceiling in one piece of furniture', async () => {
    // Session identity and the buy-in ceiling are public facts, so the plaque
    // is the same object whoever is looking at it — role differences live in
    // the actions, never in the rule.
    for (const role of ['owner', 'player'] as const) {
      const view = renderAs(role);
      await settled();
      const label = screen.getByText('Max buy-in');
      const plaque = label.closest('.furniture');
      expect(plaque, `${role}: ceiling is set into the plaque`).not.toBeNull();
      expect(plaque!.textContent).toContain('Fri · Day 1');
      // Contract, not geometry (jsdom does no layout): the row must wrap, or
      // the two shrink-0 slots crush the truncating name to zero width at
      // 320px — production shipped once with the plaque opening on an
      // orphaned "· 20 days". Pixel truth is the browser check's job.
      expect(plaque!.className).toContain('flex-wrap');
      view.unmount();
    }
  });
});

describe('one brass-filled control per instant', () => {
  it('the shelf takes gold when nothing else asks', async () => {
    // Queue empty, clock plain running: Settle night is the evening's one
    // destination and reads as the board's single filled control.
    renderAs('owner');
    await settled();
    const settle = screen.getByRole('button', { name: 'Settle night' });
    expect(settle.className).toContain('control-primary');
  });

  it('and yields to leather the moment a request is pending', async () => {
    // The pending card's Approve is the screen's demand; a gold shelf beside
    // a gold decision is two candidates for one glance — the exact failure
    // §2.6 exists to prevent.
    renderAs('owner', [
      buyIn('b-mine', 'me', 5000, 80),
      { ...buyIn('b-pending', 'priya', 3000, 1), status: 'pending' as const },
    ]);
    await settled();
    // The queue writes no sentences — a row is a name, a tag and the two
    // decisions, labelled "Approve NAME" / "Reject NAME". The reject side is
    // the anchor because bare /approve/i also matches two navigation tabs,
    // and findByRole treats multiple matches as not-found-yet until timeout.
    await screen.findByRole('button', { name: /reject/i });
    const settle = screen.getByRole('button', { name: 'Settle night' });
    expect(settle.className).toContain('control-secondary');
    expect(settle.className).not.toContain('control-primary');
  });
});

describe('history visibility is the same for every role — the current contract', () => {
  it('a player sees the other player’s event, amount included', async () => {
    // Documents today's deliberate design rather than the reference render:
    // the feed narrates the whole room to everyone, and the MATCH_HIGHEST
    // ceiling players are shown is derived from everyone's banks. If per-role
    // filtering ever lands (a server-side change), this test is the one that
    // must be rewritten on purpose.
    renderAs('player');
    await settled();

    const history = screen.getByLabelText('Tonight');
    await waitFor(() => {
      expect(history.textContent).toMatch(/bought in for/);
    });
    expect(history.textContent).toContain('3,000'); // priya's money, seen by a player
  });

  it('the owner sees the same room', async () => {
    renderAs('owner');
    await settled();

    const history = screen.getByLabelText('Tonight');
    await waitFor(() => {
      expect(history.textContent).toMatch(/bought in for/);
    });
    expect(history.textContent).toContain('3,000');
  });
});
