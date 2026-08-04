import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { apiFetch, setAccessToken } from './api-client';
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
      // Clean the URL before any await, so the callback never lingers in
      // history and a reload mid-flight cannot replay a spent code.
      if (isCallback) window.history.replaceState({}, '', '/');

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
  }, [loadMe, markAuthenticated, markSignedOut]);

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

  return (
    <AuthContext.Provider value={{ user, status, phase, authError, clearAuthError, login, register, logout, loginWithGoogle, updateProfile }}>
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
