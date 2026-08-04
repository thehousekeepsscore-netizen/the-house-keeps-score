import React, { createContext, useCallback, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { useAuth } from './auth-context';

/**
 * The application's shared server-state layer.
 *
 * Every screen used to own its own copy of the data it displayed, fetched in a
 * useEffect on mount. Because screens are destroyed on navigation (App.tsx
 * switches on a viewState union rather than routing), going back to a screen
 * threw away everything it knew and started from an empty array — which is why
 * returning to the dashboard flashed "you have no clubs" before the real list
 * arrived.
 *
 * This layer lives above the view switch, so cached data outlives navigation.
 *
 * Two rules shape the design:
 *
 *   Rendering is never blocked on freshness. If a resource has data — however
 *   old — it renders immediately and revalidates in the background. Only a
 *   resource that has *never* loaded reports 'empty', and only then should a
 *   caller show a skeleton.
 *
 *   Memory only, never persisted. This app displays money. A pot balance or
 *   leaderboard restored from sessionStorage after a browser restart would be
 *   shown as fact while being arbitrarily out of date. A skeleton on cold start
 *   is the cheaper mistake.
 */

interface Entry<T = unknown> {
  /** undefined means "never successfully loaded" — the only skeleton trigger. */
  data: T | undefined;
  /** 0 means stale/never-fetched; drives revalidation, never rendering. */
  fetchedAt: number;
  /** Shared so N components mounting at once produce one request, not N. */
  inFlight: Promise<unknown> | null;
  error: unknown;
}

const EMPTY: Entry = { data: undefined, fetchedAt: 0, inFlight: null, error: null };

interface ResourceCache {
  getEntry: (key: string) => Entry;
  subscribe: (key: string, listener: () => void) => () => void;
  load: (key: string, fetcher: () => Promise<unknown>, force: boolean) => Promise<unknown>;
  /** Marks stale so the next read revalidates. Keeps the data on screen. */
  invalidate: (key: string) => void;
  /** Marks every key starting with `prefix` stale — e.g. invalidatePrefix(`club:${id}`). */
  invalidatePrefix: (prefix: string) => void;
  /** Optimistic write. Updates subscribers immediately; revalidation still happens. */
  update: <T>(key: string, updater: (current: T | undefined) => T) => void;
  clear: () => void;
}

const ResourceCacheContext = createContext<ResourceCache | null>(null);

export const ResourceCacheProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const store = useRef(new Map<string, Entry>());
  const listeners = useRef(new Map<string, Set<() => void>>());
  const { user } = useAuth();

  const notify = useCallback((key: string) => {
    listeners.current.get(key)?.forEach((fn) => fn());
  }, []);

  const getEntry = useCallback((key: string) => store.current.get(key) ?? EMPTY, []);

  const subscribe = useCallback((key: string, listener: () => void) => {
    let set = listeners.current.get(key);
    if (!set) {
      set = new Set();
      listeners.current.set(key, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) listeners.current.delete(key);
    };
  }, []);

  const load = useCallback(
    (key: string, fetcher: () => Promise<unknown>, force: boolean) => {
      const current = getEntry(key);
      // Deduplication: a request already in flight is shared rather than duplicated.
      if (current.inFlight && !force) return current.inFlight;

      const promise = fetcher()
        .then((data) => {
          const prev = store.current.get(key) ?? EMPTY;
          store.current.set(key, { data, fetchedAt: Date.now(), inFlight: null, error: null });
          if (prev.data !== data || prev.inFlight) notify(key);
          return data;
        })
        .catch((error) => {
          // Keep whatever data we already had — a failed refresh must not blank
          // a screen. fetchedAt stays put so the next attempt still sees it as
          // stale and retries.
          const prev = store.current.get(key) ?? EMPTY;
          store.current.set(key, { ...prev, inFlight: null, error });
          notify(key);
          throw error;
        });

      store.current.set(key, { ...current, inFlight: promise });
      return promise;
    },
    [getEntry, notify]
  );

  const invalidate = useCallback(
    (key: string) => {
      const prev = store.current.get(key);
      if (!prev) return;
      store.current.set(key, { ...prev, fetchedAt: 0 });
      notify(key);
    },
    [notify]
  );

  const invalidatePrefix = useCallback(
    (prefix: string) => {
      for (const key of store.current.keys()) {
        if (key === prefix || key.startsWith(`${prefix}:`)) invalidate(key);
      }
    },
    [invalidate]
  );

  const update = useCallback(
    <T,>(key: string, updater: (current: T | undefined) => T) => {
      const prev = store.current.get(key) ?? EMPTY;
      store.current.set(key, { ...prev, data: updater(prev.data as T | undefined) });
      notify(key);
    },
    [notify]
  );

  const clear = useCallback(() => {
    const keys = [...store.current.keys()];
    store.current.clear();
    keys.forEach(notify);
  }, [notify]);

  // Wipe on any change of authenticated identity, not just sign-out. Two people
  // signing in on the same browser must never see each other's clubs, and this
  // cache has no per-user scoping of its own.
  const lastUserId = useRef<string | null>(null);
  useEffect(() => {
    const id = user?.uid ?? null;
    if (lastUserId.current !== null && lastUserId.current !== id) clear();
    lastUserId.current = id;
  }, [user?.uid, clear]);

  const value = useRef<ResourceCache>({
    getEntry,
    subscribe,
    load,
    invalidate,
    invalidatePrefix,
    update,
    clear,
  });
  value.current = { getEntry, subscribe, load, invalidate, invalidatePrefix, update, clear };

  return <ResourceCacheContext.Provider value={value.current}>{children}</ResourceCacheContext.Provider>;
};

export function useResourceCache(): ResourceCache {
  const ctx = useContext(ResourceCacheContext);
  if (!ctx) throw new Error('useResourceCache must be used within a ResourceCacheProvider');
  return ctx;
}

export interface UseResourceResult<T> {
  data: T | undefined;
  /** 'empty' only when never loaded — the sole condition for showing a skeleton. */
  status: 'empty' | 'ready';
  /** True while a background refresh runs. Never a reason to hide content. */
  isRevalidating: boolean;
  error: unknown;
  refresh: () => Promise<void>;
}

/**
 * Reads a cached resource, rendering whatever is already known immediately and
 * revalidating in the background.
 *
 * @param key      Stable cache key. Pass null to skip (e.g. no club selected).
 * @param fetcher  Called only when a fetch is actually needed.
 * @param staleTime How long data is considered fresh. Within it, remounting a
 *                  screen costs no request at all — this is what makes Back
 *                  instant rather than merely skeleton-free.
 * @param pollMs   Optional background refresh, replacing per-screen setInterval.
 */
export function useResource<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  { staleTime = 30_000, pollMs }: { staleTime?: number; pollMs?: number } = {}
): UseResourceResult<T> {
  const cache = useResourceCache();

  // Kept in a ref so a caller passing an inline arrow function doesn't retrigger
  // fetches on every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const subscribe = useCallback(
    (listener: () => void) => (key ? cache.subscribe(key, listener) : () => {}),
    [cache, key]
  );
  const getSnapshot = useCallback(() => (key ? cache.getEntry(key) : EMPTY), [cache, key]);
  const entry = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const load = useCallback(
    (force: boolean) => {
      if (!key) return Promise.resolve();
      return cache.load(key, () => fetcherRef.current(), force).then(
        () => undefined,
        () => undefined
      );
    },
    [cache, key]
  );

  useEffect(() => {
    if (!key) return;
    const current = cache.getEntry(key);
    const isStale = Date.now() - current.fetchedAt > staleTime;
    if (current.data === undefined || isStale) void load(false);
  }, [cache, key, staleTime, load]);

  useEffect(() => {
    if (!key || !pollMs) return;
    const id = setInterval(() => void load(true), pollMs);
    return () => clearInterval(id);
  }, [key, pollMs, load]);

  const refresh = useCallback(() => load(true), [load]);

  return {
    data: entry.data as T | undefined,
    status: entry.data === undefined ? 'empty' : 'ready',
    isRevalidating: entry.inFlight !== null,
    error: entry.error,
    refresh,
  };
}
