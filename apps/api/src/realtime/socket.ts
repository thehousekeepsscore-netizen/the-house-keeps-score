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

    socket.on('session:join', async (sessionId: string, ack?: (r: unknown) => void) => {
      if (typeof sessionId !== 'string') return;
      // A session is only as private as its club, so the club's rule governs.
      const session = await prisma.pokerSession.findUnique({
        where: { id: sessionId },
        select: { clubId: true },
      });
      if (!session || !(await canJoinClub(session.clubId, data))) return deny(`session:${sessionId}`, ack);
      socket.join(`session:${sessionId}`);
      ack?.({ ok: true });
    });
    socket.on('session:leave', (sessionId: string) => {
      if (typeof sessionId === 'string') socket.leave(`session:${sessionId}`);
    });
    socket.on('club:join', async (clubId: string, ack?: (r: unknown) => void) => {
      if (typeof clubId !== 'string') return;
      if (!(await canJoinClub(clubId, data))) return deny(`club:${clubId}`, ack);
      socket.join(`club:${clubId}`);
      ack?.({ ok: true });
    });
    // Leaving needs no check: a socket can only leave a room it is in, and
    // leaving a room it is not in is a no-op.
    socket.on('club:leave', (clubId: string) => {
      if (typeof clubId === 'string') socket.leave(`club:${clubId}`);
    });
  });

  return io;
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
