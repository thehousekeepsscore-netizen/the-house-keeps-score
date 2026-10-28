/**
 * The readiness probe must say "unavailable" when the database is gone, and
 * must say it within its timeout rather than hanging with the connection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkReadiness, READINESS_TIMEOUT_MS } from './readiness.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('checkReadiness', () => {
  it('is ready when the probe answers, and reports how long it took', async () => {
    let t = 1_000;
    const now = () => t;
    const probe = async () => { t += 12; return [{ ok: 1 }]; };
    await expect(checkReadiness(probe, READINESS_TIMEOUT_MS, now)).resolves.toEqual({ ready: true, latencyMs: 12 });
  });

  it('is unavailable when the probe rejects, with the first line of the reason', async () => {
    const probe = async () => { throw new Error('FATAL: (ENOTFOUND) tenant/user postgres.abc not found\nmore detail'); };
    const r = await checkReadiness(probe);
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('FATAL: (ENOTFOUND) tenant/user postgres.abc not found');
  });

  it('never repeats a connection string in the reason', async () => {
    const probe = async () => { throw new Error("Can't reach database server at postgresql://user:secret@host:5432/db"); };
    const r = await checkReadiness(probe);
    expect(r.reason).toContain('<database url>');
    expect(r.reason).not.toContain('secret');
  });

  it('gives up at the timeout when the probe hangs', async () => {
    const probe = () => new Promise<never>(() => {});
    const pending = checkReadiness(probe, 5000);
    await vi.advanceTimersByTimeAsync(4999);
    // Still waiting: nothing has resolved.
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await pending;
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/timed out after 5000ms/);
  });

  it('clears its timer once the probe answers, so nothing is left holding the loop', async () => {
    const probe = async () => 1;
    await checkReadiness(probe, 5000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
