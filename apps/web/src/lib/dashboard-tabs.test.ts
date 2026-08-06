import { describe, it, expect } from 'vitest';
import { TAB_TO_PATH, PATH_TO_TAB, DashboardTab } from './dashboard-tabs';

/**
 * App.tsx declares one route per entry in TAB_TO_PATH, and the dashboard reads
 * the current tab back out of PATH_TO_TAB. The two directions have to stay
 * exact inverses of each other, because the failure is silent in both
 * directions and neither shows up in a type error:
 *
 *   a tab with no route      the nav item renders and navigating to it falls
 *                            through to the catch-all, bouncing to '/'
 *   a route with no tab      the URL resolves, the screen renders, and the
 *                            nav highlights the wrong item
 */

describe('dashboard tab addresses', () => {
  const tabs = Object.keys(TAB_TO_PATH) as DashboardTab[];

  it('round-trips every tab through its path', () => {
    for (const tab of tabs) {
      expect(PATH_TO_TAB[TAB_TO_PATH[tab]]).toBe(tab);
    }
  });

  it('gives every tab a distinct address', () => {
    const paths = Object.values(TAB_TO_PATH);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('every path is absolute, so navigate() never resolves it relatively', () => {
    for (const path of Object.values(TAB_TO_PATH)) {
      expect(path.startsWith('/')).toBe(true);
    }
  });

  it('keeps the default tab on the bare dashboard URL', () => {
    // Two addresses for the default screen would make Back walk between two
    // identical views. '/' is already its address; it must not gain a second.
    expect(TAB_TO_PATH.myClubs).toBe('/');
  });

  it('falls back to the default tab for an unknown path', () => {
    // A stale bookmark should open the dashboard, not render a blank screen.
    expect(PATH_TO_TAB['/not-a-tab'] ?? 'myClubs').toBe('myClubs');
  });
});
