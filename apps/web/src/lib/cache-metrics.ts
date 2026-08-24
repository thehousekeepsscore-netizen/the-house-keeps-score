/**
 * Counters for the shared server-state layer.
 *
 * Every performance claim in this project has had to be measured rather than
 * asserted, and cache behaviour was the one thing that could not be: the only
 * evidence available was counting rows in a DevTools network panel, which twice
 * sent us chasing the wrong problem — poll ticks read as remount refetches, and
 * a request count read as elapsed time when two of the calls were parallel.
 *
 * These counters live outside React so nothing here can trigger a render, and
 * so the numbers survive navigation. Reading them is a snapshot; there is no
 * subscription, because a metrics panel that re-renders on every cache event
 * would distort what it is measuring.
 */

export interface CacheMetrics {
  /** A read that found usable data already in the cache. */
  hits: number;
  /** A read with nothing cached — the only case that shows a skeleton. */
  misses: number;
  /** Background revalidation of data that was present but past staleTime. */
  revalidations: number;
  /** Explicit refresh() calls, e.g. a socket event or a post-mutation refetch. */
  refreshes: number;
  /** cache.update() write-throughs — a mutation result applied without a GET. */
  writeThroughs: number;
  /** invalidate() / invalidatePrefix() calls. */
  invalidations: number;
  /** Concurrent callers that joined an in-flight request instead of issuing one. */
  dedupedRequests: number;
  /** Fetches that actually reached the network. */
  networkRequests: number;
  /** Fetches that rejected. */
  failedRequests: number;
  /**
   * Responses that arrived but were not allowed to become the cache's truth,
   * for either reason: a newer response had already written, or the request
   * belonged to a previous authenticated identity and the cache has since been
   * cleared.
   *
   * One counter rather than two because the operational question is the same —
   * how much of what came back was thrown away. `clears` sitting beside it in
   * the panel distinguishes the causes: a jump in both means an identity change,
   * a jump in this alone means requests for one key are being issued faster than
   * they come back. Expected to be small but non-zero.
   */
  supersededResponses: number;
  /** Whole-cache wipes, i.e. a change of authenticated identity. */
  clears: number;
}

const counters: CacheMetrics = {
  hits: 0,
  misses: 0,
  revalidations: 0,
  refreshes: 0,
  writeThroughs: 0,
  invalidations: 0,
  dedupedRequests: 0,
  networkRequests: 0,
  failedRequests: 0,
  supersededResponses: 0,
  clears: 0,
};

export function bump(metric: keyof CacheMetrics, by = 1): void {
  counters[metric] += by;
}

/** Per-key request timings, so slow resources can be named rather than guessed at. */
const timings = new Map<string, { count: number; totalMs: number; lastMs: number }>();

export function recordTiming(key: string, ms: number): void {
  const t = timings.get(key) ?? { count: 0, totalMs: 0, lastMs: 0 };
  t.count += 1;
  t.totalMs += ms;
  t.lastMs = ms;
  timings.set(key, t);
}

export interface CacheSnapshot extends CacheMetrics {
  /** hits / (hits + misses), as a percentage. Null before any read. */
  hitRatePercent: number | null;
  /** Requests that never happened because a caller joined one in flight. */
  requestsSaved: number;
  slowest: { key: string; avgMs: number; lastMs: number; count: number }[];
}

export function snapshot(): CacheSnapshot {
  const reads = counters.hits + counters.misses;
  return {
    ...counters,
    hitRatePercent: reads === 0 ? null : Math.round((counters.hits / reads) * 100),
    requestsSaved: counters.dedupedRequests,
    slowest: [...timings.entries()]
      .map(([key, t]) => ({ key, avgMs: Math.round(t.totalMs / t.count), lastMs: Math.round(t.lastMs), count: t.count }))
      .sort((a, b) => b.avgMs - a.avgMs)
      .slice(0, 12),
  };
}

export function resetMetrics(): void {
  (Object.keys(counters) as (keyof CacheMetrics)[]).forEach((k) => {
    counters[k] = 0;
  });
  timings.clear();
}
