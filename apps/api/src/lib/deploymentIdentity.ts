/**
 * Which build is actually running.
 *
 * `/api/health` returned `{"status":"ok"}` and nothing else, which answers "is
 * it up" and not "is it the code I just merged". That gap turned up during the
 * step 3 deploy: the migration was verifiable, the schema was verifiable, the
 * financial digest was verifiable — and whether the API had picked up the merge
 * was not, from outside, at all.
 *
 * It matters most immediately before the dangerous operations. A backfill or a
 * historical correction run against an instance still serving the previous
 * build is a class of incident that is very hard to reason about afterwards,
 * and the fix is one field.
 *
 * HONESTY RULE: every value here is read, never guessed. Where the commit is
 * not available the answer is `null` with a `commitSource` of `unavailable` —
 * not "unknown", not a placeholder, and never a fabricated SHA. A null commit
 * is itself information: it says the platform did not inject one, which is the
 * thing to go and fix.
 *
 * WHAT IS DELIBERATELY NOT HERE: anything that costs a query. Railway polls
 * this endpoint to decide whether the instance is alive, and it sits above the
 * rate limiter for that reason (app.ts). A database round-trip here would turn
 * a slow database into a restart loop.
 */

import { SETTLEMENT_ENGINE_VERSION } from '../modules/offlineSessions/settlementEngine.js';
import { AUDIT_SCHEMA_VERSION } from '../modules/clubRecords/auditMeta.js';

/**
 * Where a commit SHA can come from, in precedence order.
 *
 * Railway injects `RAILWAY_GIT_COMMIT_SHA` into the runtime environment. The
 * rest are here so the same endpoint tells the truth on another platform, or
 * locally when someone exports one by hand, rather than reporting `null` and
 * sending the reader to look for a bug that is really a missing variable.
 */
const COMMIT_SOURCES = [
  'RAILWAY_GIT_COMMIT_SHA',
  'GIT_COMMIT_SHA',
  'SOURCE_COMMIT',
  'SOURCE_VERSION',
  'VERCEL_GIT_COMMIT_SHA',
  'RENDER_GIT_COMMIT',
] as const;

export interface DeploymentIdentity {
  status: 'ok';
  /** Full commit SHA, or null when the platform injected none. */
  commit: string | null;
  /** First 7 characters, for reading against `git log --oneline`. */
  commitShort: string | null;
  /** Which environment variable supplied it, or 'unavailable'. */
  commitSource: string;
  /** The engine that will decide any settlement this instance commits. */
  settlementEngineVersion: number;
  /** The shape of the provenance written into audit rows. */
  auditSchemaVersion: number;
  /**
   * When THIS process started. A deploy that landed is a `startedAt` that
   * moved, which answers the question even on a platform that injects no
   * commit at all.
   */
  startedAt: string;
  uptimeSeconds: number;
}

/** Fixed when the module loads, which is process start. */
const STARTED_AT = new Date();

export function readCommit(env: NodeJS.ProcessEnv = process.env): {
  commit: string | null;
  source: string;
} {
  for (const name of COMMIT_SOURCES) {
    const value = env[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return { commit: value.trim(), source: name };
    }
  }
  return { commit: null, source: 'unavailable' };
}

export function deploymentIdentity(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): DeploymentIdentity {
  const { commit, source } = readCommit(env);
  return {
    status: 'ok',
    commit,
    commitShort: commit ? commit.slice(0, 7) : null,
    commitSource: source,
    settlementEngineVersion: SETTLEMENT_ENGINE_VERSION,
    auditSchemaVersion: AUDIT_SCHEMA_VERSION,
    startedAt: STARTED_AT.toISOString(),
    uptimeSeconds: Math.max(0, Math.round((now.getTime() - STARTED_AT.getTime()) / 1000)),
  };
}
