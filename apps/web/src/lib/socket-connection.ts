import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';

/**
 * What this client actually knows about its live connection.
 *
 * The socket is a module-level singleton that outlives every view, so a screen
 * mounting cannot assume anything about it: it may be connected already, still
 * opening, dropped, or dead. The previous flag initialised to `true` and so
 * reported "live" for a socket that had never connected once — the failure this
 * type exists to make unrepresentable.
 *
 * Four states rather than a boolean because they need different handling:
 *
 *   never-connected  Opening for the first time. Not yet a problem.
 *   connected        Events are arriving.
 *   disconnected     Dropped, and the client is retrying on its own.
 *   auth-error       The server refused the handshake. Terminal — see below.
 *
 * `auth-error` is separated from `disconnected` because socket.io-client treats
 * the two completely differently. A transport failure keeps the manager's
 * subscriptions and retries with the configured defaults (infinite attempts,
 * backoff capped at 5s). A middleware rejection calls `destroy()`, which clears
 * those subscriptions — the library's own comment reads "clean subscriptions to
 * avoid reconnections" — so `socket.active` becomes false and **nothing will
 * retry**. Reporting that as "reconnecting" would promise a recovery that is
 * never coming.
 */
export type SocketConnectionState = 'never-connected' | 'connected' | 'disconnected' | 'auth-error';

export interface SocketConnection {
  state: SocketConnectionState;
  /**
   * The server's own rejection text — `Missing access token`, `Invalid or
   * expired access token`. Kept so the cause stays observable in diagnostics;
   * it is not the copy shown to a player.
   */
  message: string | null;
}

export type SocketConnectionEvent =
  | { type: 'connect' }
  | { type: 'disconnect' }
  /** `willRetry` is `socket.active` at the moment the error arrived. */
  | { type: 'connect_error'; willRetry: boolean; message: string };

/**
 * Read from the socket rather than assumed. `connected` is the only honest
 * starting point for a connection this view did not open.
 */
export function initialSocketConnection(connected: boolean): SocketConnection {
  return { state: connected ? 'connected' : 'never-connected', message: null };
}

/** Pure, so the transitions can be tested without a socket or a component. */
export function reduceSocketConnection(
  current: SocketConnection,
  event: SocketConnectionEvent
): SocketConnection {
  switch (event.type) {
    case 'connect':
      // Recovery clears the diagnostic: whatever went wrong is no longer true.
      return { state: 'connected', message: null };

    case 'disconnect':
      // A refused handshake is terminal, and a later stray disconnect must not
      // quietly downgrade it to the retrying state — that would restore exactly
      // the false promise this type exists to prevent.
      if (current.state === 'auth-error') return current;
      return { state: 'disconnected', message: null };

    case 'connect_error':
      return event.willRetry
        ? { state: 'disconnected', message: event.message }
        : { state: 'auth-error', message: event.message };
  }
}

/**
 * Tracks one socket's connection state.
 *
 * Deliberately owns nothing but state. The existing `connect` → `resync()`
 * behaviour stays where it already lives; this adds its own listeners
 * alongside it rather than taking that over.
 */
export function useSocketConnection(socket: Socket): SocketConnection {
  const [connection, setConnection] = useState<SocketConnection>(() =>
    initialSocketConnection(socket.connected)
  );

  useEffect(() => {
    const apply = (event: SocketConnectionEvent) =>
      setConnection((current) => reduceSocketConnection(current, event));

    const onConnect = () => apply({ type: 'connect' });
    const onDisconnect = () => apply({ type: 'disconnect' });
    const onConnectError = (error: Error) =>
      apply({
        type: 'connect_error',
        // False for a rejected handshake, true while the client is still
        // retrying a transport failure.
        willRetry: socket.active,
        message: error?.message ?? 'Connection refused',
      });

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);

    // The socket is shared and long-lived, so it can connect between the render
    // that read `socket.connected` and this effect attaching — in which case
    // 'connect' already fired and was missed.
    if (socket.connected) onConnect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
    };
  }, [socket]);

  return connection;
}
