import { io, Socket } from 'socket.io-client';
import { getAccessToken } from './api-client';
import { resolveSocketOrigin } from './socket-origin';

let socket: Socket | null = null;

/**
 * Tear down the shared socket.
 *
 * A Socket.IO connection authenticates once, at the handshake, and its room
 * memberships live on the server keyed to that connection. Signing out is pure
 * client state in this app -- no page reload -- so without this the socket
 * survived the sign-out still authenticated as the previous user and still
 * joined to their club rooms. The next person to sign in on that tab inherited
 * both: they received live events for clubs they are not in, and the server
 * evaluated their own club:join against the previous user's identity.
 *
 * Called on every change of authenticated identity, not only on sign-out, for
 * the same reason ResourceCacheProvider clears the cache there: two people
 * using one browser must never inherit each other's session.
 */
export function resetSocket(): void {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
}

// Single shared socket for the whole app — components join/leave rooms as
// needed rather than each opening their own connection.
export function getSocket(): Socket {
  if (!socket) {
    socket = io(resolveSocketOrigin(import.meta.env.VITE_SOCKET_URL), {
      path: '/socket.io',
      auth: (cb) => cb({ token: getAccessToken() }),
      autoConnect: true,
    });
  }
  return socket;
}
