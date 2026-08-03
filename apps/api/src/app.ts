import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { env } from "./env.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { clubsRouter } from "./modules/clubs/clubs.routes.js";
// UNMOUNTED before first deployment — see the note at the route mounts below.
// import { clubSessionsRouter, sessionsRouter } from "./modules/sessions/sessions.routes.js";
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
// ---------------------------------------------------------------------------
// Virtual Table (turn-based poker engine) — UNMOUNTED before first deployment.
//
// The frontend for this feature is unreachable: nothing imports VirtualTableView
// or LazyDealerConsole, and neither appears in the production bundle (verified
// against a real `vite build`). The backend, however, was still mounted and
// accepting authenticated requests.
//
// That mattered because endSession writes to CashOutSettlement
// (sessions.service.ts:367) — the same table real cash-outs use — and neither
// the history query (clubRecords.service.ts:264) nor the leaderboard query
// (line 377) filters on sessionType. So a virtual-table row would appear in
// real history and count toward real profit totals. Creation was also ungated:
// createVirtualTableSession performs no club membership or role check, unlike
// every other money route (compare clubsService.assertClubAdmin in
// offlineSessions.startSession).
//
// It never reached computeSettlement, clubPotBalance or the pot ledger, so this
// was an integrity risk to what players *see*, not to the money itself.
//
// Nothing is deleted. To revive the feature, uncomment the import above and the
// two lines below — but gate creation on club membership and add a sessionType
// filter to the history and leaderboard queries first.
//
// app.use("/api/clubs/:clubId/sessions", clubSessionsRouter);
// app.use("/api/sessions", sessionsRouter);
// ---------------------------------------------------------------------------
app.use("/api/clubs/:clubId/offline-sessions", offlineSessionsRouter);
app.use("/api/clubs/:clubId", clubRecordsRouter);

app.use(errorHandler);
