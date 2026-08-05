import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:http';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { signAccessToken } from '../utils/jwt.js';
import { initSocket, emitToClub } from './socket.js';

/**
 * A socket's identity and rooms belong to the connection, not to the tab.
 *
 * This is the server-side half of the sign-out leak. Signing out in this app is
 * pure client state -- no page reload -- and the client held one shared socket
 * for the lifetime of the document, so the connection outlived the session that
 * opened it. These tests demonstrate the two consequences that made that a
 * security bug rather than an untidiness:
 *
 *   1. a room joined by one identity keeps delivering after that user signs out,
 *      because the server has no idea a sign-out happened;
 *   2. the server evaluates every later join against the identity captured at
 *      the handshake, so the next user is authorised as the previous one.
 *
 * The client-side fix is resetSocket() on identity change. These tests pin the
 * server behaviour that makes the fix necessary, so nobody later "simplifies"
 * the client by reusing the connection again.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

let httpServer: HttpServer;
let url: string;

let clubId = '';
let aliceId: string;
let bobId: string;
let aliceToken: string;
let bobToken: string;
let createdUsers: string[] = [];

const sockets: ClientSocket[] = [];

function connect(token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const s = ioClient(url, { auth: { token }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

/** Joins a room and waits for the server's acknowledgement. */
function join(s: ClientSocket, id: string): Promise<{ ok: boolean }> {
  return new Promise((resolve) => s.emit('club:join', id, resolve));
}

/** Resolves with the next `event`, or null if none arrives within `ms`. */
function nextEvent(s: ClientSocket, event: string, ms = 300): Promise<unknown | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      s.off(event, onEvent);
      resolve(null);
    }, ms);
    const onEvent = (payload: unknown) => {
      clearTimeout(timer);
      s.off(event, onEvent);
      resolve(payload);
    };
    s.on(event, onEvent);
  });
}

beforeAll(async () => {
  httpServer = createServer(app);
  initSocket(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const addr = httpServer.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mk = (role: string) =>
    prisma.user.create({
      data: { email: `sid-${role}-${stamp}@test.local`, passwordHash: 'x', displayName: `Sid ${role}` },
    });

  const [alice, bob] = await Promise.all([mk('alice'), mk('bob')]);
  aliceId = alice.id;
  bobId = bob.id;
  createdUsers = [alice.id, bob.id];

  const tok = (u: { id: string; email: string; displayName: string }) =>
    signAccessToken({ sub: u.id, email: u.email, displayName: u.displayName, isSuperAdmin: false });
  aliceToken = tok(alice);
  bobToken = tok(bob);

  // Alice's club. Bob has no relationship to it at all.
  const club = await prisma.club.create({
    data: {
      name: `Sid Club ${stamp}`,
      code: `SD${stamp}`.slice(0, 20),
      ownerId: alice.id,
      members: { create: [{ userId: alice.id }] },
    },
  });
  clubId = club.id;
});

/** Only ever removes rows this test created. */
afterAll(async () => {
  sockets.forEach((s) => s.close());
  if (clubId) {
    await prisma.clubMember.deleteMany({ where: { clubId } });
    await prisma.club.deleteMany({ where: { id: clubId } });
  }
  if (createdUsers.length) await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('a connection carries the identity it was opened with', () => {
  it('lets a member join and receive their club events', async () => {
    const alice = await connect(aliceToken);
    expect(await join(alice, clubId)).toMatchObject({ ok: true });

    const received = nextEvent(alice, 'club:session-started');
    emitToClub(clubId, 'club:session-started', { sessionId: 'x' });
    expect(await received).toMatchObject({ sessionId: 'x' });
  });

  it('refuses a non-member, so Bob cannot reach the club on his own connection', async () => {
    const bob = await connect(bobToken);
    expect(await join(bob, clubId)).toMatchObject({ ok: false });

    const received = nextEvent(bob, 'club:session-started');
    emitToClub(clubId, 'club:session-started', { sessionId: 'y' });
    expect(await received).toBeNull();
  });

  it('keeps delivering to a room after the user who joined it has signed out', async () => {
    // The leak, demonstrated. The server is never told about a sign-out, so the
    // only thing that can end this subscription is closing the connection --
    // which is exactly what resetSocket() now does on the client.
    const alice = await connect(aliceToken);
    await join(alice, clubId);

    const received = nextEvent(alice, 'club:session-started');
    emitToClub(clubId, 'club:session-started', { sessionId: 'after-signout' });

    expect(await received).toMatchObject({ sessionId: 'after-signout' });
  });

  it('stops delivering once the connection is actually closed', async () => {
    const alice = await connect(aliceToken);
    await join(alice, clubId);
    await new Promise<void>((resolve) => {
      alice.on('disconnect', () => resolve());
      alice.close();
    });

    const late = nextEvent(alice, 'club:session-started');
    emitToClub(clubId, 'club:session-started', { sessionId: 'too-late' });
    expect(await late).toBeNull();
  });

  it('authorises a join against the handshake identity, not the current user', async () => {
    // Bob's own connection is refused (above). On a connection Alice opened, the
    // same request succeeds -- because socket.data.userId is Alice. Reusing one
    // socket across a sign-out therefore hands the next user the previous user's
    // authorisation, not merely their stale data.
    const aliceConnection = await connect(aliceToken);
    expect(await join(aliceConnection, clubId)).toMatchObject({ ok: true });

    const bobConnection = await connect(bobToken);
    expect(await join(bobConnection, clubId)).toMatchObject({ ok: false });
  });
});
