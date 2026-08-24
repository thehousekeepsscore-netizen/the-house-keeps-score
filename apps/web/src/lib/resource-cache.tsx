import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useAuth } from './auth-context';
import { bump, recordTiming } from './cache-metrics';

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
  /**
   * Bumped on every write. Exists so a rollback can tell whether anything else
   * touched this entry while a request was in flight — see `restore`.
   */
  version: number;
  /**
   * Highest request sequence handed out for this key. Only `load` advances it,
   * and only when it actually issues a request — a deduplicated caller joins an
   * existing request and does not take a number.
   */
  issuedSeq: number;
  /**
   * Highest request sequence that has already settled into this entry.
   *
   * Forced fetches skip the in-flight check, so two requests for one key can be
   * open at once, and nothing makes them come back in the order they went out.
   * Without this the *last to arrive* won: an older response would overwrite a
   * newer one and stamp `fetchedAt` with its own arrival time, so the stale data
   * was recorded as the freshest the cache had and nothing revalidated it. That
   * is the "stale until you pull to refresh" report.
   *
   * The comparison is deliberately against what has *settled*, not against
   * what is currently in flight. Testing `inFlight` identity instead would also
   * order the responses, but it would drop a response the moment a newer
   * request was issued — and under a poll whose responses take longer than the
   * interval, every tick is superseded before it lands, so the entry would stop
   * updating entirely. ClubDashboardView polls two keys every 15s, which is
   * exactly that shape on a slow connection.
   */
  settledSeq: number;
}

const EMPTY: Entry = {
  data: undefined,
  fetchedAt: 0,
  inFlight: null,
  error: null,
  version: 0,
  issuedSeq: 0,
  settledSeq: 0,
};

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
  /** Captures data plus a version, for a rollback that can detect interference. */
  snapshot: <T>(key: string) => Snapshot<T>;
  /**
   * Undoes one optimistic write.
   *
   * Only restores if this entry has not been written again since the snapshot.
   * If it has, the entry is invalidated rather than overwritten — see the
   * implementation for why resurrecting a stale snapshot is the worse failure.
   */
  restore: <T>(key: string, snap: Snapshot<T>) => void;
  clear: () => void;
}

export interface Snapshot<T> {
  data: T | undefined;
  version: number;
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
      if (current.inFlight && !force) {
        bump('dedupedRequests');
        return current.inFlight;
      }

      bump('networkRequests');
      const startedAt = performance.now();
      const seq = current.issuedSeq + 1;

      /**
       * Has a newer request already settled into this entry?
       *
       * Only a *newer settled response* disqualifies this one. A newer request
       * merely being open does not — see `settledSeq` for why that distinction
       * is what keeps a slow poll alive.
       */
      const superseded = (prev: Entry) => seq <= prev.settledSeq;

      /**
       * Clearing `inFlight` is only ours to do if we are still the request it
       * points at. When an older response settles first, the newer request is
       * still running, and blanking its promise here would both report
       * `isRevalidating: false` while it is in flight and cost the next
       * unforced caller a deduplication.
       */
      const releaseInFlight = (prev: Entry) => (prev.inFlight === promise ? null : prev.inFlight);

      const promise: Promise<unknown> = fetcher()
        .then((data) => {
          recordTiming(key, performance.now() - startedAt);
          const prev = store.current.get(key) ?? EMPTY;
          if (superseded(prev)) {
            // Dropped, and deliberately without touching the entry: not
            // `version` (a pending rollback reads it to detect interference),
            // not `fetchedAt`, not `data`. Callers still get the value they
            // asked for; it just does not become the cache's truth.
            bump('supersededResponses');
            return data;
          }
          store.current.set(key, {
            ...prev,
            data,
            fetchedAt: Date.now(),
            inFlight: releaseInFlight(prev),
            error: null,
            version: prev.version + 1,
            settledSeq: seq,
          });
          if (prev.data !== data || prev.inFlight) notify(key);
          return data;
        })
        .catch((error) => {
          // Keep whatever data we already had — a failed refresh must not blank
          // a screen. fetchedAt stays put so the next attempt still sees it as
          // stale and retries.
          recordTiming(key, performance.now() - startedAt);
          bump('failedRequests');
          const prev = store.current.get(key) ?? EMPTY;
          if (superseded(prev)) {
            // A failure that has already been overtaken must not post its error
            // over a newer success, for the same reason a stale success must not
            // post its data.
            bump('supersededResponses');
            throw error;
          }
          store.current.set(key, {
            ...prev,
            inFlight: releaseInFlight(prev),
            error,
            settledSeq: seq,
          });
          notify(key);
          throw error;
        });

      store.current.set(key, { ...current, inFlight: promise, issuedSeq: seq });
      return promise;
    },
    [getEntry, notify]
  );

  const invalidate = useCallback(
    (key: string) => {
      const prev = store.current.get(key);
      if (!prev) return;
      bump('invalidations');
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
      bump('writeThroughs');
      const prev = store.current.get(key) ?? EMPTY;
      store.current.set(key, {
        ...prev,
        data: updater(prev.data as T | undefined),
        version: prev.version + 1,
      });
      notify(key);
    },
    [notify]
  );

  const snapshot = useCallback(
    <T,>(key: string): Snapshot<T> => {
      const entry = store.current.get(key) ?? EMPTY;
      return { data: entry.data as T | undefined, version: entry.version };
    },
    []
  );

  const restore = useCallback(
    <T,>(key: string, snap: Snapshot<T>) => {
      const current = store.current.get(key) ?? EMPTY;

      // Nothing else wrote while the request was in flight, so the snapshot is
      // still an accurate description of "before" and can simply go back.
      if (current.version === snap.version + 1) {
        store.current.set(key, { ...current, data: snap.data, version: current.version + 1 });
        notify(key);
        return;
      }

      // Something did write — a socket event, another optimistic action, a
      // revalidation landing. Restoring the snapshot would silently throw that
      // away, which is worse than the failure being rolled back: it would
      // resurrect state the server has already moved past. Mark stale instead
      // and let the next read fetch the truth.
      bump('invalidations');
      store.current.set(key, { ...current, fetchedAt: 0 });
      notify(key);
    },
    [notify]
  );

  const clear = useCallback(() => {
    bump('clears');
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

  // Memoised so the context value keeps a stable identity. Every member is
  // already useCallback-stable, so this object never needs to change. Rebuilding
  // it each render would change the identity of `cache` in every consumer, which
  // would re-run useResource's subscribe and load effects — and resubscribe
  // useSyncExternalStore — on any unrelated re-render of this provider.
  const value = useMemo<ResourceCache>(
    () => ({ getEntry, subscribe, load, invalidate, invalidatePrefix, update, snapshot, restore, clear }),
    [getEntry, subscribe, load, invalidate, invalidatePrefix, update, snapshot, restore, clear]
  );

  return <ResourceCacheContext.Provider value={value}>{children}</ResourceCacheContext.Provider>;
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
    if (current.data === undefined) {
      // Nothing cached: the caller will show a skeleton. The only true miss.
      bump('misses');
      void load(false);
    } else {
      // Data was on screen immediately. Stale data still counts as a hit — the
      // user saw content without waiting; the refetch happens behind it.
      bump('hits');
      if (isStale) {
        bump('revalidations');
        void load(false);
      }
    }
  }, [cache, key, staleTime, load]);

  useEffect(() => {
    if (!key || !pollMs) return;
    const id = setInterval(() => void load(true), pollMs);
    return () => clearInterval(id);
  }, [key, pollMs, load]);

  const refresh = useCallback(() => {
    bump('refreshes');
    return load(true);
  }, [load]);

  return {
    data: entry.data as T | undefined,
    status: entry.data === undefined ? 'empty' : 'ready',
    isRevalidating: entry.inFlight !== null,
    error: entry.error,
    refresh,
  };
}
