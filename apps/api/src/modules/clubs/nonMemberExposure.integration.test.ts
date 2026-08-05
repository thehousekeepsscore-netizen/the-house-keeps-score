import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { app } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { signAccessToken } from '../../utils/jwt.js';

/**
 * What an authenticated non-member can read.
 *
 * These were first written to characterise the exposure: every EXPOSURE case
 * below passed, confirming the leak against the running API rather than
 * inferring it from the code. They are now inverted, so each one fails if the
 * leak ever returns.
 *
 * Driven over real HTTP against the real Express app with a real signed token,
 * because the leak is partly in route wiring and partly in controller
 * serialisation. A service-level test would exercise neither, and `serializeClub`
 * -- where the emails actually escape -- lives in the controller.
 *
 * The attacker in these tests is `outsider`: a legitimate, authenticated account
 * that has no relationship to the club at all. That is the threat model. It is
 * not an unauthenticated request, and it is not a malicious admin.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

let server: Server;
let baseUrl: string;

let clubId = '';
let sessionId = '';
let ownerId: string;
let memberId: string;
let outsiderId: string;
let outsiderToken: string;
let memberToken: string;
let memberEmail: string;
let ownerEmail: string;
let createdUsers: string[] = [];

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Every email this test created, for asserting none of them leak. */
function seededEmails() {
  return [memberEmail, ownerEmail];
}

async function get(path: string, token: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, raw: text };
}

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api`;

  const mk = (role: string) =>
    prisma.user.create({
      data: { email: `exp-${role}-${stamp}@test.local`, passwordHash: 'x', displayName: `Exp ${role}` },
    });

  const [owner, member, outsider] = await Promise.all([mk('owner'), mk('member'), mk('outsider')]);
  ownerId = owner.id;
  memberId = member.id;
  outsiderId = outsider.id;
  ownerEmail = owner.email;
  memberEmail = member.email;
  createdUsers = [owner.id, member.id, outsider.id];

  outsiderToken = signAccessToken({
    sub: outsider.id,
    email: outsider.email,
    displayName: outsider.displayName,
    isSuperAdmin: false,
  });
  memberToken = signAccessToken({
    sub: member.id,
    email: member.email,
    displayName: member.displayName,
    isSuperAdmin: false,
  });

  const club = await prisma.club.create({
    data: {
      name: `Exposure Test ${stamp}`,
      code: `EX${stamp}`.slice(0, 20),
      ownerId: owner.id,
      buyInMode: 'UNCAPPED',
      leaderboardVisibleToPlayers: true,
      members: { create: [{ userId: owner.id }, { userId: member.id }] },
    },
  });
  clubId = club.id;

  const session = await prisma.pokerSession.create({
    data: {
      clubId: club.id,
      sessionName: 'Exposure Night',
      sessionType: 'OFFLINE',
      startedById: owner.id,
      engineState: { activePlayerUids: [ownerId, memberId], pendingSitInUids: [] },
    },
  });
  sessionId = session.id;

  await prisma.buyInRequest.create({
    data: { sessionId, clubId, userId: memberId, amount: 5_000, status: 'approved', requestedBy: memberId },
  });
});

/** Only ever removes rows this test created. */
afterAll(async () => {
  if (clubId) {
    await prisma.auditLog.deleteMany({ where: { clubId } });
    await prisma.buyInRequest.deleteMany({ where: { clubId } });
    await prisma.pokerSession.deleteMany({ where: { clubId } });
    await prisma.clubMember.deleteMany({ where: { clubId } });
    await prisma.club.deleteMany({ where: { id: clubId } });
  }
  if (createdUsers.length) await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /clubs — the club list', () => {
  it('never contains an email address the caller may not see', async () => {
    const { status, raw } = await get('/clubs', outsiderToken);

    expect(status).toBe(200);
    for (const email of seededEmails()) {
      expect(raw, `${email} leaked to a non-member`).not.toContain(email);
    }
  });

  it('still lists clubs the caller is not in, so browsing keeps working', async () => {
    const { body } = await get('/clubs', outsiderToken);
    const ids = (body as { id: string }[]).map((c) => c.id);
    expect(ids).toContain(clubId);
  });

  it('gives the browse card what it renders: name, code, capacity, counts', async () => {
    const { body } = await get('/clubs', outsiderToken);
    const row = (body as Record<string, unknown>[]).find((c) => c.id === clubId)!;

    expect(row).toMatchObject({
      name: `Exposure Test ${stamp}`,
      maxCapacity: expect.any(Number),
      memberCount: 2,
      adminCount: 0,
      isMember: false,
    });
    expect(row.code).toBeTruthy();
  });

  it('withholds the roster and the money settings from a club the caller is not in', async () => {
    const { body } = await get('/clubs', outsiderToken);
    const row = (body as Record<string, unknown>[]).find((c) => c.id === clubId)!;

    // An allowlist, so this asserts absence rather than a specific redaction.
    for (const key of ['owner', 'ownerId', 'clubPotBalance', 'rakeValue', 'sessionRakeAmount', 'leaderboardVisibleToPlayers']) {
      expect(row, `${key} must not reach a non-member`).not.toHaveProperty(key);
    }
    // admins/members are present but empty, only so an older deployed client
    // does not throw while mapping them. They must never carry anyone.
    expect(row.admins).toEqual([]);
    expect(row.members).toEqual([]);
  });
});

describe('GET /clubs/:clubId — a single club', () => {
  it('refuses a non-member outright', async () => {
    const { status, raw } = await get(`/clubs/${clubId}`, outsiderToken);

    expect(status).toBe(403);
    for (const email of seededEmails()) {
      expect(raw).not.toContain(email);
    }
  });

  it('still serves a member the full record, including the roster', async () => {
    const { status, raw, body } = await get(`/clubs/${clubId}`, memberToken);

    expect(status).toBe(200);
    expect(body).toMatchObject({ id: clubId, isMember: true });
    // getClubRoster builds the roster from this response and falls back to
    // email for a display name, so members must keep receiving it.
    expect(raw).toContain(memberEmail);
  });
});

describe('the live table', () => {
  it('refuses a non-member the active session', async () => {
    const { status } = await get(`/clubs/${clubId}/offline-sessions/active`, outsiderToken);
    expect(status).toBe(403);
  });

  it('refuses a non-member the buy-in list', async () => {
    const { status } = await get(
      `/clubs/${clubId}/offline-sessions/${sessionId}/buy-in-requests`,
      outsiderToken
    );
    expect(status).toBe(403);
  });

  it('still serves a member the active session and the buy-ins', async () => {
    const active = await get(`/clubs/${clubId}/offline-sessions/active`, memberToken);
    expect(active.status).toBe(200);
    expect(active.body).toMatchObject({ id: sessionId });

    const buyIns = await get(
      `/clubs/${clubId}/offline-sessions/${sessionId}/buy-in-requests`,
      memberToken
    );
    expect(buyIns.status).toBe(200);
    expect((buyIns.body as { amount: number }[])[0].amount).toBe(5_000);
  });
});

describe('club records', () => {
  it('refuses a non-member the session history', async () => {
    const { status } = await get(`/clubs/${clubId}/history`, outsiderToken);
    expect(status).toBe(403);
  });

  it('refuses a non-member the leaderboard even when it is player-visible', async () => {
    // leaderboardVisibleToPlayers is about players vs admins. It was never
    // meant to answer "may someone outside the club see this".
    const { status } = await get(`/clubs/${clubId}/leaderboard`, outsiderToken);
    expect(status).toBe(403);
  });

  it('still serves a member the history and the leaderboard', async () => {
    expect((await get(`/clubs/${clubId}/history`, memberToken)).status).toBe(200);
    expect((await get(`/clubs/${clubId}/leaderboard`, memberToken)).status).toBe(200);
  });
});

describe('what is already correctly refused — the fix must not regress these', () => {
  it('refuses the audit log', async () => {
    const { status } = await get(`/clubs/${clubId}/audit-log`, outsiderToken);
    expect(status).toBe(403);
  });

  it('refuses the pot log', async () => {
    const { status } = await get(`/clubs/${clubId}/pot-log`, outsiderToken);
    expect(status).toBe(403);
  });

  it('refuses pending changes', async () => {
    const { status } = await get(`/clubs/${clubId}/pending-changes`, outsiderToken);
    expect(status).toBe(403);
  });

  it('refuses deleted sessions', async () => {
    const { status } = await get(`/clubs/${clubId}/deleted-sessions`, outsiderToken);
    expect(status).toBe(403);
  });

  it('shows the outsider only their own join requests', async () => {
    const { status, body } = await get('/clubs/join-requests', outsiderToken);
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('rejects a request with no token at all', async () => {
    const res = await fetch(`${baseUrl}/clubs`);
    expect(res.status).toBe(401);
  });
});
