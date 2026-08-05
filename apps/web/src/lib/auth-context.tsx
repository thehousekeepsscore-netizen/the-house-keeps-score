import React, { createContext, useContext, useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch, setAccessToken } from './api-client';
import { resetSocket } from './socket';
import { AppUser } from './auth-types';

interface ApiUser {
  id: string;
  email: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  avatarUrl: string | null;
  phoneNumber: string | null;
  themePreference: string;
  isSuperAdmin: boolean;
  profileComplete: boolean;
}

function toAppUser(u: ApiUser): AppUser {
  return {
    uid: u.id,
    email: u.email,
    displayName: u.displayName,
    firstName: u.firstName,
    lastName: u.lastName,
    username: u.username,
    phoneNumber: u.phoneNumber,
    photoURL: u.avatarUrl,
    themePreference: u.themePreference,
    isSuperAdmin: u.isSuperAdmin,
    profileComplete: u.profileComplete,
  };
}

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface ProfileUpdateInput {
  displayName?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  avatarUrl?: string;
  phoneNumber?: string;
  themePreference?: string;
}

/**
 * Startup phases. `status` below is derived from these and keeps the older
 * three-value contract that consumers already use.
 *
 *   initialising ─┬─ oauth-exchange ─┬─ authenticated
 *                 │                  └─ (failure) ─┐
 *                 └──────────────────── refreshing ─┴─ authenticated
 *                                                    └─ unauthenticated
 *
 * Exactly one path reaches the terminal state. Nothing outside this provider
 * writes authentication state during startup.
 */
export type AuthPhase = 'initialising' | 'oauth-exchange' | 'refreshing' | 'authenticated' | 'unauthenticated';

/** Non-fatal startup failures worth telling the user about. */
export type AuthError = 'oauth_exchange_failed';

interface AuthContextValue {
  user: AppUser | null;
  status: AuthStatus;
  phase: AuthPhase;
  authError: AuthError | null;
  clearAuthError: () => void;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  loginWithGoogle: () => void;
  updateProfile: (input: ProfileUpdateInput) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Where to send the user once a Google sign-in completes.
 *
 * The OAuth round trip leaves the document entirely, so the intended path
 * cannot be held in memory or in history — it has to survive a full navigation
 * away and back. sessionStorage is the narrowest thing that does: same-origin,
 * per-tab, and gone when the tab closes.
 *
 * This is a path, not data. The rule against persisting cached server state
 * (money can go stale) does not apply, and nothing here is a credential.
 */
const RETURN_TO_KEY = 'auth:returnTo';

/**
 * Only ever redirect to a path on this origin. Without this check a crafted
 * value in sessionStorage could turn the login flow into an open redirect.
 */
function safeInternalPath(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  if (raw.startsWith('/oauth/callback') || raw.startsWith('/login')) return null;
  return raw;
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AppUser | null>(null);
  const [phase, setPhase] = useState<AuthPhase>('initialising');
  const [authError, setAuthError] = useState<AuthError | null>(null);

  const status: AuthStatus =
    phase === 'authenticated' ? 'authenticated' : phase === 'unauthenticated' ? 'unauthenticated' : 'loading';

  /**
   * Startup transitions are monotonic: once a session exists, nothing may
   * downgrade it to signed-out. Only an explicit logout resets this.
   *
   * This is belt-and-braces given the sequential bootstrap below, but it is the
   * invariant that was actually violated in production: the old code ran the
   * refresh bootstrap and the OAuth exchange as two independent effects, and
   * whenever the exchange resolved first, the refresh's 401 handler erased the
   * session that had just been established — a real login, silently discarded.
   */
  const hasSession = useRef(false);

  const markAuthenticated = useCallback((u: ApiUser) => {
    hasSession.current = true;
    setUser(toAppUser(u));
    setPhase('authenticated');
  }, []);

  const markSignedOut = useCallback((force = false) => {
    if (hasSession.current && !force) return;
    hasSession.current = false;
    setAccessToken(null);
    setUser(null);
    setPhase('unauthenticated');
  }, []);

  const loadMe = useCallback(async () => {
    const me = await apiFetch<ApiUser>('/auth/me');
    markAuthenticated(me);
  }, [markAuthenticated]);

  /**
   * The single authoritative startup path. Consumers read authentication state;
   * they never establish it.
   */
  const navigate = useNavigate();

  const startupRan = useRef(false);
  useEffect(() => {
    // React StrictMode double-invokes effects in development. Without this the
    // one-time OAuth code would be consumed twice and the second attempt would
    // fail, which looks exactly like the bug being fixed here.
    if (startupRan.current) return;
    startupRan.current = true;

    void (async () => {
      const isCallback = window.location.pathname === '/oauth/callback';
      const code = isCallback ? new URLSearchParams(window.location.search).get('code') : null;

      // Where the user was heading before being sent to Google. Read and
      // cleared here so a stale value can never leak into a later sign-in.
      const returnTo = safeInternalPath(sessionStorage.getItem(RETURN_TO_KEY));
      sessionStorage.removeItem(RETURN_TO_KEY);

      // Replace, never push: the callback URL must not linger in history, and
      // a reload mid-flight must not be able to replay a spent code. navigate()
      // rather than history.replaceState so React Router stays in sync.
      if (isCallback) navigate(returnTo ?? '/', { replace: true });

      if (code) {
        setPhase('oauth-exchange');
        try {
          const result = await apiFetch<{ accessToken: string; user: ApiUser }>('/auth/oauth/exchange', {
            method: 'POST',
            body: { code },
          });
          setAccessToken(result.accessToken);
          markAuthenticated(result.user);
          return; // Authoritative. Never fall through to refresh on success.
        } catch {
          // A spent or expired code. Fall through: the user may still hold a
          // valid refresh cookie from an earlier session.
          setAuthError('oauth_exchange_failed');
        }
      }

      setPhase('refreshing');
      try {
        const result = await apiFetch<{ accessToken: string }>('/auth/refresh', { method: 'POST', skipAuthRetry: true });
        setAccessToken(result.accessToken);
        await loadMe();
      } catch {
        markSignedOut();
      }
    })();
  }, [loadMe, markAuthenticated, markSignedOut, navigate]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await apiFetch<{ accessToken: string; user: ApiUser }>('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    setAccessToken(result.accessToken);
    markAuthenticated(result.user);
  }, [markAuthenticated]);

  const register = useCallback(async (email: string, password: string) => {
    const result = await apiFetch<{ accessToken: string; user: ApiUser }>('/auth/register', {
      method: 'POST',
      body: { email, password },
    });
    setAccessToken(result.accessToken);
    markAuthenticated(result.user);
  }, [markAuthenticated]);

  const logout = useCallback(async () => {
    await apiFetch('/auth/logout', { method: 'POST' });
    // force: an explicit sign-out is the one transition allowed to clear a
    // live session, so it bypasses the monotonic startup guard.
    markSignedOut(true);
  }, [markSignedOut]);

  const loginWithGoogle = useCallback(() => {
    // Remember the destination across the redirect chain, so a deep link that
    // bounced someone to sign-in returns them to it rather than the dashboard.
    const here = window.location.pathname + window.location.search;
    const target = safeInternalPath(here);
    if (target && target !== '/') sessionStorage.setItem(RETURN_TO_KEY, target);

    // `replace`, not `href`: assigning href pushes a history entry, leaving the
    // login page in the stack underneath the OAuth flow. Every redirect after
    // this one (Railway -> Google -> Railway -> WEB_ORIGIN) replaces rather
    // than pushes, so the whole round trip collapses into this single entry —
    // and App.tsx rewrites its URL to '/' once the code is exchanged.
    //
    // With `href` the browser Back button returned to the login page as a
    // fresh document load, which boots with no in-memory access token and so
    // renders the signed-out screen to a user who is signed in.
    window.location.replace('/api/auth/google');
  }, []);


  const clearAuthError = useCallback(() => setAuthError(null), []);

  const updateProfile = useCallback(async (input: ProfileUpdateInput) => {
    const result = await apiFetch<ApiUser>('/auth/me', { method: 'PATCH', body: input });
    setUser(toAppUser(result));
  }, []);

  // Drop the shared socket whenever the authenticated identity changes.
  //
  // Mirrors the cache's identity guard deliberately: both exist because signing
  // out here does not reload the page, so anything holding server state across
  // the transition carries it to the next person. The socket is the worse of
  // the two, because its rooms are server-side and keyed to a connection the
  // new user never opened.
  const lastSocketUserId = useRef<string | null>(null);
  useEffect(() => {
    const id = user?.uid ?? null;
    if (lastSocketUserId.current !== null && lastSocketUserId.current !== id) resetSocket();
    lastSocketUserId.current = id;
  }, [user?.uid]);

  // Memoised so the context value keeps a stable identity. Every consumer of
  // useAuth() re-rendered on any AuthProvider render, because the value was a
  // fresh object literal each time -- identity churn rather than a real change.
  // Same reasoning as ResourceCacheProvider's value memo.
  const value = useMemo(
    () => ({ user, status, phase, authError, clearAuthError, login, register, logout, loginWithGoogle, updateProfile }),
    [user, status, phase, authError, clearAuthError, login, register, logout, loginWithGoogle, updateProfile]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
