/**
 * One refetch cycle per return to the app, not two or three.
 *
 * The club screen refetches everything the room could have changed on two
 * triggers: the user coming back to the app (a resume), and the socket
 * (re)connecting. On a phone that was locked the two arrive together — the
 * transport died while the screen was off, so the resume finds the socket
 * down, socket.io reconnects about a second later, and `connect` fires. Measured
 * on the production bundle, that is the same ten requests twice, 1.3 seconds
 * apart, from every phone at the table.
 *
 * Suppressing the second pass would be wrong: the socket was down between the
 * first refetch and the reconnect, so anything the room emitted in that window
 * is lost, and the reconnect's refetch is what recovers it. The rule here
 * instead moves the ONE refetch to where it covers everything:
 *
 *   - Resume with the socket claiming connected: refetch now. That claim can be
 *     a lie (see use-foreground-recovery.ts), which is exactly why the resume
 *     must never wait on the socket in this case. If the liveness probe later
 *     proves the lie and forces a reconnect, `connect` refetches again — a
 *     second cycle that is legitimate, because the first ran over a dead socket.
 *   - Resume with the socket admitting it is down: do not refetch yet. The
 *     recovery hook has already asked it to reconnect, and the refetch that
 *     `connect` triggers covers the whole gap. A bounded fallback refetches over
 *     HTTP anyway if no `connect` arrives, so a phone that is still offline gets
 *     the same stale-but-correcting behaviour it always had.
 *   - `connect`: refetch, unless a refetch started moments ago — socket.io can
 *     fire `connect` twice in quick succession, and each must not cost a pass.
 *
 * Room re-joining is deliberately NOT here. It is cheap, it is required on every
 * `connect` (rooms live on the connection), and it doubles as the liveness
 * probe; the caller does it on every trigger, unchanged.
 */

/**
 * How long a known-down socket is given to come back before the resume
 * refetches over HTTP regardless. socket.io's first retry lands at about a
 * second (1.3 s measured); the liveness probe waits three. Sharing the probe's
 * figure means there is one notion of "too long to wait" on this screen.
 */
export const RESUME_REFETCH_FALLBACK_MS = 3000;

/**
 * A `connect` this soon after a refetch began is a duplicate firing, not a new
 * connection worth a pass. Well under the probe timeout, so a probe-forced
 * reconnect (which arrives after three seconds) is never mistaken for one.
 */
export const CONNECT_DUPLICATE_GUARD_MS = 500;

export interface ResyncCoalescerOptions {
  /** Whether the socket currently claims to be connected. Read at trigger time. */
  isConnected: () => boolean;
  /** The full refetch. Called at most once per effective cycle. */
  refetch: () => void;
  /** Clock, for tests. Wall-clock milliseconds. */
  now?: () => number;
}

export interface ResyncCoalescer {
  /** The user returned to the app. */
  onResume: () => void;
  /** The socket (re)connected. */
  onConnect: () => void;
  /** Cancel any pending fallback. Call on unmount. */
  dispose: () => void;
}

export function createResyncCoalescer({
  isConnected,
  refetch,
  now = () => Date.now(),
}: ResyncCoalescerOptions): ResyncCoalescer {
  let lastRefetchAt = Number.NEGATIVE_INFINITY;
  let fallback: ReturnType<typeof setTimeout> | null = null;

  const clearFallback = () => {
    if (fallback !== null) {
      clearTimeout(fallback);
      fallback = null;
    }
  };

  const run = () => {
    lastRefetchAt = now();
    refetch();
  };

  return {
    onResume() {
      if (isConnected()) {
        clearFallback();
        run();
        return;
      }
      // Keep the earliest deadline: a second resume while still down must not
      // push the fallback further out.
      if (fallback !== null) return;
      fallback = setTimeout(() => {
        fallback = null;
        run();
      }, RESUME_REFETCH_FALLBACK_MS);
    },
    onConnect() {
      clearFallback();
      if (now() - lastRefetchAt < CONNECT_DUPLICATE_GUARD_MS) return;
      run();
    },
    dispose: clearFallback,
  };
}
