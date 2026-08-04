import crypto from "node:crypto";
import { Router } from "express";
import { env } from "../../env.js";
import { setEphemeral, consumeEphemeral } from "../../lib/ephemeralStore.js";
import { findOrCreateOAuthUser, issueTokenPair } from "./auth.service.js";
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

      const userId = await findOrCreateOAuthUser(
        profile.sub,
        profile.email,
        profile.name || profile.email.split("@")[0],
        profile.picture
      );

      // No tokens are minted here, and no cookie is set here.
      //
      // This response is served by the API's own host, which is not the origin
      // the user is browsing. A Set-Cookie on it is scoped to that host, so the
      // browser would never send it back with the app's requests — Google
      // sign-ins had no persistent session at all as a result. Tokens are
      // instead minted by /oauth/exchange, which the front end calls
      // same-origin.
      //
      // The one-time code carries only a user id. No access token, no refresh
      // token, nothing bearer-shaped ever enters the ephemeral store or the
      // redirect URL (which would leak into history, access logs and Referer).
      const loginCode = crypto.randomBytes(24).toString("hex");
      setEphemeral(`oauth:code:${loginCode}`, JSON.stringify({ userId }), LOGIN_CODE_TTL_MS);

      res.redirect(`${env.WEB_ORIGIN}/oauth/callback?code=${loginCode}`);
    } catch (err) {
      console.error("Google OAuth callback failed:", err);
      res.redirect(`${loginUrl}?error=oauth_failed`);
    }
  })
);

/**
 * Completes a Google sign-in. Called by the front end from its own origin,
 * which is what makes it the right place to issue the refresh cookie.
 *
 * consumeEphemeral is single-use: the code is deleted as it is read, so a
 * replayed code fails even within its 60s TTL.
 *
 * The refresh token is created here, written straight to an httpOnly cookie,
 * and never appears in the JSON body — so it is unreachable from client-side
 * JavaScript. Only the access token and the public user object are returned.
 */
googleOAuthRouter.post(
  "/oauth/exchange",
  asyncHandler(async (req, res) => {
    const { code } = req.body as { code?: string };
    if (!code) return res.status(400).json({ error: "Missing code" });

    const raw = consumeEphemeral(`oauth:code:${code}`);
    if (!raw) return res.status(400).json({ error: "Invalid or expired code" });

    const { userId } = JSON.parse(raw) as { userId: string };

    // ctx is captured from this request rather than the callback: this is the
    // user's actual browser, so the session audit records the right agent/IP.
    const { accessToken, refreshToken, user } = await issueTokenPair(userId, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });

    setRefreshCookie(res, refreshToken);
    return res.json({ accessToken, user: publicUser(user) });
  })
);
