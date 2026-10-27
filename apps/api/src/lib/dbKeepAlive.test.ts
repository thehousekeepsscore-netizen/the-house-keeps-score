/**
 * The heartbeat has one job — keep beating — and one rule: never take the
 * process down with it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDbKeepAlive } from './dbKeepAlive.js';

const HOUR = 60 * 60 * 1000;
const silent = { log: vi.fn(), warn: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  silent.log.mockClear();
  silent.warn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startDbKeepAlive', () => {
  it('beats once per interval, and not before', async () => {
    const probe = vi.fn(async () => 1);
    const stop = startDbKeepAlive({ intervalMs: 6 * HOUR, probe, log: silent });
    await vi.advanceTimersByTimeAsync(6 * HOUR - 1);
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(18 * HOUR);
    expect(probe).toHaveBeenCalledTimes(4);
    stop();
  });

  it('logs a failed beat and keeps beating — it never throws', async () => {
    const probe = vi.fn()
      .mockRejectedValueOnce(new Error('FATAL: tenant not found\ndetail'))
      .mockResolvedValue(1);
    const stop = startDbKeepAlive({ intervalMs: HOUR, probe, log: silent });
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(silent.warn).toHaveBeenCalledWith('Database keep-alive: FAILED — FATAL: tenant not found');
    expect(silent.log).toHaveBeenCalledWith(expect.stringMatching(/keep-alive: ok \(\d+ms\)/));
    stop();
  });

  it('stops when told, and beats no more', async () => {
    const probe = vi.fn(async () => 1);
    const stop = startDbKeepAlive({ intervalMs: HOUR, probe, log: silent });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(probe).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(10 * HOUR);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('is disabled at an interval of zero, and says so', async () => {
    const probe = vi.fn(async () => 1);
    const stop = startDbKeepAlive({ intervalMs: 0, probe, log: silent });
    await vi.advanceTimersByTimeAsync(48 * HOUR);
    expect(probe).not.toHaveBeenCalled();
    expect(silent.log).toHaveBeenCalledWith('Database keep-alive: disabled');
    stop();
  });
});
