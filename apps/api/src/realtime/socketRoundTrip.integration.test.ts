import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { prisma } from '../lib/prisma.js';
import { signAccessToken } from '../utils/jwt.js';
import { initSocket, emitToClub, disconnectAllSockets } from './socket.js';

/**
 * A second browser actually receives it.
 *
 * Everything else about realtime is tested one layer at a time: the service
 * emits (socketPayloads.integration.test.ts, which mocks emitToClub), and the
 * screen subscribes (ClubDetailView.realtime.test.ts, which greps). Both passed
 * throughout a period when no live update reached any user in production,
 * because neither of them ever opened a socket.
 *
 * The production fault was in the deployment config rather than in this code —
 * `/socket.io` was not forwarded, so the handshake returned the HTML shell and
 * engine.io never connected. deploy-proxy-parity.test.ts guards that file. This
 * guards the thing that file assumes: that once bytes can flow, a mutation on
 * one connection genuinely arrives on another.
 *
 * Two real clients, one real server, no mocks in between.
 *
 * Requires a database (the room check reads club membership). Excluded from
 * `npm test`; run with `npm run test:integration`.
 */

let httpServer: HttpServer;
let port = 0;
let clubId = '';
let memberId = '';
let outsiderId = '';
const createdUsers: string[] = [];
const openSockets: ClientSocket[] = [];

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Connects, waits for the handshake, and fails loudly rather than hanging. */
function open(userId: string): Promise<ClientSocket> {
  const socket = connect(`http://localhost:${port}`, {
    path: '/socket.io',
    auth: {
      token: signAccessToken({
        sub: userId,
        email: `${userId}@test.local`,
        displayName: 'RT',
        isSuperAdmin: false,
      }),
    },
    transports: ['websocket'],
    reconnection: false,
  });
  openSockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (e) => reject(new Error(`connect_error: ${e.message}`)));
    setTimeout(() => reject(new Error('socket never connected')), 4000);
  });
}

/** Resolves with the ack, so a refused join is a value rather than a timeout. */
const joinClub = (socket: ClientSocket, id: string) =>
  new Promise<{ ok: boolean }>((resolve) => socket.emit('club:join', id, resolve));

/** The next event of this name, or null once the window closes. */
function nextEvent<T = unknown>(socket: ClientSocket, event: string, ms = 1500): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

beforeAll(async () => {
  httpServer = createServer();
  initSocket(httpServer);
  await new Promise<void>((r) => httpServer.listen(0, r));
  port = (httpServer.address() as { port: number }).port;
});

afterAll(async () => {
  disconnectAllSockets();
  await new Promise<void>((r) => httpServer.close(() => r()));
});

beforeEach(async () => {
  const s = stamp();
  const owner = await prisma.user.create({
    data: { email: `rt-owner-${s}@test.local`, passwordHash: 'x', displayName: 'RT Owner' },
  });
  const outsider = await prisma.user.create({
    data: { email: `rt-out-${s}@test.local`, passwordHash: 'x', displayName: 'RT Outsider' },
  });
  memberId = owner.id;
  outsiderId = outsider.id;
  createdUsers.push(owner.id, outsider.id);

  const club = await prisma.club.create({
    data: {
      name: `RT ${s}`,
      code: `RT${s}`.slice(0, 20),
      ownerId: owner.id,
      members: { create: [{ userId: owner.id }] },
    },
  });
  clubId = club.id;
});

afterEach(async () => {
  openSockets.splice(0).forEach((s) => s.disconnect());
  if (clubId) {
    await prisma.clubMember.deleteMany({ where: { clubId } });
    await prisma.club.deleteMany({ where: { id: clubId } });
  }
  await prisma.user.deleteMany({ where: { id: { in: createdUsers.splice(0) } } });
  clubId = '';
});

describe('an event emitted on the server arrives at a connected client', () => {
  it('reaches a client that has joined the club room', async () => {
    const client = await open(memberId);
    expect(await joinClub(client, clubId)).toEqual({ ok: true });

    const received = nextEvent(client, 'club:buyin-requested');
    emitToClub(clubId, 'club:buyin-requested', { hello: 'table' });

    expect(await received).toEqual({ hello: 'table' });
  });

  it('reaches BOTH clients watching the same club', async () => {
    // The actual reported bug: one user acts, the other never sees it.
    const [a, b] = await Promise.all([open(memberId), open(memberId)]);
    await Promise.all([joinClub(a, clubId), joinClub(b, clubId)]);

    const both = Promise.all([
      nextEvent(a, 'club:sitin-decided'),
      nextEvent(b, 'club:sitin-decided'),
    ]);
    emitToClub(clubId, 'club:sitin-decided', { seat: 3 });

    expect(await both).toEqual([{ seat: 3 }, { seat: 3 }]);
  });

  it('carries the payload intact rather than a bare notification', async () => {
    const client = await open(memberId);
    await joinClub(client, clubId);

    const session = { id: 's1', activePlayerUids: ['a', 'b'], settlingAt: null };
    const received = nextEvent<{ session: typeof session }>(client, 'club:settling-started');
    emitToClub(clubId, 'club:settling-started', { sessionId: 's1', session });

    expect((await received)?.session).toEqual(session);
  });

  it('does not reach a client that never joined the room', async () => {
    const client = await open(memberId);
    // Connected and authenticated, but no club:join.

    const received = nextEvent(client, 'club:buyin-requested', 600);
    emitToClub(clubId, 'club:buyin-requested', { hello: 'table' });

    expect(await received).toBeNull();
  });

  it('refuses the room to somebody who is not in the club, and says so', async () => {
    const client = await open(outsiderId);

    const denied = nextEvent<{ room: string }>(client, 'room:denied');
    const ack = await joinClub(client, clubId);

    expect(ack).toEqual({ ok: false, error: 'Not a member of this club' });
    expect((await denied)?.room).toBe(`club:${clubId}`);
  });

  it('delivers nothing to a non-member even when they are connected', async () => {
    const outsider = await open(outsiderId);
    await joinClub(outsider, clubId); // refused

    const received = nextEvent(outsider, 'club:buyin-requested', 600);
    emitToClub(clubId, 'club:buyin-requested', { hello: 'table' });

    expect(await received).toBeNull();
  });

  it('refuses a connection with no token at all', async () => {
    const socket = connect(`http://localhost:${port}`, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
    });
    openSockets.push(socket);

    const error = await new Promise<string>((resolve) => {
      socket.on('connect_error', (e) => resolve(e.message));
      socket.on('connect', () => resolve('CONNECTED — should not have'));
      setTimeout(() => resolve('timed out'), 4000);
    });

    expect(error).toMatch(/missing access token/i);
  });

  it('stops delivering once the client leaves the room', async () => {
    const client = await open(memberId);
    await joinClub(client, clubId);
    client.emit('club:leave', clubId);
    // The leave is processed server-side; give it the round trip.
    await new Promise((r) => setTimeout(r, 150));

    const received = nextEvent(client, 'club:buyin-requested', 600);
    emitToClub(clubId, 'club:buyin-requested', { hello: 'table' });

    expect(await received).toBeNull();
  });
});
