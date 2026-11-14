import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { prisma } from '../lib/prisma.js';
import { signAccessToken } from '../utils/jwt.js';
import { initSocket, emitToClub, disconnectAllSockets } from './socket.js';

/**
 * One event, and each phone's own part of it.
 *
 * A settled night tells every player their own result, and a declined request
 * tells its asker why. Both ride on an event the whole club receives, and a
 * player may read only their own line of a night's results — so the personal
 * part must reach exactly the socket whose authenticated user it belongs to,
 * and must never be in what everybody else is sent.
 *
 * Real sockets, because the claim is about which connection receives which
 * bytes, and a mocked emit cannot be wrong about that.
 *
 * Requires a database (the room check reads club membership). Excluded from
 * `npm test`; run with `npm run test:integration`.
 */

let httpServer: HttpServer;
let port = 0;
let clubId = '';
let aliceId = '';
let bobId = '';
const createdUsers: string[] = [];
const openSockets: ClientSocket[] = [];

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function open(userId: string): Promise<ClientSocket> {
  const socket = connect(`http://localhost:${port}`, {
    path: '/socket.io',
    auth: { token: signAccessToken({ sub: userId, email: `${userId}@test.local`, displayName: 'PE', isSuperAdmin: false }) },
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

const joinClub = (socket: ClientSocket, id: string) =>
  new Promise<{ ok: boolean }>((resolve) => socket.emit('club:join', id, resolve));

/** Every event of this name within the window — so a duplicate is visible. */
function collect<T = unknown>(socket: ClientSocket, event: string, ms = 700): Promise<T[]> {
  return new Promise((resolve) => {
    const seen: T[] = [];
    socket.on(event, (payload: T) => seen.push(payload));
    setTimeout(() => resolve(seen), ms);
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
  const alice = await prisma.user.create({ data: { email: `pe-a-${s}@test.local`, passwordHash: 'x', displayName: 'Alice' } });
  const bob = await prisma.user.create({ data: { email: `pe-b-${s}@test.local`, passwordHash: 'x', displayName: 'Bob' } });
  aliceId = alice.id;
  bobId = bob.id;
  createdUsers.push(alice.id, bob.id);
  const club = await prisma.club.create({
    data: {
      name: `PE ${s}`, code: `PE${s}`.slice(0, 20), ownerId: alice.id,
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
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

describe('an event with a personal part', () => {
  it('gives each viewer their own, and nobody anyone else\'s', async () => {
    const [alice, bob] = await Promise.all([open(aliceId), open(bobId)]);
    await Promise.all([joinClub(alice, clubId), joinClub(bob, clubId)]);
    const nets: Record<string, number> = { [aliceId]: 1800, [bobId]: -1800 };

    const both = Promise.all([collect(alice, 'club:session-settled'), collect(bob, 'club:session-settled')]);
    emitToClub(clubId, 'club:session-settled', { sessionId: 's1', title: 'Friday' }, (uid) => ({ you: { net: nets[uid] } }));

    const [a, b] = await both;
    expect(a).toEqual([{ sessionId: 's1', title: 'Friday', you: { net: 1800 } }]);
    expect(b).toEqual([{ sessionId: 's1', title: 'Friday', you: { net: -1800 } }]);
  });

  it('sends the shared part alone to a viewer with nothing of their own', async () => {
    const [alice, bob] = await Promise.all([open(aliceId), open(bobId)]);
    await Promise.all([joinClub(alice, clubId), joinClub(bob, clubId)]);

    const both = Promise.all([collect(alice, 'club:buyin-decided'), collect(bob, 'club:buyin-decided')]);
    emitToClub(clubId, 'club:buyin-decided', { requestId: 'r1', userId: bobId, approve: false },
      (uid) => (uid === bobId ? { reason: 'Settle up first' } : undefined));

    const [a, b] = await both;
    expect(a).toEqual([{ requestId: 'r1', userId: bobId, approve: false }]);
    expect(JSON.stringify(a)).not.toContain('Settle up first');
    expect(b).toEqual([{ requestId: 'r1', userId: bobId, approve: false, reason: 'Settle up first' }]);
  });

  it('reaches every device the same person has open', async () => {
    const [phone, laptop] = await Promise.all([open(bobId), open(bobId)]);
    await Promise.all([joinClub(phone, clubId), joinClub(laptop, clubId)]);

    const both = Promise.all([collect(phone, 'club:sitin-decided'), collect(laptop, 'club:sitin-decided')]);
    emitToClub(clubId, 'club:sitin-decided', { userId: bobId }, (uid) => (uid === bobId ? { reason: 'Full' } : undefined));

    expect(await both).toEqual([[{ userId: bobId, reason: 'Full' }], [{ userId: bobId, reason: 'Full' }]]);
  });

  it('falls back to the shared part, once, if the personal part cannot be worked out', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [alice, bob] = await Promise.all([open(aliceId), open(bobId)]);
    await Promise.all([joinClub(alice, clubId), joinClub(bob, clubId)]);

    const both = Promise.all([collect(alice, 'club:session-settled'), collect(bob, 'club:session-settled')]);
    // Throws for the second viewer it is asked about — after the first was
    // already worked out. Nobody may be told twice, and nobody told nothing.
    let asked = 0;
    expect(() =>
      emitToClub(clubId, 'club:session-settled', { sessionId: 's1' }, () => {
        asked += 1;
        if (asked === 2) throw new Error('boom');
        return { you: { net: 1 } };
      })
    ).not.toThrow();

    expect(await both).toEqual([[{ sessionId: 's1' }], [{ sessionId: 's1' }]]);
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });

  it('does not reach a client outside the room', async () => {
    const [alice, bob] = await Promise.all([open(aliceId), open(bobId)]);
    await joinClub(alice, clubId); // bob is connected but never joined

    const both = Promise.all([collect(alice, 'club:session-settled'), collect(bob, 'club:session-settled')]);
    emitToClub(clubId, 'club:session-settled', { sessionId: 's1' }, () => ({ you: { net: 5 } }));

    const [a, b] = await both;
    expect(a).toHaveLength(1);
    expect(b).toEqual([]);
  });
});
