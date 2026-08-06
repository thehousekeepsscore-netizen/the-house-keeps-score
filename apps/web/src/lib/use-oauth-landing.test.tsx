import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom';
import { useOAuthLanding } from './use-oauth-landing';

/**
 * The Back-after-sign-in case.
 *
 * Google's own pages are cross-origin, so entries the user creates by
 * interacting with them cannot be removed from history by any means. What the
 * app controls is what happens when Back lands on one: the authorize URL
 * re-runs, its single-use `state` is already spent, and the API bounces here
 * with ?error=oauth_state — for a user whose session is perfectly valid.
 *
 * Telling that user their sign-in expired is false, and in an app about money
 * between friends a spurious failure message is worse than silence.
 */

type Status = 'loading' | 'authenticated' | 'unauthenticated';

const Probe: React.FC<{ status: Status; report: (e: string) => void }> = ({ status, report }) => {
  useOAuthLanding(status, report);
  const location = useLocation();
  return <span data-testid="path">{location.pathname + location.search}</span>;
};

function renderAt(url: string, status: Status, report: (e: string) => void) {
  // The hook reads window.location directly, because the failure arrives as a
  // full document load from the API rather than as a client-side navigation.
  window.history.replaceState({}, '', url);

  const router = createMemoryRouter(
    [
      { path: '/', element: <Probe status={status} report={report} /> },
      { path: '/login', element: <Probe status={status} report={report} /> },
    ],
    { initialEntries: [url] }
  );
  render(<RouterProvider router={router} />);
  return { router };
}

describe('useOAuthLanding', () => {
  beforeEach(() => window.history.replaceState({}, '', '/'));
  afterEach(() => window.history.replaceState({}, '', '/'));

  it('reports a genuine failure once the user is confirmed signed out', async () => {
    const report = vi.fn();
    const { router } = renderAt('/login?error=oauth_failed', 'unauthenticated', report);

    await waitFor(() => expect(report).toHaveBeenCalledWith('oauth_failed'));
    // The reason has done its job and must not survive in the address bar.
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(router.state.location.search).toBe('');
  });

  it('stays silent for a user who turns out to be signed in', async () => {
    // Back onto a spent authorize URL. Nothing actually went wrong.
    const report = vi.fn();
    renderAt('/login?error=oauth_state', 'authenticated', report);

    await new Promise((r) => setTimeout(r, 50));
    expect(report).not.toHaveBeenCalled();
  });

  it('waits for auth to settle before deciding', async () => {
    const report = vi.fn();
    renderAt('/login?error=oauth_state', 'loading', report);

    // While the refresh bootstrap is still running, the outcome is unknown and
    // reporting would be a guess.
    await new Promise((r) => setTimeout(r, 50));
    expect(report).not.toHaveBeenCalled();
  });

  it('clears the error from the URL through the router, not around it', async () => {
    const report = vi.fn();
    const { router } = renderAt('/login?error=oauth_state', 'authenticated', report);

    // replaceState alone moves the address bar without telling React Router,
    // leaving the router's own location disagreeing with the URL.
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('does nothing at all on a normal landing', async () => {
    const report = vi.fn();
    const { router } = renderAt('/', 'unauthenticated', report);

    await new Promise((r) => setTimeout(r, 50));
    expect(report).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/');
  });
});
