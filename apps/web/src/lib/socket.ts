import { io, Socket } from 'socket.io-client';
import { accessTokenExpiresWithin, getAccessToken, refreshAccessToken } from './api-client';
import { resolveSocketOrigin } from './socket-origin';

let socket: Socket | null = null;

/**
 * Which socket a late asynchronous answer belongs to.
 *
 * The handshake's auth callback may now wait on a token refresh. If the
 * socket is torn down meanwhile (a sign-out, a change of identity) and a new
 * one built, the old answer must not complete a handshake for a socket that no
 * longer exists, nor for the new one under the old identity. Bumped on every
 * construction; an answer checks it before speaking.
 */
let generation = 0;

/**
 * How close to expiry a token may be and still be sent in a handshake.
 *
 * A refresh and a handshake together take a round trip or two, so anything
 * under that would send a token that expires in flight. Thirty seconds is
 * comfortably above it and, against a fifteen-minute lifetime, changes how
 * often a refresh happens by nothing worth measuring.
 */
export const HANDSHAKE_TOKEN_MARGIN_MS = 30_000;

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
    const mine = ++generation;
    const created = io(resolveSocketOrigin(import.meta.env.VITE_SOCKET_URL), {
      path: '/socket.io',
      /*
       * Answered asynchronously when the token needs refreshing first.
       *
       * The handshake used to send whatever token was in memory. After a
       * quarter of an hour idle that token has expired, and the reconnect that
       * follows a screen unlock raced the HTTP refresh the resume also
       * triggers — the handshake usually lost. The server refused it, the
       * client library made the refusal terminal, and the device sat with no
       * live updates until somebody reloaded. Production showed an iPad in
       * exactly that state for fifty-two minutes, missing every approval.
       *
       * socket.io-client sends its CONNECT packet only when this callback is
       * invoked, so waiting here is supported. The callback is ALWAYS
       * invoked: a refresh that fails still answers with the best token there
       * is, and the server's refusal then flows through the existing state
       * handling rather than leaving the handshake hanging.
       */
      auth: (cb) => {
        void supplyHandshakeToken(mine, cb);
      },
      autoConnect: true,
    });

    /*
     * One bounded recovery from a refused handshake.
     *
     * A middleware refusal makes socket.io-client stop retrying on its own —
     * `active` becomes false — which is right for a genuinely dead session and
     * wrong for a token that merely expired. So a refusal gets exactly one
     * refresh; if that yields a token, one connect(); if it does not, the
     * socket stays refused and the screen keeps saying so. The guard resets
     * only on a successful connect, so a refreshed token that is refused again
     * stops here rather than looping refresh → connect → refuse.
     *
     * Transport errors are not touched: `active` stays true and the library
     * is already backing off and retrying them.
     */
    let recoveryUsed = false;
    created.on('connect', () => {
      recoveryUsed = false;
    });
    created.on('connect_error', () => {
      if (created.active) return;
      if (recoveryUsed) return;
      recoveryUsed = true;
      void refreshAccessToken().then((refreshed) => {
        if (!refreshed) return;
        // Torn down while the refresh was in flight: nothing to reconnect.
        if (socket !== created) return;
        created.connect();
      });
    });

    socket = created;
  }
  return socket;
}

/**
 * Answer a handshake with a token the server will accept, refreshing first
 * if the one in memory is missing or about to expire. Never throws, and
 * always answers — unless the socket it was asked for is gone, in which case
 * an answer would be worse than silence.
 */
async function supplyHandshakeToken(mine: number, cb: (data: object) => void): Promise<void> {
  if (accessTokenExpiresWithin(HANDSHAKE_TOKEN_MARGIN_MS)) {
    try {
      // Shared with every HTTP 401 retry and the auth bootstrap, so a resume
      // that is already refreshing does not present the cookie a second time.
      await refreshAccessToken();
    } catch {
      // refreshAccessToken never rejects; this exists so that no future
      // change to it can leave a handshake hanging.
    }
  }
  if (mine !== generation || socket === null) return;
  cb({ token: getAccessToken() });
}
