import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { env } from "./env.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { clubsRouter } from "./modules/clubs/clubs.routes.js";
import { clubSessionsRouter, sessionsRouter } from "./modules/sessions/sessions.routes.js";
import { offlineSessionsRouter } from "./modules/offlineSessions/offlineSessions.routes.js";
import { clubRecordsRouter } from "./modules/clubRecords/clubRecords.routes.js";
import { errorHandler } from "./middleware/errorHandler.js";

export const app = express();

// Behind a reverse proxy (any managed host: Render, Railway, Fly, nginx), the
// socket peer is the proxy, so req.ip is the proxy's address for every client.
// That collapses the auth rate limiter in auth.routes.ts into a single shared
// bucket — one noisy client locks out everyone — and files every login audit
// entry under the same IP. Trusting one hop makes req.ip the real client.
//
// Production only, and 1 hop rather than `true`: trusting the header when
// nothing strips it lets any client set X-Forwarded-For and get a fresh rate
// limit bucket per request. In development there is no proxy, so this stays off
// and req.ip remains the direct peer.
if (env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api/auth", authRouter);
app.use("/api/clubs", clubsRouter);
app.use("/api/clubs/:clubId/sessions", clubSessionsRouter);
app.use("/api/sessions", sessionsRouter);
app.use("/api/clubs/:clubId/offline-sessions", offlineSessionsRouter);
app.use("/api/clubs/:clubId", clubRecordsRouter);

app.use(errorHandler);
