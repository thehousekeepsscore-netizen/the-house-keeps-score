import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { app } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { signAccessToken } from '../../utils/jwt.js';

/**
 * The club pot is the owner's to see.
 *
 * The balance used to travel to every member on every club payload, and the
 * ledger that sums to it was open to any admin. Now the balance is present
 * for the owner (a super admin counts as one) and absent — not zero — for
 * everyone else, and the ledger refuses admins the way it already refused
 * members and outsiders. Both live in HTTP-facing code, the controller's
 * serialiser and the records service's guard, so this drives the real app
 * over a socket with one token per role.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

let server: Server;
let baseUrl: string;
let clubId = '';
const userIds: string[] = [];
const tokens: Record<'owner' | 'admin' | 'member' | 'superAdmin', string> = {
  owner: '',
  admin: '',
  member: '',
  superAdmin: '',
};
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const BALANCE = 583_491;

async function call(as: keyof typeof tokens, path: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${tokens[as]}` } });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json as Record<string, unknown>, raw: text };
}

async function makeUser(label: string, isSuperAdmin = false) {
  const user = await prisma.user.create({
    data: { email: `pot-${label}-${stamp}@test.local`, passwordHash: 'x', displayName: `Pot ${label}`, isSuperAdmin },
  });
  userIds.push(user.id);
  return {
    id: user.id,
    token: signAccessToken({ sub: user.id, email: user.email, displayName: user.displayName, isSuperAdmin }),
  };
}

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api`;

  const owner = await makeUser('owner');
  const admin = await makeUser('admin');
  const member = await makeUser('member');
  // A super admin who is NOT a member of the club at all.
  const superAdmin = await makeUser('super', true);
  tokens.owner = owner.token;
  tokens.admin = admin.token;
  tokens.member = member.token;
  tokens.superAdmin = superAdmin.token;

  const club = await prisma.club.create({
    data: {
      name: `Pot Visibility ${stamp}`,
      code: `PV${stamp}`.slice(0, 20),
      ownerId: owner.id,
      buyInMode: 'UNCAPPED',
      potEnabled: true,
      clubPotBalance: BALANCE,
      members: { create: [{ userId: owner.id }, { userId: admin.id }, { userId: member.id }] },
      admins: { create: [{ userId: admin.id }] },
      potLogs: { create: [{ amount: BALANCE, source: 'manual_adjustment', note: 'seed' }] },
    },
  });
  clubId = club.id;
});

afterAll(async () => {
  if (clubId) {
    await prisma.clubPotLog.deleteMany({ where: { clubId } });
    await prisma.auditLog.deleteMany({ where: { clubId } });
    await prisma.clubAdmin.deleteMany({ where: { clubId } });
    await prisma.clubMember.deleteMany({ where: { clubId } });
    await prisma.club.deleteMany({ where: { id: clubId } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the balance on the club payload', () => {
  it('reaches the owner, on the single club and in the list', async () => {
    const one = await call('owner', `/clubs/${clubId}`);
    expect(one.status).toBe(200);
    expect(one.body.clubPotBalance).toBe(BALANCE);

    const list = await call('owner', '/clubs');
    expect(list.status).toBe(200);
    const mine = (list.body as unknown as Array<Record<string, unknown>>).find((c) => c.id === clubId);
    expect(mine?.clubPotBalance).toBe(BALANCE);
  });

  it('reaches a super admin, who counts as the owner everywhere else too', async () => {
    const one = await call('superAdmin', `/clubs/${clubId}`);
    expect(one.status).toBe(200);
    expect(one.body.clubPotBalance).toBe(BALANCE);
  });

  it.each(['admin', 'member'] as const)('is absent — not zero — for a(n) %s', async (role) => {
    const one = await call(role, `/clubs/${clubId}`);
    expect(one.status).toBe(200);
    // Still a full member payload: the members list is there, the pot key is not.
    expect(one.body).toHaveProperty('members');
    expect(one.body).not.toHaveProperty('clubPotBalance');
    expect(one.raw).not.toMatch(/clubPotBalance/);
    expect(one.raw).not.toContain(String(BALANCE));

    const list = await call(role, '/clubs');
    expect(list.status).toBe(200);
    const mine = (list.body as unknown as Array<Record<string, unknown>>).find((c) => c.id === clubId);
    expect(mine).toBeDefined();
    expect(mine).not.toHaveProperty('clubPotBalance');
  });

  it('the pot switch itself is still public to members — only the figure is not', async () => {
    const one = await call('member', `/clubs/${clubId}`);
    expect(one.body.potEnabled).toBe(true);
  });
});

describe('the ledger', () => {
  it('opens for the owner and the super admin', async () => {
    for (const as of ['owner', 'superAdmin'] as const) {
      const res = await call(as, `/clubs/${clubId}/pot-log`);
      expect(res.status, as).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect((res.body as unknown as Array<Record<string, unknown>>)[0]?.amount).toBe(BALANCE);
    }
  });

  it.each(['admin', 'member'] as const)('refuses a(n) %s, who could otherwise sum it', async (role) => {
    const res = await call(role, `/clubs/${clubId}/pot-log`);
    expect(res.status).toBe(403);
    expect(res.raw).not.toContain(String(BALANCE));
  });
});
