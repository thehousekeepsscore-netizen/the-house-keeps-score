import { describe, it, expect, beforeEach } from 'vitest';
import { bump, recordTiming, snapshot, resetMetrics } from './cache-metrics';

/**
 * The metrics exist so performance claims can be measured rather than asserted.
 * That only holds if the counters themselves are correct, so they are tested
 * like any other logic.
 */
describe('cache metrics', () => {
  beforeEach(resetMetrics);

  it('reports no hit rate before any read, rather than a misleading 0%', () => {
    expect(snapshot().hitRatePercent).toBeNull();
  });

  it('computes hit rate from reads only, ignoring unrelated counters', () => {
    bump('hits', 8);
    bump('misses', 2);
    bump('refreshes', 5);
    bump('writeThroughs', 3);
    expect(snapshot().hitRatePercent).toBe(80);
  });

  it('counts a deduped request as a request saved', () => {
    bump('dedupedRequests', 3);
    expect(snapshot().requestsSaved).toBe(3);
  });

  it('ranks slowest resources by average rather than most recent', () => {
    recordTiming('fast', 10);
    recordTiming('fast', 10);
    recordTiming('slow', 500);
    recordTiming('spiky', 5);
    recordTiming('spiky', 205); // avg 105 — slower than fast, faster than slow

    const slowest = snapshot().slowest;
    expect(slowest.map((s) => s.key)).toEqual(['slow', 'spiky', 'fast']);
    expect(slowest[1].avgMs).toBe(105);
    expect(slowest[1].lastMs).toBe(205);
    expect(slowest[1].count).toBe(2);
  });

  it('resets counters and timings together', () => {
    bump('hits', 5);
    recordTiming('k', 1);
    resetMetrics();
    expect(snapshot().hits).toBe(0);
    expect(snapshot().hitRatePercent).toBeNull();
    expect(snapshot().slowest).toHaveLength(0);
  });
});
