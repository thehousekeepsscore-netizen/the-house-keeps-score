import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { app } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { signAccessToken } from '../../utils/jwt.js';

/**
 * What an authenticated non-member can read.
 *
 * Written to characterise the CURRENT behaviour before any of it is changed, so
 * that the fix is measured against confirmed facts rather than against a reading
 * of the code. Every expectation below states what the API does today; the ones
 * marked EXPOSURE are the ones that must flip when the projections land.
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
  it('EXPOSURE: returns every member email of every club to any authenticated user', async () => {
    const { status, raw } = await get('/clubs', outsiderToken);

    expect(status).toBe(200);
    // clubInclude selects `email` for admins, members and owner, and listClubs()
    // applies it to every club with no filter at all.
    for (const email of seededEmails()) {
      expect(raw, `${email} must not be readable by a non-member`).toContain(email);
    }
  });

  it('EXPOSURE: lists clubs the caller has no relationship to', async () => {
    const { body } = await get('/clubs', outsiderToken);
    const ids = (body as { id: string }[]).map((c) => c.id);
    expect(ids).toContain(clubId);
  });
});

describe('GET /clubs/:clubId — a single club', () => {
  it('EXPOSURE: serves the full club record to a non-member', async () => {
    const { status, body } = await get(`/clubs/${clubId}`, outsiderToken);

    expect(status).toBe(200);
    expect(body).toMatchObject({ id: clubId });
  });

  it('EXPOSURE: includes member email addresses', async () => {
    const { raw } = await get(`/clubs/${clubId}`, outsiderToken);
    for (const email of seededEmails()) {
      expect(raw).toContain(email);
    }
  });

  it('EXPOSURE: includes private club configuration a non-member has no use for', async () => {
    const { body } = await get(`/clubs/${clubId}`, outsiderToken);
    // Pot balance is club money. Rake settings are how the house takes its cut.
    expect(body).toHaveProperty('clubPotBalance');
    expect(body).toHaveProperty('rakeValue');
    expect(body).toHaveProperty('sessionRakeAmount');
  });
});

describe('the live table', () => {
  it('EXPOSURE: a non-member can read the active session', async () => {
    const { status, body } = await get(`/clubs/${clubId}/offline-sessions/active`, outsiderToken);

    expect(status).toBe(200);
    expect(body).toMatchObject({ id: sessionId });
  });

  it('EXPOSURE: a non-member can read who is seated', async () => {
    const { body } = await get(`/clubs/${clubId}/offline-sessions/active`, outsiderToken);
    expect((body as { activePlayerUids: string[] }).activePlayerUids).toContain(memberId);
  });

  it('EXPOSURE: a non-member can read every buy-in amount', async () => {
    const { status, body } = await get(
      `/clubs/${clubId}/offline-sessions/${sessionId}/buy-in-requests`,
      outsiderToken
    );

    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect((body as { amount: number }[])[0].amount).toBe(5_000);
  });
});

describe('club records', () => {
  it('EXPOSURE: a non-member can read session history', async () => {
    const { status } = await get(`/clubs/${clubId}/history`, outsiderToken);
    // listHistory branches on isClubAdmin but never asks whether the caller is
    // in the club at all, so a stranger gets the player view.
    expect(status).toBe(200);
  });

  it('EXPOSURE: a non-member can read the leaderboard when it is player-visible', async () => {
    const { status } = await get(`/clubs/${clubId}/leaderboard`, outsiderToken);
    // The visibility flag is about players vs admins. It was never intended to
    // answer "should someone outside the club see this", so it does not.
    expect(status).toBe(200);
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
