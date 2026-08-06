import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

/** Mirrors auth-context's own status union, which it keeps private. */
type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

/**
 * Handles landing back on the app from a failed Google sign-in.
 *
 * The API sends failures to /login?error=..., which is not a route — it exists
 * only to carry the reason. This clears it from the address bar and reports it,
 * but only to someone who is actually signed out.
 *
 * Why the delay matters. Pressing Back after a *successful* sign-in can land on
 * Google's authorize URL, which re-runs and redirects here — but the OAuth
 * `state` is single-use (oauth.google.ts:45), so it arrives as
 * ?error=oauth_state. The user is signed in the whole time: their refresh
 * cookie is still valid and the bootstrap restores the session a moment later.
 * Reporting immediately therefore tells a signed-in user that their sign-in
 * expired, which is both false and alarming in an app about money.
 *
 * So the reason is held until auth settles, and discarded if it settles as
 * authenticated. A real failure still reports, one tick later than before.
 *
 * navigate() rather than history.replaceState, for the same reason
 * auth-context uses it: replaceState moves the address bar without telling
 * React Router, leaving the router's own location disagreeing with the URL.
 */
export function useOAuthLanding(authStatus: AuthStatus, report: (error: string) => void) {
  const navigate = useNavigate();
  const [pendingError, setPendingError] = useState<string | null>(null);

  // The landing is consumed once per document. Without this, StrictMode's
  // double-invoked effects read the query string twice — and the second read
  // happens after the URL has already been cleared, so it silently disagrees
  // with the first.
  const consumed = useRef(false);

  useEffect(() => {
    if (consumed.current) return;
    const { pathname, search } = window.location;
    if (pathname !== '/login') return;
    consumed.current = true;

    const error = new URLSearchParams(search).get('error');
    navigate('/', { replace: true });
    if (error) setPendingError(error);
  }, [navigate]);

  useEffect(() => {
    if (!pendingError) return;
    // Still resolving — the refresh bootstrap may yet produce a session.
    if (authStatus === 'loading') return;

    // Signed in after all: this was Back landing on a spent authorize URL, not
    // a failure. Drop it silently — nothing went wrong from here.
    if (authStatus === 'authenticated') {
      setPendingError(null);
      return;
    }

    report(pendingError);
    setPendingError(null);
  }, [pendingError, authStatus, report]);
}
