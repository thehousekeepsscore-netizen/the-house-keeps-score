import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import { deploymentIdentity } from "./lib/deploymentIdentity.js";
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

// Security headers. This process serves JSON to a separate origin, so the
// headers that matter are the ones that constrain how a response may be
// interpreted or embedded, not a content policy for a page it never renders.
// contentSecurityPolicy is disabled for that reason rather than overlooked:
// a default CSP on a pure API adds a header nothing enforces.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));

// A bounded body. express.json() defaults to 100kb, but relying on a library
// default for a limit that protects the process is how it silently changes on
// upgrade. The largest legitimate request is a settlement, which is a handful
// of players and their figures -- kilobytes.
app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());

// Health is deliberately above the limiter: it is what Railway polls to decide
// whether this instance is alive, and rate-limiting it would turn a traffic
// spike into a restart loop.
//
// It now answers a second question as well as "is it up": WHICH BUILD is up.
// `{"status":"ok"}` alone could not tell anyone whether an instance had picked
// up a merge, which is exactly what you need to know before running a data
// migration or a historical correction against it. Every field is read rather
// than guessed — see deploymentIdentity.ts. Still no database call: this is a
// liveness probe, and a query here would turn a slow database into a restart
// loop.
app.get("/api/health", (_req, res) => res.json(deploymentIdentity()));

/**
 * A ceiling on API traffic per client.
 *
 * /auth was already limited, which covers password guessing. Nothing else was,
 * including the endpoints that move money -- settle, buy-in, approve -- and
 * including /auth/refresh, which takes a token and is therefore guessable in
 * exactly the way the login limiter exists to prevent.
 *
 * Set well above real use rather than tightly: entering a club costs about nine
 * requests and the dashboard polls every fifteen seconds, so a busy admin might
 * make a few dozen a minute. This stops a script, not a person.
 *
 * `trust proxy` is set in production, so this keys on the real client address
 * rather than Railway's edge -- without that every user would share one bucket.
 */
const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — slow down and try again shortly" },
});
app.use("/api", apiLimiter);

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
