import crypto from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../env.js";
import { hashPassword, verifyPassword } from "../../utils/password.js";
import { signAccessToken, generateRefreshToken, hashRefreshToken, type AccessTokenPayload } from "../../utils/jwt.js";
import { HttpError } from "../../middleware/errorHandler.js";

const REFRESH_TTL_MS = parseDurationMs(env.JWT_REFRESH_TTL);

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

export async function issueTokenPair(userId: string, opts: { familyId?: string; userAgent?: string; ip?: string }) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const accessToken = signAccessToken(toAuthPayload(user));

  const refreshToken = generateRefreshToken();
  const familyId = opts.familyId ?? crypto.randomUUID();

  await prisma.refreshToken.create({
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

export async function refreshTokens(
  presentedToken: string,
  ctx: { userAgent?: string; ip?: string }
) {
  const tokenHash = hashRefreshToken(presentedToken);
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!existing) {
    throw new HttpError(401, "Invalid refresh token");
  }

  if (existing.revokedAt) {
    // Reuse of a rotated-out token: treat as compromise, kill the whole family.
    await prisma.refreshToken.updateMany({
      where: { familyId: existing.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new HttpError(401, "Refresh token reuse detected, please log in again");
  }

  if (existing.expiresAt < new Date()) {
    throw new HttpError(401, "Refresh token expired");
  }

  const { accessToken, refreshToken, user } = await issueTokenPair(existing.userId, {
    familyId: existing.familyId,
    userAgent: ctx.userAgent,
    ip: ctx.ip,
  });

  await prisma.refreshToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date(), replacedBy: hashRefreshToken(refreshToken) },
  });

  return { accessToken, refreshToken, user };
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
