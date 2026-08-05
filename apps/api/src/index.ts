import { createServer } from "node:http";
import { app } from "./app.js";
import { env } from "./env.js";
import { prisma } from "./lib/prisma.js";
import { describeMessaging } from "./lib/messaging.js";
import { describeSeedCredentialRisk } from "./lib/seedGuard.js";
import { initSocket, disconnectAllSockets } from "./realtime/socket.js";
// STOPPED alongside the Virtual Table route unmount in app.ts — see below.
// import { sweepExpiredTurns } from "./modules/sessions/sessions.service.js";
import { expireStaleRequests } from "./modules/offlineSessions/offlineSessions.service.js";

const httpServer = createServer(app);
initSocket(httpServer);

// Virtual Table turn-timeout sweep — STOPPED, since the routes that create
// those sessions are unmounted in app.ts. It ran once per second against
// PokerSession, i.e. ~86,400 queries a day, and had nothing to act on: the one
// VIRTUAL_TABLE row in the database sits at street "Showdown" with
// currentTurnSeat null, which the sweep's own guard skips.
//
// Restore this together with the route mounts, not on its own.
//
// setInterval(() => {
//   sweepExpiredTurns().catch((err) => console.error("Turn timeout sweep failed:", err));
// }, 1000);

// Auto-reject buy-in/sit-in/cash-out requests left un-actioned past their TTL.
// The decide* paths enforce the deadline exactly on their own; this only keeps
// the admin's queue honest and pushes the update to open clients.
const sweepTimer = setInterval(() => {
  expireStaleRequests().catch((err) => console.error("Stale request sweep failed:", err));
}, 15_000);

/**
 * Startup summary.
 *
 * Every line here is something that has silently broken a deployment before, or
 * is documented as likely to: messaging quietly falling back to no-op, a
 * WEB_ORIGIN that doesn't match the deployed front end (CORS blocks everything),
 * OAuth half-configured, a database that resolves but can't be reached.
 *
 * The database line is an actual query rather than "a URL is set" — the point of
 * the summary is to report what is true, not what is configured.
 */
async function printStartupSummary() {
  let database = "connected";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    database = `UNREACHABLE — ${err instanceof Error ? err.message.split("\n")[0] : "unknown error"}`;
  }

  const oauth =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CALLBACK_URL
      ? `configured · callback ${env.GOOGLE_CALLBACK_URL}`
      : "not configured";

  const line = "─".repeat(64);
  console.log(
    [
      line,
      `  Environment  : ${env.NODE_ENV}`,
      `  Listening    : http://localhost:${env.PORT}`,
      `  Web origin   : ${env.WEB_ORIGIN}   (must match the deployed front end)`,
      `  Database     : ${database}`,
      `  Socket.IO    : enabled`,
      `  Messaging    : ${describeMessaging()}`,
      `  Google OAuth : ${oauth}`,
      line,
    ].join("\n")
  );

  // Not a startup failure — a default seed password is harmless on a laptop.
  // It's printed every boot, in every environment, because the failure mode is
  // a default quietly surviving from first-run to deploy day.
  const seedRisk = describeSeedCredentialRisk();
  if (seedRisk) {
    console.warn(`  ⚠  Seed credentials: ${seedRisk} — change before deploying.\n${line}`);
  }
}

httpServer.listen(env.PORT, () => {
  void printStartupSummary();
});

/**
 * Shut down without dropping work on the floor.
 *
 * Railway sends SIGTERM on every redeploy and then kills the process shortly
 * after. Without a handler, node exits the moment the platform decides to stop
 * it: requests in flight are severed mid-response, and -- the part that matters
 * for an app that moves money -- a settlement can be interrupted between its
 * database transaction committing and its response being written, so the client
 * sees a network failure for work that actually succeeded.
 *
 * The order is deliberate. Stop accepting new connections first, so nothing new
 * arrives while we drain. Close the sockets next, because an open WebSocket
 * keeps the HTTP server's close() callback from ever firing. Disconnect Prisma
 * last, once nothing can still be querying it.
 *
 * The timeout is a backstop, not the plan: if a request hangs, exiting late is
 * worse than exiting hard, because the platform will kill us anyway and a
 * half-shut-down process just delays the new one taking over.
 */
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down`);

  const forceExit = setTimeout(() => {
    console.error("Shutdown timed out after 10s — exiting immediately");
    process.exit(1);
  }, 10_000);
  // Do not let the backstop itself hold the event loop open.
  forceExit.unref();

  clearInterval(sweepTimer);

  try {
    disconnectAllSockets();
    await new Promise<void>((resolve, reject) =>
      httpServer.close((err) => (err ? reject(err) : resolve()))
    );
    await prisma.$disconnect();
    console.log("Shutdown complete");
    process.exit(0);
  } catch (err) {
    console.error("Shutdown failed:", err);
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// An unhandled rejection leaves the process in an unknown state. Logging and
// carrying on is how a pod ends up serving traffic with a broken database pool
// and no outward sign of it.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
  void shutdown("unhandledRejection");
});
