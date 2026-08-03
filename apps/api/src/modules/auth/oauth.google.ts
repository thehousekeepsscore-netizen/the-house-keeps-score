import crypto from "node:crypto";
import { Router } from "express";
import { env } from "../../env.js";
import { setEphemeral, consumeEphemeral } from "../../lib/ephemeralStore.js";
import { findOrCreateOAuthUser } from "./auth.service.js";
import { setRefreshCookie, publicUser } from "./auth.controller.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const googleOAuthRouter = Router();

const STATE_TTL_MS = 10 * 60 * 1000;
const LOGIN_CODE_TTL_MS = 60 * 1000;

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

function googleEnabled() {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CALLBACK_URL);
}

googleOAuthRouter.get("/google", (req, res) => {
  if (!googleEnabled()) {
    return res.status(503).json({ error: "Google sign-in is not configured on this server" });
  }

  const state = crypto.randomBytes(24).toString("hex");
  setEphemeral(`oauth:state:${state}`, "1", STATE_TTL_MS);

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", env.GOOGLE_CALLBACK_URL!);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

googleOAuthRouter.get(
  "/google/callback",
  asyncHandler(async (req, res) => {
    const { code, state } = req.query as { code?: string; state?: string };
    const loginUrl = `${env.WEB_ORIGIN}/login`;

    if (!code || !state || !consumeEphemeral(`oauth:state:${state}`)) {
      return res.redirect(`${loginUrl}?error=oauth_state`);
    }

    try {
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID!,
          client_secret: env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: env.GOOGLE_CALLBACK_URL!,
          grant_type: "authorization_code",
        }),
      });
      if (!tokenRes.ok) throw new Error("token exchange failed");
      const tokenData = (await tokenRes.json()) as { access_token: string };

      const profileRes = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (!profileRes.ok) throw new Error("userinfo fetch failed");
      const profile = (await profileRes.json()) as { sub: string; email: string; name?: string; picture?: string };

      const ctx = { userAgent: req.headers["user-agent"], ip: req.ip };
      const result = await findOrCreateOAuthUser(profile.sub, profile.email, profile.name || profile.email.split("@")[0], profile.picture, ctx);

      setRefreshCookie(res, result.refreshToken);

      // Hand the access token back via a short-lived one-time code instead of
      // putting the JWT directly in the redirect URL (which would leak into
      // browser history / server access logs / Referer headers).
      const loginCode = crypto.randomBytes(24).toString("hex");
      setEphemeral(`oauth:code:${loginCode}`, JSON.stringify({ accessToken: result.accessToken, user: publicUser(result.user) }), LOGIN_CODE_TTL_MS);

      res.redirect(`${env.WEB_ORIGIN}/oauth/callback?code=${loginCode}`);
    } catch (err) {
      console.error("Google OAuth callback failed:", err);
      res.redirect(`${loginUrl}?error=oauth_failed`);
    }
  })
);

googleOAuthRouter.post("/oauth/exchange", (req, res) => {
  const { code } = req.body as { code?: string };
  if (!code) return res.status(400).json({ error: "Missing code" });

  const raw = consumeEphemeral(`oauth:code:${code}`);
  if (!raw) return res.status(400).json({ error: "Invalid or expired code" });

  return res.json(JSON.parse(raw));
});
