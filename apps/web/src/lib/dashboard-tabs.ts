/**
 * The dashboard's tabs and their addresses.
 *
 * Its own module, rather than living beside the view, because App.tsx declares
 * the routes from this map while `ClubDashboardView` is lazy-loaded. Importing
 * the map from the view would pull the whole view into the initial bundle and
 * defeat the code split — this file is a few bytes and costs nothing.
 *
 * One source of truth in both directions: a tab cannot exist without a route,
 * and a route cannot exist without a tab.
 */

export type DashboardTab = 'myClubs' | 'browse' | 'create' | 'requests' | 'superuser';

/**
 * "My clubs" is the bare dashboard rather than /my-clubs: it is the default and
 * already has a URL. A second address rendering the same screen would make Back
 * walk between two identical views for no visible reason.
 */
export const TAB_TO_PATH: Record<DashboardTab, string> = {
  myClubs: '/',
  browse: '/browse',
  create: '/create',
  requests: '/requests',
  superuser: '/superuser',
};

/**
 * Unknown paths fall back to the default tab rather than rendering nothing — a
 * stale bookmark should open the dashboard, not a blank screen.
 */
export const PATH_TO_TAB: Record<string, DashboardTab> = Object.fromEntries(
  Object.entries(TAB_TO_PATH).map(([tab, path]) => [path, tab as DashboardTab])
);
