/**
 * The health endpoint has to be trusted before a dangerous operation, so the
 * one behaviour that matters is that it never invents a commit.
 */

import { describe, expect, it } from 'vitest';
import { deploymentIdentity, readCommit } from './deploymentIdentity.js';
import { SETTLEMENT_ENGINE_VERSION } from '../modules/offlineSessions/settlementEngine.js';
import { AUDIT_SCHEMA_VERSION } from '../modules/clubRecords/auditMeta.js';

describe('reading the commit', () => {
  it('reports null and says so, rather than inventing one', () => {
    expect(readCommit({})).toEqual({ commit: null, source: 'unavailable' });
    const id = deploymentIdentity({});
    expect(id.commit).toBeNull();
    expect(id.commitShort).toBeNull();
    expect(id.commitSource).toBe('unavailable');
  });

  it('reads Railway\'s variable, which is what production injects', () => {
    const sha = 'b026edc1234567890abcdef1234567890abcdef1';
    expect(readCommit({ RAILWAY_GIT_COMMIT_SHA: sha })).toEqual({
      commit: sha,
      source: 'RAILWAY_GIT_COMMIT_SHA',
    });
    expect(deploymentIdentity({ RAILWAY_GIT_COMMIT_SHA: sha }).commitShort).toBe('b026edc');
  });

  it('prefers Railway over the other platforms when several are set', () => {
    expect(
      readCommit({ VERCEL_GIT_COMMIT_SHA: 'vercel', RAILWAY_GIT_COMMIT_SHA: 'railway' }).commit
    ).toBe('railway');
  });

  it('falls through to the other platforms in order', () => {
    expect(readCommit({ SOURCE_COMMIT: 'abc' }).source).toBe('SOURCE_COMMIT');
    expect(readCommit({ RENDER_GIT_COMMIT: 'abc' }).source).toBe('RENDER_GIT_COMMIT');
  });

  it('treats an empty or whitespace value as absent', () => {
    // A platform that sets the variable to "" is not telling us the commit, and
    // reporting "" would look like an answer.
    expect(readCommit({ RAILWAY_GIT_COMMIT_SHA: '' }).commit).toBeNull();
    expect(readCommit({ RAILWAY_GIT_COMMIT_SHA: '   ' }).commit).toBeNull();
  });

  it('trims, so a trailing newline does not become part of the SHA', () => {
    expect(readCommit({ GIT_COMMIT_SHA: 'abc123\n' }).commit).toBe('abc123');
  });
});

describe('the rest of the identity', () => {
  it('reports the versions from the code, not from configuration', () => {
    const id = deploymentIdentity({});
    expect(id.settlementEngineVersion).toBe(SETTLEMENT_ENGINE_VERSION);
    expect(id.auditSchemaVersion).toBe(AUDIT_SCHEMA_VERSION);
  });

  it('still says ok, so existing liveness probes keep working', () => {
    expect(deploymentIdentity({}).status).toBe('ok');
  });

  it('reports when this process started, which moves on every deploy', () => {
    const id = deploymentIdentity({});
    expect(() => new Date(id.startedAt).toISOString()).not.toThrow();
    expect(id.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('counts uptime forward from start', () => {
    const start = new Date(deploymentIdentity({}).startedAt);
    const later = deploymentIdentity({}, new Date(start.getTime() + 90_000));
    expect(later.uptimeSeconds).toBe(90);
  });

  it('never reports a negative uptime if a clock steps backwards', () => {
    const start = new Date(deploymentIdentity({}).startedAt);
    expect(deploymentIdentity({}, new Date(start.getTime() - 60_000)).uptimeSeconds).toBe(0);
  });
});
