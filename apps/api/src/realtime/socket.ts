import type { Server as HttpServer } from 'node:http';
import { Server, Socket } from 'socket.io';
import { env } from '../env.js';
import { verifyAccessToken } from '../utils/jwt.js';

let io: Server | null = null;

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
  });

  io.use((socket: Socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error('Missing access token'));
      const payload = verifyAccessToken(token);
      (socket.data as { userId: string }).userId = payload.sub;
      next();
    } catch {
      next(new Error('Invalid or expired access token'));
    }
  });

  io.on('connection', (socket) => {
    socket.on('session:join', (sessionId: string) => {
      if (typeof sessionId === 'string') socket.join(`session:${sessionId}`);
    });
    socket.on('session:leave', (sessionId: string) => {
      if (typeof sessionId === 'string') socket.leave(`session:${sessionId}`);
    });
    socket.on('club:join', (clubId: string) => {
      if (typeof clubId === 'string') socket.join(`club:${clubId}`);
    });
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
