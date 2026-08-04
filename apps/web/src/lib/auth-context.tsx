import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
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

interface AuthContextValue {
  user: AppUser | null;
  status: AuthStatus;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  loginWithGoogle: () => void;
  exchangeOAuthCode: (code: string) => Promise<void>;
  updateProfile: (input: ProfileUpdateInput) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AppUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  const loadMe = useCallback(async () => {
    const me = await apiFetch<ApiUser>('/auth/me');
    setUser(toAppUser(me));
    setStatus('authenticated');
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const result = await apiFetch<{ accessToken: string }>('/auth/refresh', { method: 'POST', skipAuthRetry: true });
        setAccessToken(result.accessToken);
        await loadMe();
      } catch {
        setAccessToken(null);
        setUser(null);
        setStatus('unauthenticated');
      }
    })();
  }, [loadMe]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await apiFetch<{ accessToken: string; user: ApiUser }>('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    setAccessToken(result.accessToken);
    setUser(toAppUser(result.user));
    setStatus('authenticated');
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    const result = await apiFetch<{ accessToken: string; user: ApiUser }>('/auth/register', {
      method: 'POST',
      body: { email, password },
    });
    setAccessToken(result.accessToken);
    setUser(toAppUser(result.user));
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    await apiFetch('/auth/logout', { method: 'POST' });
    setAccessToken(null);
    setUser(null);
    setStatus('unauthenticated');
  }, []);

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

  const exchangeOAuthCode = useCallback(async (code: string) => {
    const result = await apiFetch<{ accessToken: string; user: ApiUser }>('/auth/oauth/exchange', {
      method: 'POST',
      body: { code },
    });
    setAccessToken(result.accessToken);
    setUser(toAppUser(result.user));
    setStatus('authenticated');
  }, []);

  const updateProfile = useCallback(async (input: ProfileUpdateInput) => {
    const result = await apiFetch<ApiUser>('/auth/me', { method: 'PATCH', body: input });
    setUser(toAppUser(result));
  }, []);

  return (
    <AuthContext.Provider value={{ user, status, login, register, logout, loginWithGoogle, exchangeOAuthCode, updateProfile }}>
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
