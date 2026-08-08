import { PrismaClient } from "@prisma/client";

/**
 * One client, with a pool small enough for the database in front of it.
 *
 * Prisma's default pool is `num_cpus * 2 + 1` per process, decided by the
 * container it happens to land on and by nothing about the database. Production
 * sits behind a pooler in session mode with **fifteen client slots in total**,
 * shared by every instance — so two containers on a four-core host ask for
 * eighteen and the pooler starts refusing:
 *
 *     FATAL: (EMAXCONNSESSION) max clients reached in session mode
 *            — max clients are limited to pool_size: 15
 *
 * That refusal is what took the API down: the error surfaced inside a Socket.IO
 * join, which had no catch, so it became an unhandledRejection and the process
 * shut itself down. Every reconnect retried the same join, so it came back and
 * died again. The join is guarded now (realtime/socket.ts) — this is the other
 * half, which is not asking for more connections than exist.
 *
 * Deliberately not raised to match the pooler: a bound WELL BELOW the limit is
 * what leaves room for a second instance, a deploy overlapping the old one, and
 * migrations. Queries queue for `pool_timeout` seconds rather than failing, and
 * queueing briefly under load is the behaviour we want.
 *
 * An explicit `connection_limit` in DATABASE_URL always wins — this only fills
 * in a default when the environment has not decided.
 */
function boundedDatabaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    if (!url.searchParams.has("connection_limit")) {
      url.searchParams.set("connection_limit", "5");
    }
    if (!url.searchParams.has("pool_timeout")) {
      // Wait for a free connection rather than failing instantly. Long enough
      // to ride out the burst when a club screen opens — it fires several
      // queries at once, plus a socket join.
      url.searchParams.set("pool_timeout", "20");
    }
    return url.toString();
  } catch {
    // A URL Prisma will reject anyway. Hand it back untouched so the error
    // comes from Prisma with its own message rather than from here.
    return raw;
  }
}

const url = boundedDatabaseUrl(process.env.DATABASE_URL);

export const prisma = new PrismaClient(
  url ? { datasources: { db: { url } } } : undefined
);
