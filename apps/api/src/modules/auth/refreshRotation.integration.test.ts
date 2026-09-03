import { describe, it, expect, afterEach, beforeAll } from 'vitest';

/**
 * Refresh-token rotation, its duplicates, and the line between a lost
 * response and a stolen token.
 *
 * Every refresh revokes the presented token and mints a successor. That is
 * right, and it has one failure: if the response carrying the successor never
 * reaches the client — a reload mid-flight, a second tab that raced — the next
 * refresh presents the old token again, milliseconds later, and reuse
 * detection treats it as theft and revokes the whole family. Production showed
 * exactly this: a family swept 545 ms after its own rotation, and a forced
 * Google re-login five seconds later.
 *
 * So the successor is now DERIVED from its predecessor, and a duplicate that
 * arrives within REFRESH_REUSE_GRACE_MS of the committed rotation is answered
 * with the very successor already issued — no write, no second successor, no
 * sweep. Outside that window, or when any link in the chain fails to hold, the
 * behaviour is exactly what it was.
 *
 * These drive the service against the real database through the real
 * transaction, because the property that matters most — two concurrent
 * presentations cannot mint two successors — is a property of the row lock,
 * and only the database can prove it.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

process.env.REFRESH_TOKEN_DERIVATION_SECRET ??= 'integration-test-derivation-secret-0123456789';

const { prisma } = await import('../../lib/prisma.js');
const { issueTokenPair, refreshTokens, logout, REFRESH_REUSE_GRACE_MS } = await import('./auth.service.js');
const { hashRefreshToken, deriveReplacementRefreshToken, generateRefreshToken } = await import('../../utils/jwt.js');
const { HttpError } = await import('../../middleware/errorHandler.js');

let userId = '';
const ctx = { userAgent: 'test-agent', ip: '127.0.0.1' };

beforeAll(() => {
  // The window is a security boundary; a change to it must be deliberate.
  expect(REFRESH_REUSE_GRACE_MS).toBe(5_000);
});

afterEach(async () => {
  if (!userId) return;
  await prisma.refreshToken.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  userId = '';
});

async function seedUser() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await prisma.user.create({
    data: { email: `rotate-${stamp}@test.local`, passwordHash: 'x', displayName: 'Rotate Tester' },
  });
  userId = user.id;
  return user.id;
}

/** A first-issue pair, as login would produce. */
async function firstPair() {
  const id = await seedUser();
  return issueTokenPair(id, ctx);
}

const rowOf = (token: string) =>
  prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: hashRefreshToken(token) } });

const activeRows = (familyId: string) =>
  prisma.refreshToken.count({ where: { familyId, revokedAt: null } });

/** Backdate a committed rotation so it falls outside the grace window. */
async function ageRotation(token: string, ms: number) {
  await prisma.refreshToken.update({
    where: { tokenHash: hashRefreshToken(token) },
    data: { revokedAt: new Date(Date.now() - ms) },
  });
}

const status = async (p: Promise<unknown>) =>
  p.then(() => 200, (e) => (e instanceof HttpError ? e.status : -1));

describe('the first presentation rotates once', () => {
  it('revokes the presented token, records its successor, and issues the derived one', async () => {
    const first = await firstPair();
    const family = (await rowOf(first.refreshToken)).familyId;

    const second = await refreshTokens(first.refreshToken, ctx);

    const old = await rowOf(first.refreshToken);
    expect(old.revokedAt).not.toBeNull();
    expect(old.replacedBy).toBe(hashRefreshToken(second.refreshToken));
    expect(second.refreshToken).toBe(deriveReplacementRefreshToken(first.refreshToken, family));
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(await activeRows(family)).toBe(1);
  });

  it('keeps the first issue random — there is nothing to derive it from', async () => {
    const a = await firstPair();
    const b = await issueTokenPair(userId, ctx);
    expect(a.refreshToken).not.toBe(b.refreshToken);
    expect(a.refreshToken).toHaveLength(96);
  });
});

describe('a duplicate within the grace window replays the successor', () => {
  it('returns the exact successor, writes nothing, and leaves the family intact', async () => {
    const first = await firstPair();
    const family = (await rowOf(first.refreshToken)).familyId;
    const second = await refreshTokens(first.refreshToken, ctx);
    const rowsBefore = await prisma.refreshToken.findMany({ where: { familyId: family }, orderBy: { createdAt: 'asc' } });

    // The same old token, again — the response to the rotation was lost.
    const replay = await refreshTokens(first.refreshToken, ctx);

    expect(replay.refreshToken, 'the very successor already issued').toBe(second.refreshToken);
    expect(replay.user.id).toBe(userId);
    const rowsAfter = await prisma.refreshToken.findMany({ where: { familyId: family }, orderBy: { createdAt: 'asc' } });
    expect(rowsAfter, 'no write: not a row, not a timestamp').toEqual(rowsBefore);
    expect(await activeRows(family)).toBe(1);
  });

  it('signs a fresh access token on replay, and it is a valid one', async () => {
    const first = await firstPair();
    await refreshTokens(first.refreshToken, ctx);
    const replay = await refreshTokens(first.refreshToken, ctx);
    const { verifyAccessToken } = await import('../../utils/jwt.js');
    expect(verifyAccessToken(replay.accessToken).sub).toBe(userId);
  });

  it('the replayed successor still rotates normally afterwards', async () => {
    const first = await firstPair();
    const family = (await rowOf(first.refreshToken)).familyId;
    const second = await refreshTokens(first.refreshToken, ctx);
    const replay = await refreshTokens(first.refreshToken, ctx);
    expect(replay.refreshToken).toBe(second.refreshToken);

    const third = await refreshTokens(second.refreshToken, ctx);
    expect(third.refreshToken).toBe(deriveReplacementRefreshToken(second.refreshToken, family));
    expect(await activeRows(family)).toBe(1);
  });

  it('a duplicate arriving after the successor was itself rotated is reuse, not a lost response', async () => {
    const first = await firstPair();
    const family = (await rowOf(first.refreshToken)).familyId;
    const second = await refreshTokens(first.refreshToken, ctx);
    await refreshTokens(second.refreshToken, ctx);

    // The successor has moved on; handing it out again would hand out a dead
    // token to whoever holds the predecessor — and that is not the client
    // that lost a response.
    expect(await status(refreshTokens(first.refreshToken, ctx))).toBe(401);
    expect(await activeRows(family), 'family swept').toBe(0);
  });
});

describe('a duplicate after the grace window is reuse, exactly as before', () => {
  it('revokes the whole family and answers 401', async () => {
    const first = await firstPair();
    const family = (await rowOf(first.refreshToken)).familyId;
    await refreshTokens(first.refreshToken, ctx);
    await ageRotation(first.refreshToken, REFRESH_REUSE_GRACE_MS + 1);

    expect(await status(refreshTokens(first.refreshToken, ctx))).toBe(401);
    expect(await activeRows(family)).toBe(0);
  });

  it('the boundary is the committed revokedAt, measured in milliseconds', async () => {
    // Just inside: replays. One past: sweeps. The clock is the row's own
    // timestamp, not when this request started.
    const inside = await firstPair();
    const insideFamily = (await rowOf(inside.refreshToken)).familyId;
    const insideSecond = await refreshTokens(inside.refreshToken, ctx);
    await ageRotation(inside.refreshToken, REFRESH_REUSE_GRACE_MS - 500);
    expect((await refreshTokens(inside.refreshToken, ctx)).refreshToken).toBe(insideSecond.refreshToken);
    expect(await activeRows(insideFamily)).toBe(1);
  });
});

describe('links that must hold for a replay', () => {
  it('a logged-out token has no successor and never replays', async () => {
    const first = await firstPair();
    const family = (await rowOf(first.refreshToken)).familyId;
    await logout(first.refreshToken);
    const row = await rowOf(first.refreshToken);
    expect(row.revokedAt).not.toBeNull();
    expect(row.replacedBy).toBeNull();

    expect(await status(refreshTokens(first.refreshToken, ctx))).toBe(401);
    expect(await activeRows(family)).toBe(0);
  });

  it('a rotation recorded before derivation existed (random successor) never replays', async () => {
    // Simulate the pre-deployment shape: revoked just now, with a successor
    // that derivation cannot reproduce.
    const first = await firstPair();
    const family = (await rowOf(first.refreshToken)).familyId;
    const legacySuccessor = generateRefreshToken();
    await prisma.refreshToken.create({
      data: { userId, tokenHash: hashRefreshToken(legacySuccessor), familyId: family, expiresAt: new Date(Date.now() + 60_000) },
    });
    await prisma.refreshToken.update({
      where: { tokenHash: hashRefreshToken(first.refreshToken) },
      data: { revokedAt: new Date(), replacedBy: hashRefreshToken(legacySuccessor) },
    });

    expect(await status(refreshTokens(first.refreshToken, ctx))).toBe(401);
    expect(await activeRows(family), 'swept, as today').toBe(0);
  });

  it('a successor that has been revoked never replays', async () => {
    const first = await firstPair();
    const family = (await rowOf(first.refreshToken)).familyId;
    const second = await refreshTokens(first.refreshToken, ctx);
    await logout(second.refreshToken);

    expect(await status(refreshTokens(first.refreshToken, ctx))).toBe(401);
    expect(await activeRows(family)).toBe(0);
  });

  it('a successor row belonging to another family or user never replays', async () => {
    // Defence in depth: the hash link is unique, but the row is checked too.
    const first = await firstPair();
    const family = (await rowOf(first.refreshToken)).familyId;
    const second = await refreshTokens(first.refreshToken, ctx);
    await prisma.refreshToken.update({
      where: { tokenHash: hashRefreshToken(second.refreshToken) },
      data: { familyId: 'some-other-family' },
    });

    expect(await status(refreshTokens(first.refreshToken, ctx))).toBe(401);
    expect(await activeRows(family)).toBe(0);
  });

  it('an unknown token is still simply invalid', async () => {
    await seedUser();
    expect(await status(refreshTokens('not-a-token', ctx))).toBe(401);
  });
});

describe('two truly concurrent presentations cannot mint two successors', () => {
  it('both answers carry the same refresh token, one row is created, one successor is active, the family stands', async () => {
    /*
     * THE PROPERTY THE ROW LOCK EXISTS FOR.
     *
     * Two requests with the same token, in flight at once, through the real
     * transaction against the real database. Without FOR UPDATE both would
     * read the token as active, both would mint, and two valid successors
     * would exist for one presentation. With it, the second waits, then finds
     * the rotation committed and replays. Driven concurrently rather than
     * sequentially so that the lock, not the ordering, is what is proven.
     */
    const first = await firstPair();
    const family = (await rowOf(first.refreshToken)).familyId;
    const rowsBefore = await prisma.refreshToken.count({ where: { familyId: family } });

    const [a, b] = await Promise.all([
      refreshTokens(first.refreshToken, ctx),
      refreshTokens(first.refreshToken, ctx),
    ]);

    expect(a.refreshToken).toBe(b.refreshToken);
    expect(a.refreshToken).toBe(deriveReplacementRefreshToken(first.refreshToken, family));
    expect(await prisma.refreshToken.count({ where: { familyId: family } }), 'exactly one row created').toBe(rowsBefore + 1);
    expect(await activeRows(family), 'exactly one active successor').toBe(1);
    const old = await rowOf(first.refreshToken);
    expect(old.replacedBy).toBe(hashRefreshToken(a.refreshToken));
  });

  it('holds under a wider burst as well', async () => {
    const first = await firstPair();
    const family = (await rowOf(first.refreshToken)).familyId;

    const results = await Promise.all(Array.from({ length: 6 }, () => refreshTokens(first.refreshToken, ctx)));

    expect(new Set(results.map((r) => r.refreshToken)).size, 'one successor for everybody').toBe(1);
    expect(await activeRows(family)).toBe(1);
    expect(await prisma.refreshToken.count({ where: { familyId: family } })).toBe(2);
  });
});
