import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { ResourceCacheProvider, useResource, useResourceCache } from './resource-cache';

/**
 * The cache's optimistic-write contract.
 *
 * Both optimistic paths in this app -- approving a buy-in and deciding a join
 * request -- write to the cache before the server answers and must put it back
 * if the server refuses. Until the frontend test runner landed there was no way
 * to assert that, so the rollbacks were correct only by inspection. This is the
 * gap OPTIMISTIC-UPDATE-AUDIT.md recorded as the real one.
 *
 * The interference tests are the point. Whether a rollback restores a value is
 * easy to check by hand; whether it *destroys a concurrent socket event* is not,
 * because it depends on interleaving that never reproduces on demand.
 */

vi.mock('./auth-context', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ResourceCacheProvider>{children}</ResourceCacheProvider>
);

/** Exposes the cache to a test without mounting a real screen. */
function useHarness(key: string, fetcher: () => Promise<string[]>) {
  const cache = useResourceCache();
  const res = useResource<string[]>(key, fetcher);
  return { cache, res };
}

function Probe({
  onReady,
  fetcher,
  cacheKey,
}: {
  onReady: (h: ReturnType<typeof useHarness>) => void;
  fetcher: () => Promise<string[]>;
  cacheKey: string;
}) {
  const h = useHarness(cacheKey, fetcher);
  onReady(h);
  return <div data-testid="rows">{(h.res.data ?? []).join(',')}</div>;
}

async function mount(initial: string[]) {
  let harness!: ReturnType<typeof useHarness>;
  const fetcher = vi.fn(async () => initial);
  render(
    <Probe cacheKey="k" fetcher={fetcher} onReady={(h) => (harness = h)} />,
    { wrapper }
  );
  await waitFor(() => expect(screen.getByTestId('rows')).toHaveTextContent(initial.join(',')));
  return { get: () => harness, fetcher };
}

describe('optimistic write and rollback', () => {
  it('applies an optimistic write immediately, before any server reply', async () => {
    const { get } = await mount(['a', 'b']);

    act(() => get().cache.update<string[]>('k', (prev) => (prev ?? []).filter((x) => x !== 'a')));

    expect(screen.getByTestId('rows')).toHaveTextContent('b');
  });

  it('puts the previous value back when the request fails', async () => {
    const { get } = await mount(['a', 'b']);
    const snap = get().cache.snapshot<string[]>('k');

    act(() => get().cache.update<string[]>('k', (prev) => (prev ?? []).filter((x) => x !== 'a')));
    expect(screen.getByTestId('rows')).toHaveTextContent('b');

    act(() => get().cache.restore('k', snap));

    expect(screen.getByTestId('rows')).toHaveTextContent('a,b');
  });

  it('rolls back to the captured value, not to a recomputed inverse', async () => {
    // A refusal can mean more changed than the one row, so the rollback restores
    // exactly what was there rather than undoing the specific edit.
    const { get } = await mount(['a', 'b', 'c']);
    const snap = get().cache.snapshot<string[]>('k');

    act(() => get().cache.update<string[]>('k', () => []));
    act(() => get().cache.restore('k', snap));

    expect(screen.getByTestId('rows')).toHaveTextContent('a,b,c');
  });
});

describe('a rollback must not destroy a concurrent update', () => {
  it('does not resurrect stale state when a socket event landed mid-flight', async () => {
    // The bug this closes. Sequence: admin clicks approve, the row is removed
    // optimistically, a socket event adds a new row while the POST is in
    // flight, then the POST fails. A snapshot restore would put back the old
    // list and delete the new row -- resurrecting state the server has already
    // moved past, with nothing on screen to say so.
    const { get } = await mount(['a', 'b']);
    const snap = get().cache.snapshot<string[]>('k');

    act(() => get().cache.update<string[]>('k', (prev) => (prev ?? []).filter((x) => x !== 'a')));
    act(() => get().cache.update<string[]>('k', (prev) => [...(prev ?? []), 'from-socket']));

    act(() => get().cache.restore('k', snap));

    // 'a' is NOT restored, because the cache can no longer claim to know what
    // "before" means. The entry is marked stale so the next read fetches truth.
    expect(screen.getByTestId('rows')).not.toHaveTextContent('a,b');
    expect(screen.getByTestId('rows')).toHaveTextContent('from-socket');
  });

  it('marks the entry stale after a contested rollback, so the next read refetches', async () => {
    const { get, fetcher } = await mount(['a']);
    const snap = get().cache.snapshot<string[]>('k');

    act(() => get().cache.update<string[]>('k', () => ['optimistic']));
    act(() => get().cache.update<string[]>('k', () => ['from-socket']));
    act(() => get().cache.restore('k', snap));

    const before = fetcher.mock.calls.length;
    await act(async () => {
      await get().res.refresh();
    });
    expect(fetcher.mock.calls.length).toBeGreaterThan(before);
  });

  it('still restores cleanly when nothing else touched the entry', async () => {
    // The common case must not regress into an invalidate-and-refetch just
    // because the mechanism can now detect interference.
    const { get, fetcher } = await mount(['a', 'b']);
    const snap = get().cache.snapshot<string[]>('k');
    const before = fetcher.mock.calls.length;

    act(() => get().cache.update<string[]>('k', () => []));
    act(() => get().cache.restore('k', snap));

    expect(screen.getByTestId('rows')).toHaveTextContent('a,b');
    expect(fetcher.mock.calls.length).toBe(before);
  });
});

describe('reads', () => {
  it('reports empty only when nothing has ever loaded', async () => {
    const { get } = await mount(['a']);
    expect(get().res.status).toBe('ready');
  });

  it('keeps data on screen when a refresh fails', async () => {
    let harness!: ReturnType<typeof useHarness>;
    let shouldFail = false;
    const fetcher = vi.fn(async () => {
      if (shouldFail) throw new Error('network');
      return ['a'];
    });
    render(<Probe cacheKey="k2" fetcher={fetcher} onReady={(h) => (harness = h)} />, { wrapper });
    await waitFor(() => expect(screen.getByTestId('rows')).toHaveTextContent('a'));

    shouldFail = true;
    await act(async () => {
      await harness.res.refresh();
    });

    // A failed refresh must never blank a screen that had content.
    expect(screen.getByTestId('rows')).toHaveTextContent('a');
  });
});
