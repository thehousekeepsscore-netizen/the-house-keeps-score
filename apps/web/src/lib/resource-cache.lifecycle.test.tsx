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

/**
 * A write authorised by one identity must not land in another's cache.
 *
 * `load` has been guarded since the epoch went in, but `update` was not, and
 * the two differ in a way that matters: a write-through runs *after* an awaited
 * mutation, so by the time `update` is called the current epoch is already the
 * new one. Reading it inside `update` would always agree with itself. The
 * ownership has to be captured before the request goes out and carried across
 * it, which is what the write token is.
 *
 * Reproduced before the fix, on this harness:
 *
 *   after switch      undefined                                  (cleared)
 *   B loaded          ["USER-B-session"]
 *   A mutation lands  ["USER-B-session","USER-A-mutation-result"]
 *
 * The sign-out path was worse. The clear effect only fires when
 * `lastUserId.current !== null`, so after signing out — which sets it to null —
 * the *next* sign-in does not clear again. An orphan written in that gap is
 * inherited by whoever signs in next, and `useResource` renders it immediately
 * because the entry has data.
 */
describe('writes cannot cross an identity change', () => {
  it('discards a mutation that resolves after the identity switched', async () => {
    const cache = mountCache();
    const write = cache().beginWrite(); // taken while the first identity is signed in

    const a = gate<string[]>();
    issue(cache, K, a);
    await act(async () => {
      a.resolve(['USER-A-session']);
    });

    act(() => {
      cache().clear();
    });

    const b = gate<string[]>();
    issue(cache, K, b);
    await act(async () => {
      b.resolve(['USER-B-session']);
    });

    // The first identity's mutation finally returns.
    act(() => {
      cache().update<string[]>(K, (prev) => [...(prev ?? []), 'USER-A-mutation-result'], write);
    });

    expect(cache().getEntry(K).data).toEqual(['USER-B-session']);
  });

  it('does not leave an orphan for the next identity to inherit', async () => {
    // The sign-out variant: nobody is signed in when the mutation lands, so
    // there is no data to merge into — the danger is creating an entry at all,
    // because the following sign-in does not clear again.
    const cache = mountCache();
    const write = cache().beginWrite();

    const a = gate<string[]>();
    issue(cache, K, a);
    await act(async () => {
      a.resolve(['USER-A-session']);
    });

    act(() => {
      cache().clear();
    });
    act(() => {
      cache().update<string[]>(K, () => ['USER-A-mutation-result'], write);
    });

    expect(cache().getEntry(K).data).toBeUndefined();
  });

  it('discards a rollback whose snapshot predates the identity change', async () => {
    // Rollbacks run in a catch block after the same await, so a snapshot taken
    // by one identity can be restored under another.
    //
    // The sequence is chosen so `restore`'s own version check would ALLOW the
    // write: it only refuses when something else has written since, and here
    // the version arithmetic lines up exactly (B's load takes the fresh entry
    // to 1, B's optimistic write to 2, and A's snapshot was taken at 1). With
    // the version check satisfied, the epoch is the only thing standing between
    // A's data and B's screen — which is what makes this test bite.
    const cache = mountCache();

    const a = gate<string[]>();
    issue(cache, K, a);
    await act(async () => {
      a.resolve(['USER-A-session']);
    });
    const snap = cache().snapshot<string[]>(K); // version 1, A's data

    act(() => {
      cache().clear();
    });

    const b = gate<string[]>();
    issue(cache, K, b);
    await act(async () => {
      b.resolve(['USER-B-session']); // fresh entry, version 1
    });
    act(() => {
      cache().update<string[]>(K, () => ['USER-B-optimistic'], cache().beginWrite()); // version 2
    });

    act(() => {
      cache().restore(K, snap);
    });

    expect(cache().getEntry(K).data).toEqual(['USER-B-optimistic']);
  });

  it('still writes normally when the identity has not changed', async () => {
    // The control. Without it, every assertion above would also pass against a
    // cache that had simply stopped writing.
    const cache = mountCache();
    const write = cache().beginWrite();

    const a = gate<string[]>();
    issue(cache, K, a);
    await act(async () => {
      a.resolve(['session']);
    });

    act(() => {
      cache().update<string[]>(K, (prev) => [...(prev ?? []), 'mutation-result'], write);
    });

    expect(cache().getEntry(K).data).toEqual(['session', 'mutation-result']);
  });
});

/**
 * The token means "this identity", not "this render".
 *
 * A per-render capture would be a quiet disaster: React rerenders constantly
 * for reasons that have nothing to do with who is signed in, and every one of
 * them would invalidate legitimate in-flight writes. Approving a buy-in while
 * anything else on the screen updated would silently drop the write-through.
 *
 * The guard compares epoch values, and `beginWrite` only mints a new object
 * when the epoch actually moves, so a token captured in the first render is
 * still the same object — and still valid — a hundred renders later.
 */
describe('the write token tracks identity, not renders', () => {
  it('stays valid across rerenders while the same identity is signed in', async () => {
    let cache!: Cache;
    const Probe = () => {
      cache = useResourceCache();
      return null;
    };
    const tree = () => (
      <ResourceCacheProvider>
        <Probe />
      </ResourceCacheProvider>
    );
    const { rerender } = render(tree());

    const write = cache.beginWrite(); // captured in the first render

    const a = gate<string[]>();
    void cache.load(K, () => a.promise, true).catch(() => {});
    await act(async () => {
      a.resolve(['session']);
    });

    // Plenty of unrelated rerenders, no identity change.
    for (let i = 0; i < 25; i += 1) {
      await act(async () => {
        rerender(tree());
      });
    }

    act(() => {
      cache.update<string[]>(K, (prev) => [...(prev ?? []), 'mutation-result'], write);
    });

    expect(cache.getEntry(K).data).toEqual(['session', 'mutation-result']);
  });

  it('returns the same token object until the identity changes', () => {
    const cache = mountCache();
    const first = cache().beginWrite();

    expect(cache().beginWrite()).toBe(first);

    act(() => {
      cache().clear();
    });

    // A new identity means a new token, and the old one is no longer equal.
    const second = cache().beginWrite();
    expect(second).not.toBe(first);
    expect(second.epoch).not.toBe(first.epoch);
  });
});

/**
 * `invalidate()` is deliberately left unguarded — the boundary of #57.
 *
 * It is the third write path a departed identity can reach, and it is not the
 * same kind of hazard. It writes no data: it sets `fetchedAt` to 0 so the next
 * read revalidates, and it returns early when the entry does not exist, so it
 * cannot resurrect anything either. The worst a late call can do is cost the
 * new identity one refetch of their own data, fetched with their own
 * credentials.
 *
 * That is waste, not a leak, so guarding it is a change with no correctness
 * payoff and it stays out of this fix. This test exists to hold that boundary:
 * if `invalidate` ever starts writing data, it fails.
 */
describe('invalidate cannot carry data across an identity change', () => {
  it('marks stale without touching what the new identity loaded', async () => {
    const cache = mountCache();

    const a = gate<string[]>();
    issue(cache, K, a);
    await act(async () => {
      a.resolve(['USER-A-session']);
    });

    act(() => {
      cache().clear();
    });

    const b = gate<string[]>();
    issue(cache, K, b);
    await act(async () => {
      b.resolve(['USER-B-session']);
    });

    act(() => {
      cache().invalidate(K); // a late call from the departed identity
    });

    // B's data is intact. Only its freshness was reset, which costs a refetch.
    expect(cache().getEntry(K).data).toEqual(['USER-B-session']);
    expect(cache().getEntry(K).fetchedAt).toBe(0);
  });
});
