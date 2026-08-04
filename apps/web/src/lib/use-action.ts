import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Wraps an async action so it cannot be submitted twice.
 *
 * Every mutation in this app used to be a bare `onClick={() => handler()}` with
 * nothing disabled while the request was in flight. Because nothing on screen
 * changes until the response arrives — and a round trip to the API is roughly
 * 400ms — users reasonably conclude the click did not register and press again.
 * One player pressed Request Buy-in about twenty times and created about twenty
 * rows. An admin approving a join request clicked repeatedly and then saw an
 * error toast *after* the approval had actually succeeded, because the second
 * click hit a server that correctly refused to decide the same request twice.
 *
 * The server-side rules are the real protection and are enforced separately;
 * this is what stops the user generating the duplicates in the first place, and
 * what tells them their click landed.
 *
 * Two details matter:
 *
 *   The guard is a ref, not the `pending` state. Two clicks in the same tick
 *   both run before React re-renders, so a state check would let the second
 *   through. The ref flips synchronously.
 *
 *   Keying. A list of pending join requests renders one button per row; a
 *   single `pending` boolean would disable every row when one is clicked. When
 *   the action's first argument is a string or number — which for row actions
 *   is the id — it is used as the key, so only that row is disabled. Otherwise
 *   all calls share one slot, which is what a lone submit button wants.
 */
export interface UseActionResult<A extends unknown[], R> {
  /** Runs the action unless an identical one is already in flight. */
  run: (...args: A) => Promise<R | undefined>;
  /** True while any invocation is in flight. */
  pending: boolean;
  /** True while the invocation for this key is in flight. Omit the key for "any". */
  isPending: (key?: string | number) => boolean;
}

const GLOBAL_SLOT = '__single__';

function slotFor(args: unknown[]): string {
  const first = args[0];
  return typeof first === 'string' || typeof first === 'number' ? String(first) : GLOBAL_SLOT;
}

export function useAction<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>
): UseActionResult<A, R> {
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());

  // Synchronous guard. `pendingKeys` cannot serve this purpose: React batches
  // state updates, so a rapid double-click would see the same stale value twice.
  const inFlight = useRef<Set<string>>(new Set());

  // Avoids setting state on an unmounted component when a request outlives the
  // screen that started it — settling a session, for instance, navigates away.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    const slot = slotFor(args);
    if (inFlight.current.has(slot)) return undefined;

    inFlight.current.add(slot);
    if (mounted.current) setPendingKeys(new Set(inFlight.current));

    try {
      return await fnRef.current(...args);
    } finally {
      inFlight.current.delete(slot);
      if (mounted.current) setPendingKeys(new Set(inFlight.current));
    }
  }, []);

  const isPending = useCallback(
    (key?: string | number) =>
      key === undefined ? pendingKeys.size > 0 : pendingKeys.has(String(key)),
    [pendingKeys]
  );

  return { run, pending: pendingKeys.size > 0, isPending };
}
