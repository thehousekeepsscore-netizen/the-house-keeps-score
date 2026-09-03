import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { env } from "../env.js";

export interface AccessTokenPayload {
  sub: string;
  email: string;
  displayName: string;
  isSuperAdmin: boolean;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions["expiresIn"] });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}

// Refresh tokens are opaque random strings, not JWTs — the DB row (hashed) is
// the source of truth so a single token can be revoked without a blacklist.
export function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString("hex");
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * The refresh token that replaces `previous` when it is rotated.
 *
 * Deterministic on purpose. A rotation revokes the presented token and mints
 * its successor; if the response carrying that successor never reaches the
 * client — a reload mid-flight, a second tab that raced — the client's next
 * refresh presents the old token again, milliseconds later, and reuse
 * detection reads that as theft and revokes the whole family. Production
 * showed exactly this: a family swept 545 ms after its own rotation, and a
 * forced Google re-login five seconds later.
 *
 * Deriving the successor from its predecessor lets the server recognise that
 * duplicate and hand back THE SAME successor it already issued, without ever
 * storing a bearer token in plaintext: it recomputes it, and checks the hash
 * against what the rotation recorded in `replacedBy`. The link is to that
 * exact rotation and that exact successor — not to "any recently revoked
 * token".
 *
 * Keyed with its own secret (see env.ts). Without it a predecessor reveals
 * nothing about its successor; with it, an attacker could already forge
 * nothing they could not forge by holding the server's secrets. First-issue
 * tokens (login, register, OAuth exchange) stay random — there is nothing to
 * derive them from and no duplicate to recognise.
 */
export function deriveReplacementRefreshToken(previous: string, familyId: string): string {
  return crypto
    .createHmac("sha256", env.REFRESH_TOKEN_DERIVATION_SECRET)
    .update(`${familyId}:${previous}`)
    .digest("hex");
}
