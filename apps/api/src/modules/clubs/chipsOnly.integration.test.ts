import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { app } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { signAccessToken } from '../../utils/jwt.js';

/**
 * Chips are the only unit the API knows.
 *
 * The club used to carry a "devaluation" setting — a flag and a factor meaning
 * N chips = ₹1 — that the API exposed, accepted on create, and froze against
 * later change. It was display-only: no settlement code ever read it. It is
 * removed from every request and response here, while the two columns stay on
 * the table untouched, still holding what two production clubs set.
 *
 * So the row in these tests has the old setting ON, exactly as those clubs do,
 * and the API must neither reveal it nor take it. Driven over real HTTP
 * against the real Express app, because the exposure was in controller
 * serialisation and the acceptance was in a zod schema — a service test would
 * exercise neither.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

let server: Server;
let baseUrl: string;
let ownerId = '';
let ownerToken = '';
let clubId = '';
const createdClubs: string[] = [];
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ownerToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json as Record<string, unknown>, raw: text };
}

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api`;

  const owner = await prisma.user.create({
    data: { email: `chips-owner-${stamp}@test.local`, passwordHash: 'x', displayName: 'Chips Owner' },
  });
  ownerId = owner.id;
  ownerToken = signAccessToken({ sub: owner.id, email: owner.email, displayName: owner.displayName, isSuperAdmin: false });

  // The old setting ON, as the two production clubs have it stored.
  const club = await prisma.club.create({
    data: {
      name: `Chips Only ${stamp}`,
      code: `CO${stamp}`.slice(0, 20),
      ownerId: owner.id,
      buyInMode: 'UNCAPPED',
      enableDevaluation: true,
      devaluationFactor: 5,
      members: { create: [{ userId: owner.id }] },
    },
  });
  clubId = club.id;
  createdClubs.push(club.id);
});

afterAll(async () => {
  for (const id of createdClubs) {
    await prisma.auditLog.deleteMany({ where: { clubId: id } });
    await prisma.clubMember.deleteMany({ where: { clubId: id } });
    await prisma.club.deleteMany({ where: { id } });
  }
  if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const storedSetting = () =>
  prisma.club.findUniqueOrThrow({ where: { id: clubId }, select: { enableDevaluation: true, devaluationFactor: true } });

describe('responses', () => {
  it('a club whose row has the setting on is served without it, figures untouched', async () => {
    const one = await call('GET', `/clubs/${clubId}`);
    expect(one.status).toBe(200);
    expect(one.body).not.toHaveProperty('enableDevaluation');
    expect(one.body).not.toHaveProperty('devaluationFactor');
    expect(one.raw).not.toMatch(/devaluation/i);
    // The chip figures the screen renders are still there and still chips.
    expect(one.body.minBuyIn).toBe(1000);
    expect(one.body.maxBuyIn).toBe(5000);

    const list = await call('GET', '/clubs');
    expect(list.status).toBe(200);
    expect(list.raw).not.toMatch(/devaluation/i);
  });

  it('reading it changed nothing on the row', async () => {
    expect(await storedSetting()).toEqual({ enableDevaluation: true, devaluationFactor: 5 });
  });
});

describe('requests', () => {
  it('create ignores the old fields and writes the column defaults', async () => {
    const res = await call('POST', '/clubs', {
      name: `Chips Create ${stamp}`,
      enableDevaluation: true,
      devaluationFactor: 7,
    });
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    createdClubs.push(id);

    expect(res.body).not.toHaveProperty('enableDevaluation');
    expect(res.body).not.toHaveProperty('devaluationFactor');
    const row = await prisma.club.findUniqueOrThrow({ where: { id }, select: { enableDevaluation: true, devaluationFactor: true } });
    // Column defaults, not what the request asked for: the API no longer
    // has an input for them.
    expect(row).toEqual({ enableDevaluation: false, devaluationFactor: 1 });
  });

  it('update no longer knows the fields: they are dropped, not frozen, and nothing is written', async () => {
    // Before removal this was a 400 — "rules are fixed at creation". Now the
    // keys are simply unknown to the schema and stripped.
    const res = await call('PATCH', `/clubs/${clubId}`, { enableDevaluation: false, devaluationFactor: 1 });
    expect(res.status).toBe(200);
    expect(res.raw).not.toMatch(/devaluation/i);
    expect(await storedSetting(), 'the stored setting is untouched').toEqual({ enableDevaluation: true, devaluationFactor: 5 });
  });

  it('the genuinely frozen rules are still frozen', async () => {
    // Removing two names from the immutable list must not have loosened the rest.
    const res = await call('PATCH', `/clubs/${clubId}`, { sessionRakeAmount: 999 });
    expect(res.status).toBe(400);
    expect(res.raw).toMatch(/fixed when it is created/);
  });
});
