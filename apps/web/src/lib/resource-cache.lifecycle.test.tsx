import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { ResourceCacheProvider, useResourceCache } from './resource-cache';

/**
 * The cache across a change of authenticated identity.
 *
 * `clear()` empties the store, but it cannot recall requests already on the
 * wire. One still open across a sign-out or account switch used to land
 * afterwards and write the previous user's data into the wiped cache,
 * recreating the entry that had just been deleted — against an explicit rule
 * of this layer, that two people signing in on the same browser must never see
 * each other's clubs.
 *
 * Response sequencing made that worse rather than better: the resurrected entry
 * was rebuilt from EMPTY with `issuedSeq: 0` while carrying the straggler's
 * higher `settledSeq`, so the next user's first two requests were refused as
 * superseded and the previous user's data stayed on screen across three
 * fetches. Measured before the fix: B's 1st and 2nd requests dropped, only the
 * 3rd wrote.
 *
 * A request now captures the identity epoch when issued and re-checks it when
 * it settles.
 */

vi.mock('./auth-context', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ResourceCacheProvider>{children}</ResourceCacheProvider>
);

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Cache = ReturnType<typeof useResourceCache>;

function CacheProbe({ onReady }: { onReady: (c: Cache) => void }) {
  onReady(useResourceCache());
  return null;
}

function mountCache() {
  let cache!: Cache;
  render(<CacheProbe onReady={(c) => (cache = c)} />, { wrapper });
  return () => cache;
}

function issue(cache: () => Cache, key: string, g: { promise: Promise<string[]> }) {
  void cache()
    .load(key, () => g.promise, true)
    .catch(() => {});
}

const K = 'club:1';

describe('a request still in flight when the identity changes', () => {
  it('does not populate the cache after clear()', async () => {
    const cache = mountCache();
    const straggler = gate<string[]>();

    issue(cache, K, straggler);
    act(() => {
      cache().clear();
    });
    expect(cache().getEntry(K).data).toBeUndefined();

    await act(async () => {
      straggler.resolve(['USER-A-data']);
    });

    // The entry stays exactly as clear() left it — not recreated.
    expect(cache().getEntry(K).data).toBeUndefined();
    expect(cache().getEntry(K).settledSeq).toBe(0);
  });

  it('leaves the new identity authoritative when the straggler lands after its request started', async () => {
    const cache = mountCache();
    const straggler = gate<string[]>();

    issue(cache, K, straggler);
    act(() => {
      cache().clear();
    });

    const fresh = gate<string[]>();
    issue(cache, K, fresh); // user B's request is already open...

    await act(async () => {
      straggler.resolve(['USER-A-data']); // ...when user A's lands
    });
    expect(cache().getEntry(K).data).toBeUndefined();

    await act(async () => {
      fresh.resolve(['USER-B-data']);
    });
    expect(cache().getEntry(K).data).toEqual(['USER-B-data']);
  });

  it('lets the new identity write normally when its request settles after clear()', async () => {
    const cache = mountCache();

    const before = gate<string[]>();
    issue(cache, K, before);
    await act(async () => {
      before.resolve(['USER-A-data']);
    });
    expect(cache().getEntry(K).data).toEqual(['USER-A-data']);

    act(() => {
      cache().clear();
    });

    const after = gate<string[]>();
    issue(cache, K, after);
    await act(async () => {
      after.resolve(['USER-B-data']);
    });
    expect(cache().getEntry(K).data).toEqual(['USER-B-data']);
  });

  it("does not drop the next identity's first request because of the old sequence state", async () => {
    const cache = mountCache();

    // Build up sequence history, so a naive reset would leave the new entry
    // numbered below what has already settled.
    const first = gate<string[]>();
    issue(cache, K, first);
    await act(async () => {
      first.resolve(['A-1']);
    });
    const second = gate<string[]>();
    issue(cache, K, second);
    await act(async () => {
      second.resolve(['A-2']);
    });

    const straggler = gate<string[]>();
    issue(cache, K, straggler); // third request, never lands before the clear

    act(() => {
      cache().clear();
    });
    await act(async () => {
      straggler.resolve(['A-STRAGGLER']);
    });

    // The very first request of the new identity must write, not be refused.
    const fresh = gate<string[]>();
    issue(cache, K, fresh);
    await act(async () => {
      fresh.resolve(['USER-B-first']);
    });

    expect(cache().getEntry(K).data).toEqual(['USER-B-first']);

    // ...and the entry must be coherent: nothing can have settled that was
    // never issued.
    const entry = cache().getEntry(K);
    expect(entry.settledSeq).toBeLessThanOrEqual(entry.issuedSeq);
  });

  it('rejects every one of several requests left over from the old identity', async () => {
    const cache = mountCache();
    const a = gate<string[]>();
    const b = gate<string[]>();
    const c = gate<string[]>();

    issue(cache, 'club:1', a);
    issue(cache, 'club:2', b);
    issue(cache, 'club:1', c); // two on one key, one on another

    act(() => {
      cache().clear();
    });

    await act(async () => {
      a.resolve(['A']);
    });
    await act(async () => {
      c.resolve(['C']);
    });
    await act(async () => {
      b.resolve(['B']);
    });

    expect(cache().getEntry('club:1').data).toBeUndefined();
    expect(cache().getEntry('club:2').data).toBeUndefined();
  });

  it('does not report the old identity\'s failure against the new one', async () => {
    const cache = mountCache();
    const failing = gate<string[]>();

    issue(cache, K, failing);
    act(() => {
      cache().clear();
    });
    await act(async () => {
      failing.reject(new Error('old identity request failed'));
    });

    expect(cache().getEntry(K).error).toBeNull();
    expect(cache().getEntry(K).data).toBeUndefined();
  });
});

describe('the epoch guard is inert within one identity', () => {
  it('normal out-of-order sequencing still applies', async () => {
    const cache = mountCache();
    const A = gate<string[]>();
    const B = gate<string[]>();

    issue(cache, K, A);
    issue(cache, K, B);

    await act(async () => {
      B.resolve(['B-issued-second']);
    });
    await act(async () => {
      A.resolve(['A-issued-first']);
    });

    expect(cache().getEntry(K).data).toEqual(['B-issued-second']);
  });

  it('a slow poll still writes while a newer tick is in flight', async () => {
    const cache = mountCache();
    const tick1 = gate<string[]>();
    const tick2 = gate<string[]>();

    issue(cache, 'poll', tick1);
    issue(cache, 'poll', tick2);

    await act(async () => {
      tick1.resolve(['tick-1']);
    });
    expect(cache().getEntry('poll').data).toEqual(['tick-1']);

    await act(async () => {
      tick2.resolve(['tick-2']);
    });
    expect(cache().getEntry('poll').data).toEqual(['tick-2']);
  });

  it('an ordinary request writes with no clear() anywhere in sight', async () => {
    const cache = mountCache();
    const only = gate<string[]>();

    issue(cache, K, only);
    await act(async () => {
      only.resolve(['written']);
    });

    expect(cache().getEntry(K).data).toEqual(['written']);
  });
});
