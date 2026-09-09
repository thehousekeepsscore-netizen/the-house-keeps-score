import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createResyncCoalescer,
  RESUME_REFETCH_FALLBACK_MS,
  CONNECT_DUPLICATE_GUARD_MS,
} from './resync-coalescer';

/**
 * The policy alone, on a fake clock.
 *
 * Measured on the production bundle: a phone whose socket died while locked
 * refetched ten endpoints on resume and the same ten again 1.3 seconds later
 * on reconnect. These pin the rule that turns that into one pass — and pin
 * the cases where a second pass is correct and must survive.
 */

let connected: boolean;
let refetch: ReturnType<typeof vi.fn>;

function make() {
  return createResyncCoalescer({ isConnected: () => connected, refetch });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-09T20:00:00Z'));
  connected = true;
  refetch = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resume', () => {
  it('refetches immediately when the socket claims to be connected', () => {
    make().onResume();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('defers to `connect` when the socket admits it is down: one pass, after the socket is up', () => {
    connected = false;
    const c = make();
    c.onResume();
    expect(refetch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1300); // socket.io's first retry, as measured
    c.onConnect();
    expect(refetch).toHaveBeenCalledTimes(1);

    // The fallback was cancelled by the connect: nothing more, ever.
    vi.advanceTimersByTime(RESUME_REFETCH_FALLBACK_MS * 2);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to a refetch when no `connect` arrives in time', () => {
    connected = false;
    make().onResume();
    vi.advanceTimersByTime(RESUME_REFETCH_FALLBACK_MS - 1);
    expect(refetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the earliest deadline when a second resume lands while still down', () => {
    connected = false;
    const c = make();
    c.onResume();
    vi.advanceTimersByTime(1000);
    c.onResume();
    vi.advanceTimersByTime(RESUME_REFETCH_FALLBACK_MS - 1000);
    expect(refetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RESUME_REFETCH_FALLBACK_MS);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('connect', () => {
  it('refetches on its own', () => {
    make().onConnect();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('absorbs a duplicate firing inside the guard window', () => {
    const c = make();
    c.onConnect();
    vi.advanceTimersByTime(100);
    c.onConnect();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('refetches again once the guard has passed', () => {
    const c = make();
    c.onConnect();
    vi.advanceTimersByTime(CONNECT_DUPLICATE_GUARD_MS);
    c.onConnect();
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it('a probe-forced reconnect after a connected resume is a legitimate second pass', () => {
    // The socket lied at resume; the first refetch ran over a dead transport.
    // The probe times out three seconds later and forces disconnect → connect.
    const c = make();
    c.onResume();
    expect(refetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    c.onConnect();
    expect(refetch).toHaveBeenCalledTimes(2);
  });
});

describe('dispose', () => {
  it('cancels a pending fallback', () => {
    connected = false;
    const c = make();
    c.onResume();
    c.dispose();
    vi.advanceTimersByTime(RESUME_REFETCH_FALLBACK_MS * 2);
    expect(refetch).not.toHaveBeenCalled();
  });
});
