import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticate } from "../../middleware/authenticate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as authController from "./auth.controller.js";
import { googleOAuthRouter } from "./oauth.google.js";

export const authRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

authRouter.post("/register", authLimiter, asyncHandler(authController.register));
authRouter.post("/login", authLimiter, asyncHandler(authController.login));
/**
 * Refresh gets its own, looser budget rather than sharing the login limiter.
 *
 * It takes a secret and says whether it is valid, so it needs a ceiling for the
 * same reason login does. But it is also called by legitimate clients far more
 * often: once on every app start, again whenever a 15-minute access token
 * expires, and once per open tab. Putting it on the login budget of 20 would
 * have signed people out for using the app in several tabs -- trading a real
 * usability failure for a marginal security gain, since a token guesser is
 * stopped just as dead by 60 as by 20 against a 48-byte random secret.
 */
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

authRouter.post("/refresh", refreshLimiter, asyncHandler(authController.refresh));
authRouter.post("/logout", asyncHandler(authController.logout));
authRouter.get("/me", authenticate, asyncHandler(authController.me));
authRouter.patch("/me", authenticate, asyncHandler(authController.updateMe));

authRouter.use(googleOAuthRouter);
