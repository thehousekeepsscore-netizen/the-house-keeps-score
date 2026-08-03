import type { Request, Response } from "express";
import { z } from "zod";
import { env } from "../../env.js";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../middleware/errorHandler.js";
import {
  registerWithPassword,
  loginWithPassword,
  refreshTokens,
  logout as logoutService,
} from "./auth.service.js";

const REFRESH_COOKIE = "refreshToken";
const REFRESH_COOKIE_MAX_AGE = 30 * 86_400_000;

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: REFRESH_COOKIE_MAX_AGE,
  });
}

function publicUser(user: {
  id: string;
  email: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  avatarUrl: string | null;
  phoneNumber: string | null;
  themePreference: string;
  isSuperAdmin: boolean;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    avatarUrl: user.avatarUrl,
    phoneNumber: user.phoneNumber,
    themePreference: user.themePreference,
    isSuperAdmin: user.isSuperAdmin,
    // The client uses this to decide whether to route to the profile-setup
    // step — username is the last field collected there, so its presence
    // means the user has been through it.
    profileComplete: user.username != null,
  };
}

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export async function register(req: Request, res: Response) {
  const { email, password } = registerSchema.parse(req.body);
  const ctx = { userAgent: req.headers["user-agent"], ip: req.ip };
  const result = await registerWithPassword(email, password, ctx);

  setRefreshCookie(res, result.refreshToken);
  return res.status(201).json({ accessToken: result.accessToken, user: publicUser(result.user) });
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function login(req: Request, res: Response) {
  const { email, password } = loginSchema.parse(req.body);
  const ctx = { userAgent: req.headers["user-agent"], ip: req.ip };
  const result = await loginWithPassword(email, password, ctx);

  setRefreshCookie(res, result.refreshToken);
  return res.json({ accessToken: result.accessToken, user: publicUser(result.user) });
}

export async function refresh(req: Request, res: Response) {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) throw new HttpError(401, "Missing refresh token");

  const ctx = { userAgent: req.headers["user-agent"], ip: req.ip };
  const result = await refreshTokens(token, ctx);

  setRefreshCookie(res, result.refreshToken);
  return res.json({ accessToken: result.accessToken, user: publicUser(result.user) });
}

export async function logout(req: Request, res: Response) {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (token) await logoutService(token);
  res.clearCookie(REFRESH_COOKIE);
  return res.status(204).send();
}

export async function me(req: Request, res: Response) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.sub } });
  return res.json(publicUser(user));
}

const usernamePattern = /^[a-z0-9_]+$/i;

const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(60).optional(),
  firstName: z.string().min(1).max(60).optional(),
  lastName: z.string().min(1).max(60).optional(),
  username: z.string().min(3).max(24).regex(usernamePattern, "Letters, numbers and underscores only").optional(),
  avatarUrl: z.string().max(2_000_000).optional(), // generous — client sends a base64 data URL
  phoneNumber: z.string().max(30).optional(),
  themePreference: z.enum(["arctic-bluff", "emerald-gold", "royal-purple", "midnight-ruby", "poker-lounge"]).optional(),
});

export async function updateMe(req: Request, res: Response) {
  const input = updateProfileSchema.parse(req.body);

  if (input.username) {
    const existing = await prisma.user.findUnique({ where: { username: input.username } });
    if (existing && existing.id !== req.user!.sub) {
      throw new HttpError(409, "That username is already taken");
    }
  }

  // displayName follows first/last name once both are known, so the rest of
  // the app (which reads displayName everywhere) picks up the real name.
  const firstName = input.firstName;
  const lastName = input.lastName;
  const data: typeof input & { displayName?: string } = { ...input };
  if (firstName || lastName) {
    const current = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.sub } });
    const combined = [firstName ?? current.firstName, lastName ?? current.lastName].filter(Boolean).join(" ");
    if (combined) data.displayName = combined;
  }

  const user = await prisma.user.update({ where: { id: req.user!.sub }, data });
  return res.json(publicUser(user));
}

export { setRefreshCookie, publicUser };
