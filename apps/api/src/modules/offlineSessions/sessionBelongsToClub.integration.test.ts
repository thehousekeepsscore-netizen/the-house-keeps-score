import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';
import { prisma } from '../../lib/prisma.js';
import { signAccessToken } from '../../utils/jwt.js';

/**
 * A session route acts only on a night that belongs to the club in its URL.
 *
 * Every route under /clubs/:clubId/offline-sessions/:sessionId authorised the
 * caller against the club and then acted on the session, and the two were
 * never compared. So a member of club A could read club B's banks, and an
 * admin of A could freeze or cancel B's night, by putting B's session id under
 * A's club id. Over HTTP, because the gap was between what the URL said and
 * what the handler did; a direct service call cannot reproduce that.
 *
 * The answer is 404, not 403: as far as club A is concerned that night does
 * not exist, and a 403 would confirm that it does.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

vi.mock('../../realtime/socket.js', () => ({ emitToClub: () => {} }));

const { app } = await import('../../app.js');

let server: Server;
let base = '';
let clubA = '';
let clubB = '';
let nightB = '';
let bankId = '';
let ownerA = '';
let ownerB = '';
let playerB = '';
let createdUsers: string[] = [];

const RULES = {
  sessionRakeAmount: 0, winnersCutPercent: 0, rakeEnabled: false,
  rakeMethod: 'PERCENT_PROFIT', rakeValue: 0, potEnabled: false,
  mismatchStrategy: 'PROPORTIONAL_WINNERS', rakeOrder: 'MISMATCH_FIRST',
  winnerDefinition: 'PROFIT_POSITIVE', winnerTopN: 1, roundingRule: 'NONE',
};

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mk = (role: string) =>
    prisma.user.create({ data: { email: `xclub-${role}-${stamp}@test.local`, passwordHash: 'x', displayName: role } });
  const [a, b, p] = await Promise.all([mk('ownerA'), mk('ownerB'), mk('playerB')]);
  ownerA = a.id; ownerB = b.id; playerB = p.id;
  createdUsers = [a.id, b.id, p.id];

  const [A, B] = await Promise.all([
    prisma.club.create({
      data: {
        name: `Club A ${stamp}`, code: `XA${stamp}`.slice(0, 20), ownerId: a.id, buyInMode: 'UNCAPPED',
        members: { create: [{ userId: a.id }] },
      },
    }),
    prisma.club.create({
      data: {
        name: `Club B ${stamp}`, code: `XB${stamp}`.slice(0, 20), ownerId: b.id, buyInMode: 'UNCAPPED',
        members: { create: [{ userId: b.id }, { userId: p.id }] },
      },
    }),
  ]);
  clubA = A.id; clubB = B.id;

  const night = await prisma.pokerSession.create({
    data: {
      clubId: B.id, sessionName: 'B Night', sessionType: 'OFFLINE', startedById: b.id,
      engineState: {
        startedPlayingAt: new Date().toISOString(), settlementRules: RULES,
        activePlayerUids: [b.id, p.id], pendingSitInUids: [], cashOuts: [],
      },
    },
  });
  nightB = night.id;
  const bank = await prisma.buyInRequest.create({
    data: { sessionId: night.id, clubId: B.id, userId: p.id, amount: 5000, status: 'approved', requestedBy: p.id, approvedBy: b.id },
  });
  bankId = bank.id;
});

afterEach(async () => {
  const clubs = [clubA, clubB].filter(Boolean);
  if (clubs.length) {
    await prisma.auditLog.deleteMany({ where: { clubId: { in: clubs } } });
    await prisma.buyInRequest.deleteMany({ where: { clubId: { in: clubs } } });
    await prisma.pokerSession.deleteMany({ where: { clubId: { in: clubs } } });
    await prisma.clubMember.deleteMany({ where: { clubId: { in: clubs } } });
    await prisma.club.deleteMany({ where: { id: { in: clubs } } });
  }
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  clubA = ''; clubB = '';
});

const token = (uid: string) =>
  signAccessToken({ sub: uid, email: `${uid}@test.local`, displayName: 'X', isSuperAdmin: false });

async function call(uid: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token(uid)}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

/** Club B's night, reached through club A's URL. */
const viaA = () => `/clubs/${clubA}/offline-sessions/${nightB}`;

/** Every session route, with a body that would pass validation on the right club. */
const routes = (): [string, string, unknown?][] => [
  ['GET', `${viaA()}/buy-in-requests`],
  ['POST', `${viaA()}/join`],
  ['POST', `${viaA()}/start-playing`],
  ['POST', `${viaA()}/extend`, { minutes: 30 }],
  ['POST', `${viaA()}/lift-time-limit`],
  ['POST', `${viaA()}/cash-out-requests/amend`, { userId: playerB, amount: 100 }],
  ['POST', `${viaA()}/remove-from-lobby`, { userId: playerB }],
  ['POST', `${viaA()}/begin-settling`],
  ['POST', `${viaA()}/resume`],
  ['POST', `${viaA()}/cancel`],
  ['POST', `${viaA()}/sit-in-requests`, {}],
  ['POST', `${viaA()}/sit-in-requests`, { userId: ownerA }],
  ['POST', `${viaA()}/sit-in-requests/withdraw`],
  ['POST', `${viaA()}/sit-in-requests/approve`, { userId: playerB }],
  ['POST', `${viaA()}/sit-in-requests/reject`, { userId: playerB, reason: 'no' }],
  ['POST', `${viaA()}/cash-out-requests`, { amount: 100 }],
  ['POST', `${viaA()}/cash-out-requests/withdraw`],
  ['POST', `${viaA()}/cash-out-requests/approve`, { userId: playerB }],
  ['POST', `${viaA()}/buy-in-requests`, { amount: 1000 }],
  ['POST', `${viaA()}/buy-in-requests`, { amount: 1000, userId: playerB }],
  ['POST', `${viaA()}/buy-in-requests/${bankId}/withdraw`],
  ['POST', `${viaA()}/buy-in-requests/${bankId}/approve`],
  ['POST', `${viaA()}/buy-in-requests/${bankId}/reject`, { reason: 'no' }],
  ['POST', `${viaA()}/buy-in-requests/${bankId}/void`, { reason: 'no' }],
  ['POST', `${viaA()}/settlement-rules`, { sessionRakeAmount: 0, winnersCutPercent: 0 }],
  ['POST', `${viaA()}/settle`, { entries: [{ userId: ownerB, buyIn: 5000, cashOut: 5000 }, { userId: playerB, buyIn: 5000, cashOut: 5000 }] }],
];

async function nightAsStored() {
  const row = await prisma.pokerSession.findUniqueOrThrow({ where: { id: nightB } });
  const bank = await prisma.buyInRequest.findUniqueOrThrow({ where: { id: bankId } });
  const requests = await prisma.buyInRequest.count({ where: { sessionId: nightB } });
  const settlements = await prisma.cashOutSettlement.count({ where: { clubId: clubB } });
  return { status: row.status, endedAt: row.endedAt, engineState: row.engineState, bank: bank.status, requests, settlements };
}

describe("another club's night, under this club's URL", () => {
  it('does not exist, on every session route, and nothing about it changes', async () => {
    const before = await nightAsStored();

    const answers: Record<string, number> = {};
    for (const [method, path, body] of routes()) {
      const r = await call(ownerA, method, path, body);
      answers[`${method} ${path.replace(viaA(), '')}`] = r.status;
      expect(r.json, `${method} ${path}`).toEqual({ error: 'Session not found' });
    }
    expect(Object.values(answers).every((s) => s === 404), JSON.stringify(answers, null, 2)).toBe(true);
    expect(Object.keys(answers)).toHaveLength(routes().length - 2); // two paths repeat with a different body

    expect(await nightAsStored()).toEqual(before);
  });

  it('is not listed, even though a member of the right club sees it', async () => {
    const wrong = await call(ownerA, 'GET', `${viaA()}/buy-in-requests`);
    expect(wrong.status).toBe(404);

    const right = await call(playerB, 'GET', `/clubs/${clubB}/offline-sessions/${nightB}/buy-in-requests`);
    expect(right.status).toBe(200);
    expect(right.json).toEqual([expect.objectContaining({ id: bankId, amount: 5000, status: 'approved' })]);
  });
});

describe("the club's own night", () => {
  it('still answers its admin: frozen, resumed, and cancelled only by its own club', async () => {
    const own = `/clubs/${clubB}/offline-sessions/${nightB}`;

    const frozen = await call(ownerB, 'POST', `${own}/begin-settling`);
    expect(frozen.status).toBe(200);
    expect((await nightAsStored()).engineState).toMatchObject({ settlingAt: expect.any(String) });

    const resumed = await call(ownerB, 'POST', `${own}/resume`);
    expect(resumed.status).toBe(200);

    // The rule is about the club, not the caller's rank: club A's owner is an
    // admin, and a 404 is still the answer. Club B's own owner, same route,
    // gets the real refusal (banks are out, so the night cannot be cancelled).
    const foreign = await call(ownerA, 'POST', `${viaA()}/cancel`);
    expect(foreign.status).toBe(404);
    const home = await call(ownerB, 'POST', `${own}/cancel`);
    expect(home.status).toBe(409);
  });

  it('still takes a bank: asked, approved, voided, and a seat joined, through its own club', async () => {
    const own = `/clubs/${clubB}/offline-sessions/${nightB}`;

    const asked = await call(playerB, 'POST', `${own}/buy-in-requests`, { amount: 1000 });
    expect(asked.status).toBe(201);
    const requestId = (asked.json as { id: string }).id;

    const approved = await call(ownerB, 'POST', `${own}/buy-in-requests/${requestId}/approve`);
    expect(approved.status).toBe(200);
    const voided = await call(ownerB, 'POST', `${own}/buy-in-requests/${requestId}/void`, { reason: 'wrong amount' });
    expect(voided.status).toBe(200);
    const listed = await call(ownerB, 'GET', `${own}/buy-in-requests`);
    expect(listed.json).toEqual(expect.arrayContaining([expect.objectContaining({ id: requestId, status: 'voided' })]));

    const joined = await call(ownerB, 'POST', `${own}/join`);
    expect(joined.status).toBe(200);
  });

  it('settles only through its own club', async () => {
    const entries = [{ userId: ownerB, buyIn: 5000, cashOut: 6000 }, { userId: playerB, buyIn: 5000, cashOut: 4000 }];
    await prisma.buyInRequest.create({
      data: { sessionId: nightB, clubId: clubB, userId: ownerB, amount: 5000, status: 'approved', requestedBy: ownerB, approvedBy: ownerB },
    });

    const foreign = await call(ownerA, 'POST', `${viaA()}/settle`, { entries });
    expect(foreign.status).toBe(404);
    expect((await nightAsStored()).status).toBe('active');

    const home = await call(ownerB, 'POST', `/clubs/${clubB}/offline-sessions/${nightB}/settle`, { entries });
    expect(home.status).toBe(201);
    expect((await nightAsStored()).status).toBe('settled');
  });
});

describe('a session id that belongs to nobody', () => {
  it('is the same 404, so the two cases cannot be told apart', async () => {
    const ghost = await call(ownerA, 'POST', `/clubs/${clubA}/offline-sessions/00000000-0000-0000-0000-000000000000/begin-settling`);
    expect(ghost.status).toBe(404);
    expect(ghost.json).toEqual({ error: 'Session not found' });
  });
});
