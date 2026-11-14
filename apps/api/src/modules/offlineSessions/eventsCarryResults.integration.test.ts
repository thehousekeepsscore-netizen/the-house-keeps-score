import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';

vi.mock('../../realtime/socket.js', () => ({ emitToClub: vi.fn() }));

import { app } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { signAccessToken } from '../../utils/jwt.js';
import { emitToClub } from '../../realtime/socket.js';

/**
 * Events that say what happened, and to whom.
 *
 * A declined request used to be announced as a bare "decided", and a settled
 * night as a bare session id. The decision events now name who decided and
 * carry the admin's optional reason; the settled event carries the night's
 * title, the record it became, and each player's own net.
 *
 * The part that matters most is what is NOT in the shared payload. The reason
 * is a note to one player and a net result is one player's figure — a player
 * reads only their own line in History — so both travel in the per-viewer part
 * of the emit and are asserted here from both sides: present for the person
 * they belong to, absent for everybody else and from the broadcast itself.
 *
 * Over real HTTP, because the reason arrives in a request body and the rule
 * about when it is read ("only on a reject") lives in the controller.
 * personalEmit.integration.test.ts proves the per-viewer part reaches the right
 * socket; this proves the right thing is put in it.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

let server: Server;
let base = '';
let clubId = '';
let sessionId = '';
type Role = 'owner' | 'admin' | 'priya' | 'member';
const ids: Record<Role, string> = { owner: '', admin: '', priya: '', member: '' };
const tokens: Record<Role, string> = { owner: '', admin: '', priya: '', member: '' };

const RULES = {
  sessionRakeAmount: 0, winnersCutPercent: 0, rakeEnabled: false, rakeMethod: 'PERCENT_PROFIT',
  rakeValue: 0, potEnabled: false, mismatchStrategy: 'PROPORTIONAL_WINNERS', rakeOrder: 'MISMATCH_FIRST',
  winnerDefinition: 'PROFIT_POSITIVE', winnerTopN: 1, roundingRule: 'NONE',
};

async function call(as: Role, method: string, path: string, body?: unknown) {
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

type Personal = ((viewerUid: string) => Record<string, unknown> | undefined) | undefined;
/** The one emit of this event: its shared payload and its per-viewer part. */
function emitted(event: string) {
  const calls = vi.mocked(emitToClub).mock.calls.filter((c) => c[1] === event);
  expect(calls, `exactly one ${event}`).toHaveLength(1);
  const [club, , shared, personal] = calls[0] as [string, string, Record<string, unknown>, Personal];
  expect(club).toBe(clubId);
  return { shared, personal, for: (role: Role) => personal?.(ids[role]) };
}

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  for (const role of Object.keys(ids) as Role[]) {
    const u = await prisma.user.create({
      data: { email: `ev-${role}-${stamp}@test.local`, passwordHash: 'x', displayName: `EV ${role}` },
    });
    ids[role] = u.id;
    tokens[role] = signAccessToken({ sub: u.id, email: u.email, displayName: u.displayName, isSuperAdmin: false });
  }
  const club = await prisma.club.create({
    data: {
      name: `Events ${stamp}`,
      code: `EV${stamp}`.slice(0, 20),
      ownerId: ids.owner,
      buyInMode: 'UNCAPPED',
      members: { create: (Object.keys(ids) as Role[]).map((r) => ({ userId: ids[r] })) },
      admins: { create: [{ userId: ids.admin }] },
    },
  });
  clubId = club.id;
  const session = await prisma.pokerSession.create({
    data: {
      clubId, sessionName: 'Friday · Day 3', sessionType: 'OFFLINE', startedById: ids.owner,
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
  vi.mocked(emitToClub).mockClear();
});

afterEach(async () => {
  await prisma.auditLog.deleteMany({ where: { clubId } });
  await prisma.buyInRequest.deleteMany({ where: { clubId } });
  await prisma.pokerSession.deleteMany({ where: { clubId } });
  await prisma.clubAdmin.deleteMany({ where: { clubId } });
  await prisma.clubMember.deleteMany({ where: { clubId } });
  await prisma.club.deleteMany({ where: { id: clubId } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
});

async function askForChips(amount = 5_000) {
  const r = await call('priya', 'POST', night('/buy-in-requests'), { amount });
  expect(r.status).toBe(201);
  vi.mocked(emitToClub).mockClear();
  return r.body.id as string;
}

describe('a declined bank', () => {
  it('tells the asker why, and nobody else', async () => {
    const id = await askForChips();
    const r = await call('owner', 'POST', night(`/buy-in-requests/${id}/reject`), { reason: 'Settle up last week first' });
    expect(r.status).toBe(200);

    const e = emitted('club:buyin-decided');
    expect(e.shared).toMatchObject({ sessionId, requestId: id, userId: ids.priya, approve: false, decidedBy: ids.owner });
    expect(e.shared).not.toHaveProperty('reason');
    expect(JSON.stringify(e.shared)).not.toContain('Settle up last week first');
    expect(e.for('priya')).toEqual({ reason: 'Settle up last week first' });
    expect(e.for('member')).toBeUndefined();
    expect(e.for('admin')).toBeUndefined();
    expect(e.for('owner')).toBeUndefined();
    expect((await prisma.buyInRequest.findUniqueOrThrow({ where: { id } })).status).toBe('rejected');
  });

  it('trims the reason and keeps it to 200 characters', async () => {
    const id = await askForChips();
    await call('owner', 'POST', night(`/buy-in-requests/${id}/reject`), { reason: `   ${'x'.repeat(260)}   ` });
    expect(emitted('club:buyin-decided').for('priya')).toEqual({ reason: 'x'.repeat(200) });
  });

  it('is an ordinary broadcast when no reason is given', async () => {
    const id = await askForChips();
    expect((await call('owner', 'POST', night(`/buy-in-requests/${id}/reject`))).status).toBe(200);
    const e = emitted('club:buyin-decided');
    expect(e.personal).toBeUndefined();
    expect(e.shared).toMatchObject({ approve: false, decidedBy: ids.owner });
  });

  it('treats a blank reason as none, and never refuses a decision over its footnote', async () => {
    const blank = await askForChips();
    expect((await call('owner', 'POST', night(`/buy-in-requests/${blank}/reject`), { reason: '    ' })).status).toBe(200);
    expect(emitted('club:buyin-decided').personal).toBeUndefined();

    const notText = await askForChips();
    expect((await call('owner', 'POST', night(`/buy-in-requests/${notText}/reject`), { reason: { nested: true } })).status).toBe(200);
    expect(emitted('club:buyin-decided').personal).toBeUndefined();
    expect((await prisma.buyInRequest.findUniqueOrThrow({ where: { id: notText } })).status).toBe('rejected');
  });

  it('carries no reason on an approval, even if one was sent', async () => {
    const id = await askForChips();
    const r = await call('owner', 'POST', night(`/buy-in-requests/${id}/approve`), { reason: 'should be ignored' });
    expect(r.status).toBe(200);
    const e = emitted('club:buyin-decided');
    expect(e.shared).toMatchObject({ approve: true, decidedBy: ids.owner });
    expect(e.personal).toBeUndefined();
  });
});

describe('a declined seat request', () => {
  beforeEach(async () => {
    expect((await call('member', 'POST', night('/sit-in-requests'))).status).toBe(201);
    vi.mocked(emitToClub).mockClear();
  });

  it('tells the asker why, and nobody else', async () => {
    const r = await call('owner', 'POST', night('/sit-in-requests/reject'), { userId: ids.member, reason: 'Table is full' });
    expect(r.status).toBe(200);
    const e = emitted('club:sitin-decided');
    expect(e.shared).toMatchObject({ sessionId, userId: ids.member, approved: false, decidedBy: ids.owner });
    expect(e.shared).not.toHaveProperty('reason');
    expect(e.for('member')).toEqual({ reason: 'Table is full' });
    expect(e.for('priya')).toBeUndefined();
  });

  it('carries no reason on an approval', async () => {
    await call('owner', 'POST', night('/sit-in-requests/approve'), { userId: ids.member, reason: 'ignored' });
    const e = emitted('club:sitin-decided');
    expect(e.shared).toMatchObject({ approved: true, decidedBy: ids.owner });
    expect(e.personal).toBeUndefined();
  });
});

describe('a count sent back', () => {
  beforeEach(async () => {
    expect((await call('priya', 'POST', night('/cash-out-requests'), { amount: 3_000 })).status).toBe(201);
    vi.mocked(emitToClub).mockClear();
  });

  it('tells the player why, and nobody else', async () => {
    const r = await call('owner', 'POST', night('/cash-out-requests/reject'), { userId: ids.priya, reason: 'Two stacks short' });
    expect(r.status).toBe(200);
    const e = emitted('club:cashout-decided');
    expect(e.shared).toMatchObject({ sessionId, userId: ids.priya, approved: false, decidedBy: ids.owner });
    expect(e.shared).not.toHaveProperty('reason');
    expect(e.for('priya')).toEqual({ reason: 'Two stacks short' });
    expect(e.for('member')).toBeUndefined();
  });

  it('carries no reason on a confirmation', async () => {
    await call('owner', 'POST', night('/cash-out-requests/approve'), { userId: ids.priya, reason: 'ignored' });
    const e = emitted('club:cashout-decided');
    expect(e.shared).toMatchObject({ approved: true, decidedBy: ids.owner });
    expect(e.personal).toBeUndefined();
  });
});

describe('a settled night', () => {
  beforeEach(async () => {
    for (const role of ['owner', 'priya'] as const) {
      await prisma.buyInRequest.create({
        data: { sessionId, clubId, userId: ids[role], amount: 5_000, status: 'approved', requestedBy: ids[role], approvedBy: ids.admin },
      });
    }
  });

  const settle = () =>
    call('admin', 'POST', night('/settle'), {
      entries: [
        { userId: ids.owner, buyIn: 5_000, cashOut: 6_800 },
        { userId: ids.priya, buyIn: 5_000, cashOut: 3_200 },
      ],
    });

  it('names the night, the record it became and who settled it — and no figures', async () => {
    const r = await settle();
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);

    const e = emitted('club:session-settled');
    const record = await prisma.cashOutSettlement.findFirstOrThrow({ where: { clubId } });
    expect(e.shared).toEqual({ sessionId, recordId: record.id, title: 'Friday · Day 3', settledBy: ids.admin });
    // Nobody's result is in what the whole club is sent.
    expect(JSON.stringify(e.shared)).not.toMatch(/1800|6800|3200/);
  });

  it('tells each player their own net, and only their own', async () => {
    await settle();
    const e = emitted('club:session-settled');
    expect(e.for('owner')).toEqual({ you: { net: 1_800 } });
    expect(e.for('priya')).toEqual({ you: { net: -1_800 } });
  });

  it('gives someone who did not play no figure at all', async () => {
    await settle();
    const e = emitted('club:session-settled');
    expect(e.for('member')).toBeUndefined();
    // The admin settled it and did not play: told it is settled, and no number.
    expect(e.for('admin')).toBeUndefined();
  });

  it('announces nothing when the settlement is refused', async () => {
    const r = await call('member', 'POST', night('/settle'), { entries: [] });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(vi.mocked(emitToClub).mock.calls.filter((c) => c[1] === 'club:session-settled')).toHaveLength(0);
  });
});
