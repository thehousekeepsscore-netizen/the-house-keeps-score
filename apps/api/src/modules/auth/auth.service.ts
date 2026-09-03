import crypto from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../env.js";
import { hashPassword, verifyPassword } from "../../utils/password.js";
import {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  deriveReplacementRefreshToken,
  type AccessTokenPayload,
} from "../../utils/jwt.js";
import type { Prisma } from "@prisma/client";
import { HttpError } from "../../middleware/errorHandler.js";

const REFRESH_TTL_MS = parseDurationMs(env.JWT_REFRESH_TTL);

/**
 * How long after a rotation COMMITS the token it revoked may be presented
 * again and answered with the successor that rotation already issued.
 *
 * The clock is `revokedAt`, written inside the rotating transaction, never the
 * request's own start time — so the window is the same deterministic interval
 * for every observer and cannot be stretched by a slow request.
 *
 * Five seconds covers the case this exists for: the successor's response is
 * lost to a reload or a racing tab and the old token comes back within a
 * round trip or two (545 ms, measured). It is short enough that a stolen
 * predecessor presented inside it gains only the successor the victim already
 * holds, which the unchanged family sweep still catches at the next conflict.
 * Never raise it above ten seconds.
 */
export const REFRESH_REUSE_GRACE_MS = 5_000;

function parseDurationMs(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error(`Invalid duration: ${duration}`);
  const value = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * multipliers[unit];
}

export function toAuthPayload(user: { id: string; email: string; displayName: string; isSuperAdmin: boolean }): AccessTokenPayload {
  return { sub: user.id, email: user.email, displayName: user.displayName, isSuperAdmin: user.isSuperAdmin };
}

type Db = Prisma.TransactionClient | typeof prisma;

export async function issueTokenPair(
  userId: string,
  opts: {
    familyId?: string;
    userAgent?: string;
    ip?: string;
    /** A rotation supplies the derived successor; a first issue leaves this unset and gets a random one. */
    refreshToken?: string;
  },
  db: Db = prisma
) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const accessToken = signAccessToken(toAuthPayload(user));

  const refreshToken = opts.refreshToken ?? generateRefreshToken();
  const familyId = opts.familyId ?? crypto.randomUUID();

  await db.refreshToken.create({
    data: {
      userId,
      tokenHash: hashRefreshToken(refreshToken),
      familyId,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      userAgent: opts.userAgent,
      ip: opts.ip,
    },
  });

  return { accessToken, refreshToken, user };
}

// Sign-up only collects email + password — first/last name, mobile number
// and username are filled in on the profile-setup step right after, so this
// just needs a placeholder displayName until that happens.
export async function registerWithPassword(
  email: string,
  password: string,
  ctx: { userAgent?: string; ip?: string }
) {
  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) {
    throw new HttpError(409, "An account with this email already exists");
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase(),
      passwordHash,
      displayName: email.split("@")[0],
      lastLoginAt: new Date(),
    },
  });

  return issueTokenPair(user.id, ctx);
}

export async function loginWithPassword(
  email: string,
  password: string,
  ctx: { userAgent?: string; ip?: string }
) {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

  if (!user || !user.passwordHash || !user.isActive) {
    throw new HttpError(401, "Invalid email or password");
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    throw new HttpError(401, "Invalid email or password");
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return issueTokenPair(user.id, ctx);
}

type RefreshRow = {
  id: string;
  userId: string;
  familyId: string;
  revokedAt: Date | null;
  replacedBy: string | null;
  expiresAt: Date;
};

/**
 * Rotate a refresh token, or recognise the duplicate of a rotation that just
 * happened and answer it with the successor already issued.
 *
 * Serialised per token: the presented row is locked FOR UPDATE for the whole
 * transaction, so two requests carrying the same token cannot both see it as
 * active. The first rotates; the second waits, then reads the committed
 * `revokedAt` and takes the duplicate path. That, and the successor being
 * DERIVED from the token it replaces (utils/jwt.ts), is why there is never a
 * second successor: even a lock bypass would try to create the same
 * `tokenHash` and collide with the unique constraint.
 *
 * The duplicate path replays only when every link holds — the rotation was
 * committed within REFRESH_REUSE_GRACE_MS, it recorded a successor, that
 * successor is what derivation reproduces, and the successor row is still
 * this family's, this user's, unrevoked and itself unrotated. It writes
 * nothing. Anything short of that is what it always was: reuse, and the
 * family is revoked. A logged-out token has no successor and so never
 * replays; a token rotated before derivation existed has a random successor
 * that derivation cannot reproduce, and so never replays either.
 */
export async function refreshTokens(
  presentedToken: string,
  ctx: { userAgent?: string; ip?: string }
) {
  const tokenHash = hashRefreshToken(presentedToken);

  /*
   * The transaction never throws the reuse refusal itself. A throw inside it
   * would roll back the family sweep along with everything else, and reuse
   * detection would revoke nothing — the exact opposite of its purpose. So
   * the sweep is committed as the transaction's result, and the 401 is raised
   * only after it is durable.
   */
  const outcome = await prisma.$transaction(async (tx): Promise<
    | { kind: 'issued'; pair: Awaited<ReturnType<typeof issueTokenPair>> }
    | { kind: 'reuse' }
  > => {
    const rows = await tx.$queryRaw<RefreshRow[]>`
      SELECT id, "userId", "familyId", "revokedAt", "replacedBy", "expiresAt"
      FROM "RefreshToken" WHERE "tokenHash" = ${tokenHash} FOR UPDATE
    `;
    const existing = rows[0];

    if (!existing) {
      throw new HttpError(401, "Invalid refresh token");
    }

    if (existing.revokedAt) {
      const successor = await replayableSuccessor(tx, existing, presentedToken);
      if (successor) {
        // The rotation already happened and its answer was lost in transit.
        // Say it again. A fresh access token is signed because the old one
        // was never stored; the refresh token is the very one issued before.
        const user = await tx.user.findUniqueOrThrow({ where: { id: existing.userId } });
        return { kind: 'issued', pair: { accessToken: signAccessToken(toAuthPayload(user)), refreshToken: successor, user } };
      }
      // Reuse of a rotated-out token: treat as compromise, kill the whole family.
      await tx.refreshToken.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { kind: 'reuse' };
    }

    if (existing.expiresAt < new Date()) {
      throw new HttpError(401, "Refresh token expired");
    }

    const { accessToken, refreshToken, user } = await issueTokenPair(
      existing.userId,
      {
        familyId: existing.familyId,
        userAgent: ctx.userAgent,
        ip: ctx.ip,
        refreshToken: deriveReplacementRefreshToken(presentedToken, existing.familyId),
      },
      tx
    );

    await tx.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), replacedBy: hashRefreshToken(refreshToken) },
    });

    return { kind: 'issued', pair: { accessToken, refreshToken, user } };
  });

  if (outcome.kind === 'reuse') {
    throw new HttpError(401, "Refresh token reuse detected, please log in again");
  }
  return outcome.pair;
}

/**
 * The successor a duplicate presentation may be answered with, or null.
 *
 * Every condition is checked, none is inferred: the window is measured from
 * the committed `revokedAt`; the recorded successor hash must equal the hash
 * of what derivation produces from THIS token; and the successor row must be
 * the same family and user, unrevoked, and not itself rotated.
 */
async function replayableSuccessor(
  tx: Prisma.TransactionClient,
  revoked: RefreshRow,
  presentedToken: string
): Promise<string | null> {
  if (!revoked.revokedAt || !revoked.replacedBy) return null;
  if (Date.now() - revoked.revokedAt.getTime() > REFRESH_REUSE_GRACE_MS) return null;

  const derived = deriveReplacementRefreshToken(presentedToken, revoked.familyId);
  if (hashRefreshToken(derived) !== revoked.replacedBy) return null;

  const successor = await tx.refreshToken.findUnique({ where: { tokenHash: revoked.replacedBy } });
  if (!successor) return null;
  if (successor.familyId !== revoked.familyId || successor.userId !== revoked.userId) return null;
  if (successor.revokedAt !== null || successor.replacedBy !== null) return null;

  return derived;
}

export async function logout(presentedToken: string) {
  const tokenHash = hashRefreshToken(presentedToken);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// Self-service OAuth: link to an existing account by email if one exists,
// otherwise create a brand new account. (Lalwani's version requires an
// admin-provisioned account to already exist — poker is a consumer app
// where anyone should be able to sign in with Google directly.)
/**
 * Resolves the Google identity to a local user, creating one on first sign-in.
 *
 * Deliberately does NOT issue tokens. The token pair is minted later, by
 * /auth/oauth/exchange, so that the refresh cookie is set on a response served
 * from the front end's own origin. Minting here would set the cookie on the
 * Railway callback host, where the browser would scope it to that host and
 * never send it to the app — which is exactly the bug this split fixes.
 */
export async function findOrCreateOAuthUser(
  providerUserId: string,
  email: string,
  displayName: string,
  avatarUrl: string | undefined
): Promise<string> {
  const existingLink = await prisma.oAuthAccount.findUnique({
    where: { provider_providerUserId: { provider: "GOOGLE", providerUserId } },
  });

  if (existingLink) {
    await prisma.user.update({ where: { id: existingLink.userId }, data: { lastLoginAt: new Date() } });
    return existingLink.userId;
  }

  let user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

  if (!user) {
    // Best-effort prefill from Google's name — username still needs to be
    // chosen by the user on the profile-setup step (it's what routes them
    // there), same as email/password sign-up.
    const [firstName, ...rest] = displayName.trim().split(/\s+/);
    const lastName = rest.join(" ") || null;
    user = await prisma.user.create({
      data: { email: email.toLowerCase(), displayName, firstName: firstName || null, lastName, avatarUrl, lastLoginAt: new Date() },
    });
  } else {
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  }

  await prisma.oAuthAccount.create({ data: { provider: "GOOGLE", providerUserId, userId: user.id } });
  return user.id;
}
