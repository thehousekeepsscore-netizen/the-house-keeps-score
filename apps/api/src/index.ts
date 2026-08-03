import { createServer } from "node:http";
import { app } from "./app.js";
import { env } from "./env.js";
import { prisma } from "./lib/prisma.js";
import { describeMessaging } from "./lib/messaging.js";
import { describeSeedCredentialRisk } from "./lib/seedGuard.js";
import { initSocket } from "./realtime/socket.js";
import { sweepExpiredTurns } from "./modules/sessions/sessions.service.js";
import { expireStaleRequests } from "./modules/offlineSessions/offlineSessions.service.js";

const httpServer = createServer(app);
initSocket(httpServer);

setInterval(() => {
  sweepExpiredTurns().catch((err) => console.error("Turn timeout sweep failed:", err));
}, 1000);

// Auto-reject buy-in/sit-in/cash-out requests left un-actioned past their TTL.
// The decide* paths enforce the deadline exactly on their own; this only keeps
// the admin's queue honest and pushes the update to open clients.
setInterval(() => {
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
