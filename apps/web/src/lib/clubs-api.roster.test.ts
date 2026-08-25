import { describe, it, expect } from 'vitest';
import { toClub, type ApiClub } from './clubs-api';

/**
 * The roster travels on the club record.
 *
 * It used to be a second `GET /clubs/:id` behind its own cache key, which the
 * cache could not collapse — per-key single-flight cannot dedupe two keys over
 * one URL — so the screen's heaviest endpoint was fetched twice on mount and
 * twice on every resync.
 *
 * These tests exist because the first version of this change had no test that
 * `toClub` actually populates the roster: setting it to `undefined` broke
 * nothing in the suite while typecheck stayed clean, so the screen would have
 * silently lost every display name and shown "Player" everywhere. Request
 * counts alone cannot catch that — one request that returns nothing useful is
 * still one request.
 */

const userRef = (id: string, displayName: string) => ({
  id,
  displayName,
  email: `${id}@test.local`,
  avatarUrl: null,
});

const apiClub = {
  id: 'c1',
  name: 'Club',
  code: '0007',
  description: null,
  ownerId: 'owner',
  owner: userRef('owner', 'Owner'),
  admins: [userRef('admin', 'Admin')],
  members: [userRef('member', 'Member')],
  memberCount: 3,
  adminCount: 1,
  maxCapacity: 9,
  buyInMode: 'UNCAPPED',
  minBuyIn: 0,
  maxBuyIn: 0,
  devaluationFactor: 1,
  enableDevaluation: false,
  clubPotBalance: 0,
  leaderboardVisibleToPlayers: true,
  sessionRakeAmount: 0,
  winnersCutPercent: 0,
  rakeEnabled: false,
  rakeMethod: 'PERCENT_PROFIT',
  rakeValue: 0,
  potEnabled: false,
  mismatchStrategy: 'PROPORTIONAL_WINNERS',
  rakeOrder: 'RAKE_FIRST',
  winnerDefinition: 'NET_POSITIVE',
  winnerTopN: 1,
  roundingRule: 'NEAREST',
  isOwner: true,
  isAdmin: true,
  isMember: true,
  createdAt: '2026-01-01T00:00:00.000Z',
} as unknown as ApiClub;

describe('the club record carries its roster', () => {
  it('includes owner, admins and members, keyed by uid', () => {
    const roster = toClub(apiClub).roster;

    expect(roster).toBeDefined();
    expect(Object.keys(roster!).sort()).toEqual(['admin', 'member', 'owner']);
  });

  it('carries the display details the screen renders, not just ids', () => {
    // The ids were already on the club as adminUids/memberUids. The reason this
    // resource existed at all was the names.
    const roster = toClub(apiClub).roster!;

    expect(roster.owner.displayName).toBe('Owner');
    expect(roster.admin.displayName).toBe('Admin');
    expect(roster.member.displayName).toBe('Member');
    expect(roster.member.email).toBe('member@test.local');
  });

  it('normalises a null avatar to undefined', () => {
    expect(toClub(apiClub).roster!.owner.avatarUrl).toBeUndefined();
  });

  it('is undefined for a club the viewer is only browsing', () => {
    // The public projection carries counts instead of people, so there is
    // nobody to list and no roster to build.
    const publicProjection = {
      ...apiClub,
      owner: undefined,
      admins: undefined,
      members: undefined,
    } as unknown as ApiClub;

    expect(toClub(publicProjection).roster).toBeUndefined();
  });
});
