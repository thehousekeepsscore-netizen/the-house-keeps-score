import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';

/**
 * Bring a screen back to the truth when the user returns to the app.
 *
 * The club screen has no polling and no other timer: its only route back to
 * fresh data is a socket event or `connect` → `resync()`. That is fine while the
 * socket is alive, and useless when it is not. An OS that suspends a background
 * tab can leave the connection dead while the client still believes it is up, so
 * no `disconnect` fires, no `connect` follows, and nothing ever refetches. The
 * reported symptom is exactly that: leave the app, come back, and the table stays
 * stale until the browser is manually refreshed.
 *
 * Hence the one rule this hook exists to enforce:
 *
 *   **The refetch runs on every resume, regardless of `socket.connected`.**
 *
 * Writing `if (socket.connected) refetch()` would reintroduce the bug in its
 * entirety, because a socket wrongly reporting `connected` is the leading
 * hypothesis for the failure. `connected` is not evidence that the data is
 * current; it is only evidence about a flag.
 *
 * Reconnecting is treated separately and more cautiously than refetching. A
 * refetch is cheap and self-correcting; a handshake the server has already
 * refused will be refused again, so when the connection failed authentication we
 * refetch over HTTP and leave the socket alone. `apiFetch` refreshes its own
 * access token on a 401, so data still recovers with a dead socket — the screen
 * goes stale-but-correcting rather than stale-forever.
 */
export interface ForegroundRecoveryOptions {
  socket: Socket;
  /**
   * Stage 2's `auth-error`. When the server refused the handshake, socket.io
   * has destroyed the socket and will not retry on its own; reconnecting on
   * every resume would be asking a question already answered.
   */
  authFailed: boolean;
  /** The freshness refetch. Runs on every resume, unconditionally. */
  onResume: () => void;
}

export function useForegroundRecovery({ socket, authFailed, onResume }: ForegroundRecoveryOptions): void {
  // Read through refs so the listener is registered once per socket rather than
  // re-registered whenever a caller passes a new closure — and so both values
  // are read at resume time, which is when they matter, rather than at
  // registration time, when they describe a moment that has passed.
  const onResumeRef = useRef(onResume);
  onResumeRef.current = onResume;
  const authFailedRef = useRef(authFailed);
  authFailedRef.current = authFailed;

  useEffect(() => {
    const onVisibilityChange = () => {
      // Fires for both directions. Going away is not a reason to do anything.
      if (document.visibilityState !== 'visible') return;

      // Nudge the socket only when it is actually down and there is reason to
      // think a handshake could succeed. Deliberately not awaited and not a
      // precondition for what follows.
      if (!authFailedRef.current && !socket.connected) socket.connect();

      // Unconditional, and never behind `socket.connected`. See the note above.
      onResumeRef.current();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [socket]);
}
