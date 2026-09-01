import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

/**
 * The dashboard on a phone: input sizes iOS will not zoom, and touch targets
 * a thumb can hit.
 *
 * Both halves were MEASURED against production at 375px before being fixed —
 * the search bar and both create-form text fields rendered at 12px, the three
 * Advanced Settings number fields at 14px, the create-page back button at
 * 36x36, the header sign-out at 34x34 and the browse-card buttons at 36px
 * tall. iOS zooms any focused input below 16px (the full mechanism, measured
 * on a real iPhone, is documented at SETTLEMENT_AMOUNT_INPUT in
 * ClubDetailView), and 44px is this project's stated touch floor
 * (ui/Button.tsx).
 *
 * Class assertions rather than computed pixels, deliberately: Tailwind's
 * stylesheet is not loaded in jsdom, and getBoundingClientRect performs no
 * layout here. What text-base and min-h-[44px] resolve to was verified in a
 * real browser; these tests keep the classes from quietly disappearing.
 */

vi.mock('../lib/auth-context', async () => {
  const actual = await vi.importActual<typeof import('../lib/auth-context')>('../lib/auth-context');
  return {
    ...actual,
    useAuth: () => ({
      user: { uid: 'u1', email: 'host@test.local', displayName: 'Host', profileComplete: true },
      status: 'authenticated',
      logout: vi.fn(),
      authError: null,
      clearAuthError: vi.fn(),
    }),
  };
});

vi.mock('../lib/clubs-api', async () => {
  const actual = await vi.importActual<typeof import('../lib/clubs-api')>('../lib/clubs-api');
  return { ...actual, listClubsRaw: vi.fn(), listJoinRequests: vi.fn() };
});

import { ClubDashboardView } from './ClubDashboardView';
import { ResourceCacheProvider } from '../lib/resource-cache';
import { TAB_TO_PATH } from '../lib/dashboard-tabs';
import * as clubsApi from '../lib/clubs-api';

type RawClub = Awaited<ReturnType<typeof clubsApi.listClubsRaw>>[number];

const currentUser = {
  uid: 'u1',
  email: 'host@test.local',
  displayName: 'Host',
  photoURL: '',
  profileComplete: true,
} as unknown as React.ComponentProps<typeof ClubDashboardView>['currentUser'];

/** Only what the browse card actually reads. */
function rawClub(overrides: Partial<RawClub>): RawClub {
  return {
    id: 'c1',
    name: 'Velvet Rail',
    code: '11111',
    description: 'Tuesday night regulars',
    memberCount: 4,
    adminCount: 1,
    maxCapacity: 50,
    isMember: false,
    isAdmin: false,
    isOwner: false,
    admins: [],
    members: [],
    ...overrides,
  } as RawClub;
}

function renderDashboardAt(initialPath: string) {
  const element = (
    <ClubDashboardView
      currentUser={currentUser}
      playerAvatarUrl=""
      onSelectClub={() => {}}
      onProceedToLobby={() => {}}
      onSignOut={() => {}}
    />
  );
  const router = createMemoryRouter(
    Object.values(TAB_TO_PATH).map((path) => ({ path, element })),
    { initialEntries: [initialPath] }
  );
  render(
    <ResourceCacheProvider>
      <RouterProvider router={router} />
    </ResourceCacheProvider>
  );
  return router;
}

/** Tailwind sizes at or above iOS's 16px zoom threshold. */
const NO_ZOOM = ['text-base', 'text-lg', 'text-xl', 'text-2xl'];
/** text-xs is 12px, text-sm is 14px — iOS zooms both. */
const ZOOMS = ['text-xs', 'text-sm'];

function expectNoZoomSize(el: Element, label: string) {
  const classes = (el as HTMLElement).className.split(/\s+/);
  expect(
    NO_ZOOM.some((s) => classes.includes(s)),
    `${label} is below the 16px threshold: "${(el as HTMLElement).className}"`
  ).toBe(true);
  expect(
    ZOOMS.filter((s) => classes.includes(s)),
    `${label} still carries a zooming size: "${(el as HTMLElement).className}"`
  ).toEqual([]);
}

beforeEach(() => {
  vi.mocked(clubsApi.listClubsRaw).mockResolvedValue([]);
  vi.mocked(clubsApi.listJoinRequests).mockResolvedValue([]);
});

describe('typing on the dashboard does not make iOS zoom the page', () => {
  it('the browse search bar is 16px or larger', async () => {
    renderDashboardAt(TAB_TO_PATH.browse);
    expectNoZoomSize(
      await screen.findByPlaceholderText(/search by club name/i),
      'browse search input'
    );
  });

  it('the create-club name and description are 16px or larger', async () => {
    renderDashboardAt(TAB_TO_PATH.create);
    expectNoZoomSize(
      await screen.findByPlaceholderText(/royal flush syndicate/i),
      'club name input'
    );
    expectNoZoomSize(
      screen.getByPlaceholderText(/private weekend/i),
      'club description textarea'
    );
  });

  it('the Advanced Settings number fields are 16px or larger', async () => {
    // 14px, not 12, before the fix — and 14 still zooms, at 16/14. Being an
    // opt-in accordion does not exempt a field the user has to focus.
    const user = userEvent.setup();
    renderDashboardAt(TAB_TO_PATH.create);

    await user.click(await screen.findByRole('button', { name: /advanced settings/i }));

    const numberFields = [...document.querySelectorAll('input[type="number"]')];
    expect(numberFields.length).toBe(3);
    for (const field of numberFields) {
      expectNoZoomSize(field, 'advanced settings number field');
    }
  });
});

describe('the dashboard controls measured under 44px opt into a real target', () => {
  it('the header sign-out carries the shared 44px target', async () => {
    // 34x34 in production — and it signs the user out, which is exactly the
    // control a mis-tap should not be near. The halo was verified clear of
    // neighbours at 375px: the bell beside it is hidden below md.
    renderDashboardAt(TAB_TO_PATH.myClubs);
    const signOut = await screen.findByTitle('Sign Out');
    expect(signOut.className).toContain('tap-44');
  });

  it('the create-page back button carries the shared 44px target', async () => {
    renderDashboardAt(TAB_TO_PATH.create);
    const back = await screen.findByRole('button', { name: /back to my clubs/i });
    expect(back.className).toContain('tap-44');
  });

  it('every browse-card button clears the 44px floor at full width', async () => {
    // min-h-[44px] rather than tap-44: the tap-44 pseudo-element is a centred
    // 44px square, which on a full-width button would fix the middle and
    // leave the edges at the measured 36px.
    vi.mocked(clubsApi.listClubsRaw).mockResolvedValue([
      rawClub({ id: 'c1', name: 'Velvet Rail', code: '11111', isMember: true }),
      rawClub({ id: 'c2', name: 'The Standing Eight', code: '22222' }),
    ]);
    renderDashboardAt(TAB_TO_PATH.browse);

    const enter = await screen.findByRole('button', { name: /enter club/i });
    const request = screen.getByRole('button', { name: /request to join/i });
    for (const b of [enter, request]) {
      expect(b.className, b.textContent ?? '').toContain('min-h-[44px]');
      expect(b.className, b.textContent ?? '').toContain('w-full');
    }
  });
});
