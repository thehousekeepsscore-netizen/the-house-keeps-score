import { prisma } from "./prisma.js";

/**
 * Can this instance actually serve a request that touches the database?
 *
 * /api/health deliberately never asks — it is Railway's liveness gate, and a
 * slow database must not become a restart loop. The cost of that choice was
 * paid in October 2026: the Supabase project auto-paused after a quiet week,
 * every database-backed request failed for six days, and health went on
 * saying "ok" throughout because nothing it reported could be false. Google
 * sign-in was merely the path the first user happened to try.
 *
 * This is the other question, answered by one round trip and bounded by a
 * timeout, so a hung pooler reads as "unavailable" within seconds rather than
 * holding the caller open. It is for an uptime monitor and for a human with
 * curl; nothing on the platform restarts the process on its answer.
 */
export interface Readiness {
  ready: boolean;
  /** Round-trip time of the probe, or the time spent before giving up. */
  latencyMs: number;
  /** First line of the failure, with any connection string scrubbed. */
  reason?: string;
}

/** Long enough for a cold pooler, short enough that a monitor gets an answer. */
export const READINESS_TIMEOUT_MS = 5000;

const defaultProbe = () => prisma.$queryRaw`SELECT 1`;

export async function checkReadiness(
  probe: () => Promise<unknown> = defaultProbe,
  timeoutMs: number = READINESS_TIMEOUT_MS,
  now: () => number = () => Date.now()
): Promise<Readiness> {
  const started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([probe(), timeout]);
    return { ready: true, latencyMs: now() - started };
  } catch (err) {
    return { ready: false, latencyMs: now() - started, reason: describe(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One line, never a credential: a connection string in a message is replaced. */
function describe(err: unknown): string {
  const first = (err instanceof Error ? err.message : String(err)).split("\n").find((l) => l.trim()) ?? "unknown error";
  return first.replace(/postgres(ql)?:\/\/\S+/gi, "<database url>").trim();
}
