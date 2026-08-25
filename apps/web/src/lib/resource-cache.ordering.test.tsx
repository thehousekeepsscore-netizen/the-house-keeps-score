import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { ResourceCacheProvider, useResource, useResourceCache } from './resource-cache';
import { resetMetrics, snapshot } from './cache-metrics';

/**
 * Response ordering for one cache key.
 *
 * Forced fetches skip the in-flight check, so `resync()`'s eight `refresh*`
 * helpers can each have two requests open at once — and nothing makes responses
 * come back in the order they went out. Before this, the last to *arrive* won,
 * so an older response overwrote a newer one and stamped `fetchedAt` with its
 * own arrival time; the stale value was then recorded as the freshest the cache
 * had, and with no `pollMs` on those resources nothing revalidated it.
 *
 * The rule under test: a response writes unless a NEWER response has already
 * written. Note what that is not — it does not refuse a response merely because
 * a newer request is open. That weaker-looking rule is the load-bearing one:
 * see the starvation tests, which fail under the stricter alternative.
 */

vi.mock('./auth-context', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ResourceCacheProvider>{children}</ResourceCacheProvider>
);

/** A request whose settlement moment the test owns. */
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

/** Reaches the cache directly, so ordering is tested without React scheduling. */
function mountCache() {
  let cache!: Cache;
  render(<CacheProbe onReady={(c) => (cache = c)} />, { wrapper });
  return () => cache;
}

/** Issues a forced request, as every `refresh*` helper does. Never throws. */
function issue(cache: () => Cache, key: string, g: { promise: Promise<string[]> }) {
  void cache()
    .load(key, () => g.promise, true)
    .catch(() => {});
}

describe('two overlapping requests on one key', () => {
  it('B resolves then A resolves — B survives', async () => {
    const cache = mountCache();
    const A = gate<string[]>();
    const B = gate<string[]>();

    issue(cache, 'k1', A); // issued first
    issue(cache, 'k1', B); // issued second

    await act(async () => {
      B.resolve(['B-issued-second']);
    });
    const stampedByB = cache().getEntry('k1').fetchedAt;

    await act(async () => {
      A.resolve(['A-issued-first']);
    });

    expect(cache().getEntry('k1').data).toEqual(['B-issued-second']);

    // The superseded response must not re-stamp freshness either. This is the
    // half that made the bug persist: a stale winner with a current fetchedAt
    // is invisible to staleTime and never revalidates.
    expect(cache().getEntry('k1').fetchedAt).toBe(stampedByB);
  });

  it('A resolves then B resolves — B survives', async () => {
    const cache = mountCache();
    const A = gate<string[]>();
    const B = gate<string[]>();

    issue(cache, 'k2', A);
    issue(cache, 'k2', B);

    await act(async () => {
      A.resolve(['A-issued-first']);
    });
    await act(async () => {
      B.resolve(['B-issued-second']);
    });

    expect(cache().getEntry('k2').data).toEqual(['B-issued-second']);
  });

  it('A, B, C issued and C, B, A arriving — C survives', async () => {
    const cache = mountCache();
    const A = gate<string[]>();
    const B = gate<string[]>();
    const C = gate<string[]>();

    issue(cache, 'k3', A);
    issue(cache, 'k3', B);
    issue(cache, 'k3', C);

    await act(async () => {
      C.resolve(['C-newest']);
    });
    await act(async () => {
      B.resolve(['B-middle']);
    });
    await act(async () => {
      A.resolve(['A-oldest']);
    });

    expect(cache().getEntry('k3').data).toEqual(['C-newest']);
  });

  it('A, B, C issued and A, B, C arriving — C survives', async () => {
    const cache = mountCache();
    const A = gate<string[]>();
    const B = gate<string[]>();
    const C = gate<string[]>();

    issue(cache, 'k4', A);
    issue(cache, 'k4', B);
    issue(cache, 'k4', C);

    await act(async () => {
      A.resolve(['A-oldest']);
    });
    await act(async () => {
      B.resolve(['B-middle']);
    });
    await act(async () => {
      C.resolve(['C-newest']);
    });

    expect(cache().getEntry('k4').data).toEqual(['C-newest']);
  });
});

describe('the ordinary path still writes', () => {
  it('a lone request writes its response', async () => {
    const cache = mountCache();
    const only = gate<string[]>();

    issue(cache, 'k5', only);
    await act(async () => {
      only.resolve(['written']);
    });

    expect(cache().getEntry('k5').data).toEqual(['written']);
    expect(cache().getEntry('k5').inFlight).toBeNull();
  });

  it('successive non-overlapping requests each write', async () => {
    const cache = mountCache();

    const first = gate<string[]>();
    issue(cache, 'k6', first);
    await act(async () => {
      first.resolve(['first']);
    });
    expect(cache().getEntry('k6').data).toEqual(['first']);

    const second = gate<string[]>();
    issue(cache, 'k6', second);
    await act(async () => {
      second.resolve(['second']);
    });
    expect(cache().getEntry('k6').data).toEqual(['second']);
  });

  it('an unforced caller still joins an in-flight request rather than issuing one', async () => {
    const cache = mountCache();
    const g = gate<string[]>();
    const fetcher = vi.fn(() => g.promise);
    resetMetrics();

    void cache().load('k7', fetcher, false).catch(() => {});
    void cache().load('k7', fetcher, false).catch(() => {});

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(snapshot().dedupedRequests).toBe(1);

    await act(async () => {
      g.resolve(['shared']);
    });
    expect(cache().getEntry('k7').data).toEqual(['shared']);
  });
});

describe('a slow poll must not starve', () => {
  /**
   * ClubDashboardView polls two keys every 15s, forced. On a connection where a
   * response takes longer than the interval, each tick is still open when the
   * next is issued. A rule that refused a response because a newer request had
   * been *issued* would drop every one of them and the entry would stop
   * updating — worse than the bug being fixed. These are the tests that pin the
   * weaker comparison in place.
   */

  it('an older response still writes while a newer request is in flight', async () => {
    const cache = mountCache();
    const tick1 = gate<string[]>();
    const tick2 = gate<string[]>();

    issue(cache, 'poll', tick1);
    issue(cache, 'poll', tick2); // next tick fires before the first came back

    await act(async () => {
      tick1.resolve(['tick-1']);
    });

    // Nothing newer has landed, so this response is the freshest truth there is.
    expect(cache().getEntry('poll').data).toEqual(['tick-1']);

    // ...and tick 2 is still tracked as in flight, so `isRevalidating` stays
    // honest and the next unforced caller can still dedupe into it.
    expect(cache().getEntry('poll').inFlight).not.toBeNull();

    await act(async () => {
      tick2.resolve(['tick-2']);
    });
    expect(cache().getEntry('poll').data).toEqual(['tick-2']);
    expect(cache().getEntry('poll').inFlight).toBeNull();
  });

  it('under sustained overlap every tick still updates the cache', async () => {
    const cache = mountCache();
    const t1 = gate<string[]>();
    const t2 = gate<string[]>();
    const t3 = gate<string[]>();

    issue(cache, 'poll2', t1);
    issue(cache, 'poll2', t2);
    await act(async () => {
      t1.resolve(['tick-1']);
    });
    expect(cache().getEntry('poll2').data).toEqual(['tick-1']);

    issue(cache, 'poll2', t3);
    await act(async () => {
      t2.resolve(['tick-2']);
    });
    expect(cache().getEntry('poll2').data).toEqual(['tick-2']);

    await act(async () => {
      t3.resolve(['tick-3']);
    });
    expect(cache().getEntry('poll2').data).toEqual(['tick-3']);
  });
});

describe('failures obey the same ordering', () => {
  it('a superseded failure does not post its error over a newer success', async () => {
    const cache = mountCache();
    const A = gate<string[]>();
    const B = gate<string[]>();

    issue(cache, 'k8', A);
    issue(cache, 'k8', B);

    await act(async () => {
      B.resolve(['B-newer']);
    });
    await act(async () => {
      A.reject(new Error('older request failed'));
    });

    expect(cache().getEntry('k8').data).toEqual(['B-newer']);
    expect(cache().getEntry('k8').error).toBeNull();
  });

  it('a current failure still records its error and keeps the data on screen', async () => {
    const cache = mountCache();

    const seed = gate<string[]>();
    issue(cache, 'k9', seed);
    await act(async () => {
      seed.resolve(['kept']);
    });

    const failing = gate<string[]>();
    issue(cache, 'k9', failing);
    await act(async () => {
      failing.reject(new Error('network'));
    });

    expect(cache().getEntry('k9').error).toBeInstanceOf(Error);
    expect(cache().getEntry('k9').data).toEqual(['kept']);
  });
});

describe('rollback bookkeeping is untouched', () => {
  it('a superseded response does not bump version, so a pending rollback sees no interference', async () => {
    const cache = mountCache();
    const A = gate<string[]>();
    const B = gate<string[]>();

    issue(cache, 'k10', A);
    issue(cache, 'k10', B);

    await act(async () => {
      B.resolve(['B']);
    });
    const versionAfterB = cache().getEntry('k10').version;

    await act(async () => {
      A.resolve(['A']);
    });

    expect(cache().getEntry('k10').version).toBe(versionAfterB);
  });

  it('restore still restores cleanly after a superseded response has landed', async () => {
    const cache = mountCache();
    const A = gate<string[]>();
    const B = gate<string[]>();

    issue(cache, 'k11', A);
    issue(cache, 'k11', B);
    await act(async () => {
      B.resolve(['alice', 'bob']);
    });
    await act(async () => {
      A.resolve(['stale']);
    });

    const snap = cache().snapshot<string[]>('k11');
    act(() => {
      cache().update<string[]>('k11', (prev) => (prev ?? []).filter((x) => x !== 'alice'));
    });
    expect(cache().getEntry('k11').data).toEqual(['bob']);

    act(() => {
      cache().restore('k11', snap);
    });
    expect(cache().getEntry('k11').data).toEqual(['alice', 'bob']);
  });
});

describe('superseded responses are counted', () => {
  it('reports how many responses lost the race', async () => {
    const cache = mountCache();
    const A = gate<string[]>();
    const B = gate<string[]>();

    issue(cache, 'k12', A);
    issue(cache, 'k12', B);
    await act(async () => {
      B.resolve(['B']);
    });

    resetMetrics();
    await act(async () => {
      A.resolve(['A']);
    });

    expect(snapshot().supersededResponses).toBe(1);
  });
});

describe('what the user sees', () => {
  it('the newest response stays on screen when an older one arrives late', async () => {
    let res!: ReturnType<typeof useResource<string[]>>;
    const gates: ReturnType<typeof gate<string[]>>[] = [];
    const fetcher = vi.fn(() => {
      const g = gate<string[]>();
      gates.push(g);
      return g.promise;
    });

    const Probe = () => {
      res = useResource<string[]>('screen', fetcher);
      return <div data-testid="rows">{(res.data ?? []).join(',')}</div>;
    };
    render(<Probe />, { wrapper });

    await act(async () => {
      gates[0].resolve(['seed']);
    });
    await waitFor(() => expect(screen.getByTestId('rows')).toHaveTextContent('seed'));

    // Two resyncs landing on one key, as socket-connect and a foreground
    // refetch would.
    act(() => {
      void res.refresh();
      void res.refresh();
    });
    expect(gates).toHaveLength(3);

    await act(async () => {
      gates[2].resolve(['current']);
    });
    await act(async () => {
      gates[1].resolve(['out-of-date']);
    });

    expect(screen.getByTestId('rows')).toHaveTextContent('current');
  });
});

/**
 * KNOWN OPEN DEFECT — deliberately not fixed in this stage.
 *
 * A response that has NOT been superseded still overwrites an optimistic write
 * that landed while it was in flight. Ordering cannot fix this: the response is
 * the newest one, so every ordering rule accepts it. Closing it needs the write
 * to respect a version bumped after the request was issued — the same reasoning
 * `restore` already applies, mirrored onto the success path — and that changes
 * optimistic-write semantics, which is its own stage.
 *
 * This test passes today and must keep passing until that stage lands. It is
 * here so the gap is recorded in executable form, and so this change can be
 * shown not to have altered the behaviour either way.
 */
describe('KNOWN OPEN DEFECT: optimistic writes are still clobbered', () => {
  it('a current response overwrites an optimistic write made while it was in flight', async () => {
    let cache!: Cache;
    let res!: ReturnType<typeof useResource<string[]>>;
    const gates: ReturnType<typeof gate<string[]>>[] = [];
    const fetcher = vi.fn(() => {
      const g = gate<string[]>();
      gates.push(g);
      return g.promise;
    });

    const Probe = () => {
      cache = useResourceCache();
      res = useResource<string[]>('known-gap', fetcher);
      return <div data-testid="rows">{(res.data ?? []).join(',')}</div>;
    };
    render(<Probe />, { wrapper });

    await act(async () => {
      gates[0].resolve(['alice', 'bob']);
    });
    await waitFor(() => expect(screen.getByTestId('rows')).toHaveTextContent('alice,bob'));

    act(() => {
      void res.refresh();
    });
    act(() => {
      cache.update<string[]>('known-gap', (prev) => (prev ?? []).filter((x) => x !== 'alice'));
    });
    expect(screen.getByTestId('rows')).toHaveTextContent('bob');

    await act(async () => {
      gates[1].resolve(['alice', 'bob']); // pre-mutation state, but not superseded
    });

    expect(screen.getByTestId('rows')).toHaveTextContent('alice,bob');
  });
});
