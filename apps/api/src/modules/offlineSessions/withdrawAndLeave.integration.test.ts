import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { app } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { signAccessToken } from '../../utils/jwt.js';

/**
 * The "I didn't mean that" exits.
 *
 * Every question a player puts to the host — a bank, a seat, a count — could
 * until now be closed only by the host, and a membership or a request to join
 * only by an admin. These are the asker's own ways out: withdraw a pending
 * request, leave a club, cancel a request to join.
 *
 * Driven over real HTTP against the real app, because three of the five routes
 * sit beside an existing route with a `:param` that could swallow them, and
 * routing is the thing a service test cannot see.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

let server: Server;
let base = '';
let stamp = '';
let clubId = '';
let sessionId = '';
const ids: Record<'owner' | 'admin' | 'priya' | 'member' | 'outsider', string> = {
  owner: '', admin: '', priya: '', member: '', outsider: '',
};
const tokens: Record<keyof typeof ids, string> = { owner: '', admin: '', priya: '', member: '', outsider: '' };

const RULES = {
  sessionRakeAmount: 0, winnersCutPercent: 0, rakeEnabled: false, rakeMethod: 'PERCENT_PROFIT',
  rakeValue: 0, potEnabled: false, mismatchStrategy: 'PROPORTIONAL_WINNERS', rakeOrder: 'MISMATCH_FIRST',
  winnerDefinition: 'PROFIT_POSITIVE', winnerTopN: 1, roundingRule: 'NONE',
};

async function call(as: keyof typeof ids, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tokens[as]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json as Record<string, unknown> };
}
const night = (p = '') => `/clubs/${clubId}/offline-sessions/${sessionId}${p}`;
const engine = async () =>
  (await prisma.pokerSession.findUniqueOrThrow({ where: { id: sessionId } })).engineState as {
    pendingSitInUids?: string[]; sitInRequestedAt?: Record<string, string>;
    cashOuts?: { userId: string; status: string }[]; activePlayerUids: string[];
  };

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  for (const role of Object.keys(ids) as (keyof typeof ids)[]) {
    const u = await prisma.user.create({
      data: { email: `wl-${role}-${stamp}@test.local`, passwordHash: 'x', displayName: `WL ${role}` },
    });
    ids[role] = u.id;
    tokens[role] = signAccessToken({ sub: u.id, email: u.email, displayName: u.displayName, isSuperAdmin: false });
  }
  const club = await prisma.club.create({
    data: {
      name: `Withdraw ${stamp}`,
      code: `WL${stamp}`.slice(0, 20),
      ownerId: ids.owner,
      buyInMode: 'UNCAPPED',
      members: { create: [ids.owner, ids.admin, ids.priya, ids.member].map((userId) => ({ userId })) },
      admins: { create: [{ userId: ids.admin }] },
    },
  });
  clubId = club.id;
  const session = await prisma.pokerSession.create({
    data: {
      clubId, sessionName: 'Withdraw Night', sessionType: 'OFFLINE', startedById: ids.owner,
      engineState: {
        startedPlayingAt: new Date().toISOString(),
        settlementRules: RULES,
        activePlayerUids: [ids.owner, ids.priya],
        pendingSitInUids: [],
        cashOuts: [],
      },
    },
  });
  sessionId = session.id;
});

afterEach(async () => {
  await prisma.auditLog.deleteMany({ where: { clubId } });
  await prisma.clubJoinRequest.deleteMany({ where: { clubId } });
  await prisma.buyInRequest.deleteMany({ where: { clubId } });
  await prisma.pokerSession.deleteMany({ where: { clubId } });
  await prisma.clubAdmin.deleteMany({ where: { clubId } });
  await prisma.clubMember.deleteMany({ where: { clubId } });
  await prisma.club.deleteMany({ where: { id: clubId } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
});

describe('withdrawing a bank', () => {
  async function ask(amount = 5_000) {
    const r = await call('priya', 'POST', night('/buy-in-requests'), { amount });
    expect(r.status).toBe(201);
    return r.body.id as string;
  }

  it('the player takes back their own pending bank', async () => {
    const id = await ask();
    const r = await call('priya', 'POST', night(`/buy-in-requests/${id}/withdraw`));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('withdrawn');
    expect((await prisma.buyInRequest.findUniqueOrThrow({ where: { id } })).status).toBe('withdrawn');
  });

  it('a withdrawn bank no longer blocks asking again', async () => {
    const id = await ask(50_000);
    await call('priya', 'POST', night(`/buy-in-requests/${id}/withdraw`));
    // The one-pending-per-player rule: a withdrawn row is not pending.
    expect((await call('priya', 'POST', night('/buy-in-requests'), { amount: 5_000 })).status).toBe(201);
  });

  it('nobody else can withdraw it, admins included', async () => {
    const id = await ask();
    expect((await call('member', 'POST', night(`/buy-in-requests/${id}/withdraw`))).status).toBe(403);
    expect((await call('owner', 'POST', night(`/buy-in-requests/${id}/withdraw`))).status).toBe(403);
    expect((await prisma.buyInRequest.findUniqueOrThrow({ where: { id } })).status).toBe('pending');
  });

  it('is refused once decided', async () => {
    const id = await ask();
    expect((await call('owner', 'POST', night(`/buy-in-requests/${id}/approve`))).status).toBe(200);
    const r = await call('priya', 'POST', night(`/buy-in-requests/${id}/withdraw`));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already been decided/);
    expect((await prisma.buyInRequest.findUniqueOrThrow({ where: { id } })).status).toBe('approved');
  });

  it('one of a racing withdraw and approval wins — never both', async () => {
    const id = await ask();
    const [w, a] = await Promise.all([
      call('priya', 'POST', night(`/buy-in-requests/${id}/withdraw`)),
      call('owner', 'POST', night(`/buy-in-requests/${id}/approve`)),
    ]);
    const ok = [w, a].filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    const final = (await prisma.buyInRequest.findUniqueOrThrow({ where: { id } })).status;
    expect(final).toBe(w.status === 200 ? 'withdrawn' : 'approved');
  });

  it('is refused on a frozen table', async () => {
    const id = await ask();
    await prisma.pokerSession.update({
      where: { id: sessionId },
      data: { engineState: { ...(await engine()), settlementRules: RULES, settlingAt: new Date().toISOString() } as never },
    });
    expect((await call('priya', 'POST', night(`/buy-in-requests/${id}/withdraw`))).status).toBe(409);
  });

  it('answers an unknown request with 404', async () => {
    expect((await call('priya', 'POST', night('/buy-in-requests/nope/withdraw'))).status).toBe(404);
  });
});

describe('withdrawing a seat request', () => {
  it('the asker takes it back; the queue and its timestamp are cleared', async () => {
    expect((await call('member', 'POST', night('/sit-in-requests'), {})).status).toBe(201);
    expect((await engine()).pendingSitInUids).toContain(ids.member);

    const r = await call('member', 'POST', night('/sit-in-requests/withdraw'));
    expect(r.status).toBe(200);
    const s = await engine();
    expect(s.pendingSitInUids).not.toContain(ids.member);
    expect(s.sitInRequestedAt ?? {}).not.toHaveProperty(ids.member);
  });

  it('is 409 when there is nothing waiting', async () => {
    expect((await call('member', 'POST', night('/sit-in-requests/withdraw'))).status).toBe(409);
  });
});

describe('withdrawing an early count', () => {
  it('the player takes back a count an admin has not confirmed', async () => {
    expect((await call('priya', 'POST', night('/cash-out-requests'), { amount: 3_000 })).status).toBe(201);
    const r = await call('priya', 'POST', night('/cash-out-requests/withdraw'));
    expect(r.status).toBe(200);
    expect((await engine()).cashOuts ?? []).toHaveLength(0);
    // Still seated: withdrawing a count is not standing up.
    expect((await engine()).activePlayerUids).toContain(ids.priya);
  });

  it('is refused once an admin confirmed it — that is an amend', async () => {
    await call('priya', 'POST', night('/cash-out-requests'), { amount: 3_000 });
    expect((await call('owner', 'POST', night('/cash-out-requests/approve'), { userId: ids.priya })).status).toBe(200);
    const r = await call('priya', 'POST', night('/cash-out-requests/withdraw'));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already been confirmed/);
  });
});

describe('leaving a club', () => {
  const memberships = async (userId: string) => ({
    member: await prisma.clubMember.count({ where: { clubId, userId } }),
    admin: await prisma.clubAdmin.count({ where: { clubId, userId } }),
  });

  it('a member not in tonight leaves; it is audited, and the club is closed to them', async () => {
    expect((await call('member', 'POST', `/clubs/${clubId}/leave`)).status).toBe(204);
    expect(await memberships(ids.member)).toEqual({ member: 0, admin: 0 });
    const audit = await prisma.auditLog.findMany({ where: { clubId, action: 'leave_club' } });
    expect(audit).toHaveLength(1);
    expect(audit[0].changedBy).toBe(ids.member);
    expect((await call('member', 'GET', `/clubs/${clubId}`)).body).not.toHaveProperty('members');
  });

  it('an admin may leave too, and stops being one', async () => {
    expect((await call('admin', 'POST', `/clubs/${clubId}/leave`)).status).toBe(204);
    expect(await memberships(ids.admin)).toEqual({ member: 0, admin: 0 });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { clubId, action: 'leave_club' } });
    expect((audit.changes as { wasAdmin: boolean }).wasAdmin).toBe(true);
  });

  it('is refused to anyone part of tonight, and changes nothing', async () => {
    const r = await call('priya', 'POST', `/clubs/${clubId}/leave`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/part of tonight/);
    expect(await memberships(ids.priya)).toEqual({ member: 1, admin: 0 });
  });

  it('is refused to someone whose only tie to tonight is a waiting request', async () => {
    await call('member', 'POST', night('/sit-in-requests'), {});
    expect((await call('member', 'POST', `/clubs/${clubId}/leave`)).status).toBe(409);
  });

  it('is refused to the owner', async () => {
    expect((await call('owner', 'POST', `/clubs/${clubId}/leave`)).status).toBe(400);
  });

  it('is 404 for someone who was never in it', async () => {
    expect((await call('outsider', 'POST', `/clubs/${clubId}/leave`)).status).toBe(404);
  });

  it('is open once the night is over', async () => {
    await prisma.pokerSession.update({ where: { id: sessionId }, data: { status: 'settled' } });
    expect((await call('priya', 'POST', `/clubs/${clubId}/leave`)).status).toBe(204);
  });
});

describe('cancelling a request to join', () => {
  async function askToJoin() {
    const r = await call('outsider', 'POST', `/clubs/${clubId}/join-requests`);
    expect(r.status).toBe(201);
    return r.body.id as string;
  }

  it('the asker cancels their own; the row is gone and they can ask again', async () => {
    const id = await askToJoin();
    expect((await call('outsider', 'DELETE', `/clubs/${clubId}/join-requests/${id}`)).status).toBe(204);
    expect(await prisma.clubJoinRequest.count({ where: { id } })).toBe(0);
    expect((await call('outsider', 'POST', `/clubs/${clubId}/join-requests`)).status).toBe(201);
  });

  it('nobody else can cancel it', async () => {
    const id = await askToJoin();
    expect((await call('member', 'DELETE', `/clubs/${clubId}/join-requests/${id}`)).status).toBe(403);
    expect((await call('owner', 'DELETE', `/clubs/${clubId}/join-requests/${id}`)).status).toBe(403);
    expect(await prisma.clubJoinRequest.count({ where: { id } })).toBe(1);
  });

  it('is refused once decided', async () => {
    const id = await askToJoin();
    expect((await call('owner', 'POST', `/clubs/${clubId}/join-requests/${id}/reject`)).status).toBe(200);
    expect((await call('outsider', 'DELETE', `/clubs/${clubId}/join-requests/${id}`)).status).toBe(409);
  });

  it('an admin deciding a cancelled request is told it is gone (404)', async () => {
    const id = await askToJoin();
    await call('outsider', 'DELETE', `/clubs/${clubId}/join-requests/${id}`);
    expect((await call('owner', 'POST', `/clubs/${clubId}/join-requests/${id}/accept`)).status).toBe(404);
  });
});
