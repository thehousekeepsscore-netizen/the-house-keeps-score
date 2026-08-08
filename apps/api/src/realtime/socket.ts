import type { Server as HttpServer } from 'node:http';
import { Server, Socket } from 'socket.io';
import { env } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { verifyAccessToken } from '../utils/jwt.js';

let io: Server | null = null;

interface SocketData {
  userId: string;
  isSuperAdmin: boolean;
}

/**
 * May this user listen to this club's live stream?
 *
 * Owner, admin or member. Super-admins pass, matching every other authorisation
 * check in the codebase.
 *
 * Queried rather than read off the token because roles change during a session:
 * a token minted while someone was a member stays valid after they are removed,
 * so trusting it would let a removed player keep listening until their token
 * expired. Joins happen on mount and on reconnect, not per event, so this is one
 * indexed lookup at the start of a subscription rather than a per-message cost.
 */
export async function canJoinClub(clubId: string, data: SocketData): Promise<boolean> {
  if (data.isSuperAdmin) return true;
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: {
      ownerId: true,
      admins: { where: { userId: data.userId }, select: { userId: true } },
      members: { where: { userId: data.userId }, select: { userId: true } },
    },
  });
  if (!club) return false;
  return club.ownerId === data.userId || club.admins.length > 0 || club.members.length > 0;
}

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
  });

  io.use((socket: Socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error('Missing access token'));
      const payload = verifyAccessToken(token);
      const data = socket.data as SocketData;
      data.userId = payload.sub;
      data.isSuperAdmin = payload.isSuperAdmin === true;
      next();
    } catch {
      next(new Error('Invalid or expired access token'));
    }
  });

  io.on('connection', (socket) => {
    const data = socket.data as SocketData;

    // A refusal is announced rather than silent. Without this the client sits in
    // a room it never joined, showing a table that simply never updates — the
    // same failure mode as a dropped socket, which this app already treats as
    // serious enough to surface in the header.
    const deny = (room: string, ack?: (r: unknown) => void) => {
      ack?.({ ok: false, error: 'Not a member of this club' });
      socket.emit('room:denied', { room });
    };

    /*
     * Socket.IO does not catch a rejection from an async handler.
     *
     * Express routes have asyncHandler for exactly this; these had nothing, so
     * a throw inside a join went nowhere, became an unhandledRejection, and the
     * process-level handler in index.ts shut the API down. One failed query
     * took the whole server with it — and because every reconnect retries the
     * join, the restart walked straight back into the same query, which is a
     * crash loop rather than an incident.
     *
     * The failure that found it was `FATAL: max clients reached in session
     * mode` — the database refusing a connection under load. That is a
     * transient, entirely expected condition, and the right response to it is
     * to refuse this one join, not to end the night for everybody at the table.
     *
     * A join that fails for an unknown reason is denied rather than silently
     * dropped: the client already handles a denial, and a promise that neither
     * resolves nor rejects leaves it waiting forever for a room it will never
     * be in.
     */
    const guard =
      <A>(handler: (arg: A, ack?: (r: unknown) => void) => Promise<void>) =>
      (arg: A, ack?: (r: unknown) => void) => {
        handler(arg, ack).catch((err) => {
          console.error('[socket] join failed:', err);
          ack?.({ ok: false, error: 'Could not join right now' });
        });
      };

    socket.on(
      'session:join',
      guard(async (sessionId: string, ack) => {
        if (typeof sessionId !== 'string') return;
        // A session is only as private as its club, so the club's rule governs.
        const session = await prisma.pokerSession.findUnique({
          where: { id: sessionId },
          select: { clubId: true },
        });
        if (!session || !(await canJoinClub(session.clubId, data))) return deny(`session:${sessionId}`, ack);
        socket.join(`session:${sessionId}`);
        ack?.({ ok: true });
      })
    );
    socket.on('session:leave', (sessionId: string) => {
      if (typeof sessionId === 'string') socket.leave(`session:${sessionId}`);
    });
    socket.on(
      'club:join',
      guard(async (clubId: string, ack) => {
        if (typeof clubId !== 'string') return;
        if (!(await canJoinClub(clubId, data))) return deny(`club:${clubId}`, ack);
        socket.join(`club:${clubId}`);
        ack?.({ ok: true });
      })
    );
    // Leaving needs no check: a socket can only leave a room it is in, and
    // leaving a room it is not in is a no-op.
    socket.on('club:leave', (clubId: string) => {
      if (typeof clubId === 'string') socket.leave(`club:${clubId}`);
    });
  });

  return io;
}

/**
 * Disconnect every live socket, leaving the HTTP server for the caller to close.
 *
 * Called during shutdown. An open WebSocket is a live connection as far as node
 * is concerned, so http.close() waits on it forever -- without this the
 * graceful shutdown would always hit its timeout and become an ungraceful one.
 *
 * Deliberately not io.close(). That closes the HTTP server Socket.IO is
 * attached to as a side effect, so the shutdown sequence's own httpServer.close()
 * then threw ERR_SERVER_NOT_RUNNING and the process exited 1 -- reporting a
 * failed shutdown to the platform for a shutdown that had actually succeeded.
 * Disconnecting the sockets achieves the same thing and leaves ownership of the
 * HTTP server in one place.
 */
export function disconnectAllSockets(): void {
  if (!io) return;
  io.disconnectSockets(true);
  io.removeAllListeners();
  io = null;
}

export function emitToSession(sessionId: string, event: string, payload: unknown) {
  io?.to(`session:${sessionId}`).emit(event, payload);
}

// Hole cards must never be broadcast to every seat verbatim — each socket
// gets its own view, built by buildPayloadForUser from that socket's
// authenticated userId (set during the handshake auth check above).
export async function emitToSessionPerUser(
  sessionId: string,
  event: string,
  buildPayloadForUser: (viewerUid: string | undefined) => unknown
) {
  if (!io) return;
  const sockets = await io.in(`session:${sessionId}`).fetchSockets();
  for (const socket of sockets) {
    const viewerUid = (socket.data as { userId?: string }).userId;
    socket.emit(event, buildPayloadForUser(viewerUid));
  }
}

export function emitToClub(clubId: string, event: string, payload: unknown) {
  io?.to(`club:${clubId}`).emit(event, payload);
}
