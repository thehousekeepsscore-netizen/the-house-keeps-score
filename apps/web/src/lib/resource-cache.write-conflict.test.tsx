import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor, screen } from '@testing-library/react';

vi.mock('./auth-context', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));

import { ResourceCacheProvider, useResourceCache, useResource } from './resource-cache';
import { resetMetrics, snapshot } from './cache-metrics';

/**
 * A GET must not overwrite something committed after it was issued. (#77)
 *
 * The race, measured before this was fixed:
 *
 *   GET goes out  ->  user approves, cache.update writes optimistically
 *                 ->  the POST succeeds and the CONFIRMED value is written
 *                 ->  the GET lands, holding state from before any of it
 *                 ->  the confirmed value is gone, and `fetchedAt` is stamped
 *                     with the GET's arrival, so the cache now believes the
 *                     older state is the freshest thing it has
 *
 * Neither existing guard caught it. Response ordering compares sequence
 * numbers, and a write does not take one, so the GET looked current. The
 * identity epoch compares who wrote, and nobody signed in or out. The two
 * mechanisms answer "is this response newer?" and "is this response mine?";
 * nothing answered "has anything changed here since I asked?".
 *
 * `writeSeq` answers that, and only that. It counts LOCAL writes -- `update`
 * only -- so a response settling never moves it. That asymmetry is what keeps
 * a slow poll alive: if responses bumped the counter too, two polls in flight
 * would see it move and the second would refuse itself, which is exactly the
 * starvation `settledSeq` exists to prevent.
 */

type Cache = ReturnType<typeof useResourceCache>;

function gate<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ResourceCacheProvider>{children}</ResourceCacheProvider>
);

/** Reads the private bookkeeping the guards actually run on. */
function entry(cache: Cache, key: string) {
  return cache.getEntry(key) as unknown as {
    data: unknown;
    fetchedAt: number;
    version: number;
    settledSeq: number;
    writeSeq: number;
  };
}

/** What `useResource` itself would conclude at the default 30s staleTime. */
function isStale(cache: Cache, key: string, staleTime = 30_000) {
  return Date.now() - entry(cache, key).fetchedAt > staleTime;
}

function mount(key: string) {
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
    res = useResource<string[]>(key, fetcher);
    return <div data-testid="rows">{(res.data ?? []).join(',')}</div>;
  };
  render(<Probe />, { wrapper });
  return {
    gates,
    fetcher,
    get cache() {
      return cache;
    },
    get res() {
      return res;
    },
  };
}

async function settleFirstLoad(h: ReturnType<typeof mount>, value: string[]) {
  await act(async () => {
    h.gates[0].resolve(value);
  });
  await waitFor(() => expect(screen.getByTestId('rows')).toHaveTextContent(value.join(',')));
}

beforeEach(() => {
  resetMetrics();
});

describe('1 — control: nothing in flight', () => {
  it('an optimistic write simply stands', async () => {
    // If this ever fails, every other test in this file is meaningless: it
    // proves the harness can see an optimistic write at all.
    const h = mount('c1');
    await settleFirstLoad(h, ['alice', 'bob']);

    act(() => {
      h.cache.update<string[]>('c1', (p) => (p ?? []).filter((x) => x !== 'alice'), h.cache.beginWrite());
    });

    expect(screen.getByTestId('rows')).toHaveTextContent('bob');
    expect(snapshot().responseConflicts).toBe(0);
  });
});

describe('2 — the transient defect', () => {
  it('a GET issued before an optimistic write cannot overwrite it', async () => {
    const h = mount('c2');
    await settleFirstLoad(h, ['alice', 'bob']);

    act(() => void h.res.refresh());
    act(() => {
      h.cache.update<string[]>('c2', (p) => (p ?? []).filter((x) => x !== 'alice'), h.cache.beginWrite());
    });

    await act(async () => {
      h.gates[1].resolve(['alice', 'bob']);
    });

    expect(screen.getByTestId('rows')).toHaveTextContent('bob');
    expect(snapshot().responseConflicts).toBe(1);
  });
});

describe('3 — the critical case: a server-confirmed value', () => {
  it('survives a GET that was issued before the mutation existed', async () => {
    // The one that loses money rather than pixels. The value here is not a
    // guess the UI made -- it is what the server said after the POST.
    const h = mount('c3');
    await settleFirstLoad(h, ['alice', 'bob']);

    act(() => void h.res.refresh()); // a poll or resync, already open
    act(() => {
      h.cache.update<string[]>('c3', (p) => (p ?? []).filter((x) => x !== 'alice'), h.cache.beginWrite());
    });
    act(() => {
      h.cache.update<string[]>('c3', () => ['bob', 'carol-confirmed'], h.cache.beginWrite());
    });

    await act(async () => {
      h.gates[1].resolve(['alice', 'bob']);
    });

    expect(screen.getByTestId('rows')).toHaveTextContent('bob,carol-confirmed');
  });
});

describe('4 — freshness', () => {
  it('a refused response leaves the entry stale, not fresh', async () => {
    // The failure this prevents is subtle and worse than the overwrite: drop
    // the response but leave `fetchedAt` advanced, and the screen looks right
    // while the cache quietly refuses to revalidate for a full staleTime.
    const h = mount('c4');
    await settleFirstLoad(h, ['alice', 'bob']);
    expect(isStale(h.cache, 'c4')).toBe(false);

    act(() => void h.res.refresh());
    act(() => {
      h.cache.update<string[]>('c4', () => ['bob', 'carol-confirmed'], h.cache.beginWrite());
    });
    await act(async () => {
      h.gates[1].resolve(['alice', 'bob']);
    });

    expect(entry(h.cache, 'c4').fetchedAt).toBe(0);
    expect(isStale(h.cache, 'c4')).toBe(true);
    expect(h.cache.getEntry('c4').data).toEqual(['bob', 'carol-confirmed']);
  });

  it('and the next read is allowed to fetch the truth', async () => {
    const h = mount('c4b');
    await settleFirstLoad(h, ['alice', 'bob']);
    act(() => void h.res.refresh());
    act(() => {
      h.cache.update<string[]>('c4b', () => ['local'], h.cache.beginWrite());
    });
    await act(async () => {
      h.gates[1].resolve(['alice', 'bob']);
    });

    // Nothing is blocking a further request, and when it lands unopposed it
    // becomes the truth -- the entry recovers rather than latching.
    act(() => void h.res.refresh());
    await act(async () => {
      h.gates[2].resolve(['server', 'truth']);
    });

    expect(screen.getByTestId('rows')).toHaveTextContent('server,truth');
    expect(isStale(h.cache, 'c4b')).toBe(false);
  });
});

describe('5 — the normal path is untouched', () => {
  it('a response with no intervening write still writes', async () => {
    const h = mount('c5');
    await settleFirstLoad(h, ['alice', 'bob']);

    act(() => void h.res.refresh());
    await act(async () => {
      h.gates[1].resolve(['alice', 'bob', 'carol']);
    });

    expect(screen.getByTestId('rows')).toHaveTextContent('alice,bob,carol');
    expect(isStale(h.cache, 'c5')).toBe(false);
    expect(snapshot().responseConflicts).toBe(0);
  });
});

describe('6 — response ordering still decides between responses', () => {
  it('an older response still loses to a newer one that already settled', async () => {
    const h = mount('c6');
    await settleFirstLoad(h, ['first']);

    act(() => void h.res.refresh()); // seq 2
    act(() => void h.res.refresh()); // seq 3

    await act(async () => {
      h.gates[2].resolve(['newer']); // seq 3 lands first
    });
    await act(async () => {
      h.gates[1].resolve(['older']); // seq 2 arrives late
    });

    expect(screen.getByTestId('rows')).toHaveTextContent('newer');
    // Refused by ordering, not by the write guard -- nothing was written.
    expect(snapshot().responseConflicts).toBe(0);
  });
});

describe('7 — slow poll must not starve', () => {
  it('a slow response with no intervening write still settles', async () => {
    // The regression a naive `version` check would have caused: a response's
    // own write bumps `version`, so the second of two in-flight polls would
    // have found it moved and refused itself. Under a poll slower than its
    // interval that is every tick, and the entry stops updating entirely.
    const h = mount('c7');
    await settleFirstLoad(h, ['t0']);

    act(() => void h.res.refresh()); // seq 2
    act(() => void h.res.refresh()); // seq 3

    await act(async () => {
      h.gates[1].resolve(['t1']); // older lands first, writes normally
    });
    expect(screen.getByTestId('rows')).toHaveTextContent('t1');

    await act(async () => {
      h.gates[2].resolve(['t2']); // newer lands second, must still write
    });

    expect(screen.getByTestId('rows')).toHaveTextContent('t2');
    expect(isStale(h.cache, 'c7')).toBe(false);
    expect(snapshot().responseConflicts).toBe(0);
  });
});

describe('8 — invalidate is not an intervening write', () => {
  it('a response landing after invalidate() still writes', async () => {
    /*
     * Chosen semantics, and the reason.
     *
     * invalidate() says "this is stale, go and get it again". The request in
     * flight is that fetch. Treating the invalidation as a competing write
     * would refuse the very response it asked for and mark the entry stale
     * again -- fetch, refuse, mark stale, fetch. It changes `fetchedAt`, never
     * `data`, so there is no local state for a response to destroy, which is
     * what the guard exists to protect.
     */
    const h = mount('c8');
    await settleFirstLoad(h, ['alice']);

    act(() => void h.res.refresh());
    act(() => h.cache.invalidate('c8'));
    expect(isStale(h.cache, 'c8')).toBe(true);

    await act(async () => {
      h.gates[1].resolve(['alice', 'bob']);
    });

    expect(screen.getByTestId('rows')).toHaveTextContent('alice,bob');
    expect(isStale(h.cache, 'c8')).toBe(false);
    expect(snapshot().responseConflicts).toBe(0);
  });

  it('but invalidate followed by a real write is still protected', async () => {
    const h = mount('c8b');
    await settleFirstLoad(h, ['alice']);

    act(() => void h.res.refresh());
    act(() => h.cache.invalidate('c8b'));
    act(() => {
      h.cache.update<string[]>('c8b', () => ['confirmed'], h.cache.beginWrite());
    });

    await act(async () => {
      h.gates[1].resolve(['alice']);
    });

    expect(screen.getByTestId('rows')).toHaveTextContent('confirmed');
  });
});

describe('9 — a socket event stays authoritative', () => {
  it('is not overwritten by a GET that predates it', async () => {
    // Socket events reach the cache through the same `update`, so they are
    // protected by the same rule. The direction matters: the event is the
    // newest server state, and the GET is an older read of the same thing --
    // the event wins, and the entry is marked stale so the next read
    // reconciles rather than sitting on an unverified patch.
    const h = mount('c9');
    await settleFirstLoad(h, ['alice']);

    act(() => void h.res.refresh()); // in flight when the event arrives
    act(() => {
      // What ClubDetailView's socket handlers do: patch from the payload.
      h.cache.update<string[]>('c9', (p) => [...(p ?? []), 'from-socket'], h.cache.beginWrite());
    });

    await act(async () => {
      h.gates[1].resolve(['alice']); // server read taken before the event
    });

    expect(screen.getByTestId('rows')).toHaveTextContent('alice,from-socket');
    expect(isStale(h.cache, 'c9')).toBe(true);
  });
});

describe('11 — a rollback is protected by the write it undoes', () => {
  /*
   * `restore` does not bump `writeSeq`, and does not need to.
   *
   * Every rollback in this codebase is the second half of one sequence on one
   * key -- snapshot, update, and restore only if the mutation threw. Both
   * production sites are shaped that way (the dashboard's join decision and
   * the club's buy-in decision). The `update` in the middle bumps `writeSeq`,
   * so any request issued before the user acted is already disqualified by the
   * time the rollback runs: the rollback inherits the protection of the write
   * it is undoing.
   *
   * The invariant is therefore "restore is unreachable without a preceding
   * update on the same key". These two tests exist because that is an
   * invariant of the CALLERS, not of the cache -- a future rollback written
   * without an optimistic write in front of it would be unprotected, and
   * nothing else in the suite would notice.
   */
  it('survives a GET issued before the optimistic write', async () => {
    const h = mount('c11');
    await settleFirstLoad(h, ['alice', 'bob']);
    const previous = h.cache.snapshot<string[]>('c11');

    act(() => void h.res.refresh()); // poll already open when the user acts
    act(() => {
      h.cache.update<string[]>('c11', (p) => (p ?? []).filter((x) => x !== 'alice'), h.cache.beginWrite());
    });
    act(() => h.cache.restore('c11', previous)); // the mutation threw

    await act(async () => {
      h.gates[1].resolve(['stale', 'body']);
    });

    expect(screen.getByTestId('rows')).toHaveTextContent('alice,bob');
    expect(isStale(h.cache, 'c11')).toBe(true);
  });

  it('but a GET issued after the write is still allowed to win', async () => {
    // Deliberate, and the boundary of the rule above. This request was issued
    // after the user acted, and the mutation it raced against failed -- so the
    // server never changed and this body is at least as current as the snapshot
    // being restored. Refusing it would cost a round trip to learn nothing.
    const h = mount('c11b');
    await settleFirstLoad(h, ['alice', 'bob']);
    const previous = h.cache.snapshot<string[]>('c11b');

    act(() => {
      h.cache.update<string[]>('c11b', (p) => (p ?? []).filter((x) => x !== 'alice'), h.cache.beginWrite());
    });
    act(() => void h.res.refresh()); // issued AFTER the optimistic write
    act(() => h.cache.restore('c11b', previous));

    await act(async () => {
      h.gates[1].resolve(['server', 'truth']);
    });

    expect(screen.getByTestId('rows')).toHaveTextContent('server,truth');
    expect(isStale(h.cache, 'c11b')).toBe(false);
  });
});

describe('10 — identity protection is unchanged', () => {
  it('a write authorised by a departed identity is still refused', async () => {
    const h = mount('c10');
    await settleFirstLoad(h, ['alice']);

    const tokenA = h.cache.beginWrite();
    act(() => h.cache.clear());

    act(() => {
      h.cache.update<string[]>('c10', () => ['from-user-a'], tokenA);
    });
    expect(h.cache.getEntry('c10').data).toBeUndefined();

    act(() => {
      h.cache.update<string[]>('c10', () => ['from-user-b'], h.cache.beginWrite());
    });
    expect(h.cache.getEntry('c10').data).toEqual(['from-user-b']);
  });
});
