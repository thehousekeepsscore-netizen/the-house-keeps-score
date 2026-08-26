import { describe, it, expect } from 'vitest';
import { socketAllowedOrigins } from './allowedOrigins.js';

/**
 * The handshake is refused before any of this application's code runs.
 *
 * Socket.IO checks Origin during the handshake, so an origin missing from this
 * list is not a degraded connection -- it is connect_error, forever, with the
 * client retrying against a server that will never accept it. And because a
 * rejected transport leaves socket.active true, #60 classifies it as
 * `disconnected` rather than `auth-error`: a wrong list presents as a flaky
 * network, not as a configuration mistake. That is the failure this file is
 * here to make impossible to ship.
 */

const PRODUCTION_WEB_ORIGIN = 'https://thehousekeepsscore.com';

describe('the deployed site can open a socket from the host it is served on', () => {
  it('admits www when WEB_ORIGIN is the apex', () => {
    // The production case exactly: WEB_ORIGIN is the apex, the apex 308s to
    // www, so every real browser sends Origin: https://www...
    expect(socketAllowedOrigins(PRODUCTION_WEB_ORIGIN)).toEqual([
      'https://thehousekeepsscore.com',
      'https://www.thehousekeepsscore.com',
    ]);
  });

  it('admits the apex when WEB_ORIGIN is www', () => {
    // The mirror image, so that correcting WEB_ORIGIN to the canonical host
    // later cannot silently lock the other half of the site out.
    expect(socketAllowedOrigins('https://www.thehousekeepsscore.com')).toEqual([
      'https://www.thehousekeepsscore.com',
      'https://thehousekeepsscore.com',
    ]);
  });

  it('keeps the configured origin first and never drops it', () => {
    for (const origin of [PRODUCTION_WEB_ORIGIN, 'https://www.example.org', 'http://localhost:3000']) {
      expect(socketAllowedOrigins(origin)[0]).toBe(origin);
    }
  });
});

describe('it does not widen further than the configured site', () => {
  it('admits no unrelated host', () => {
    const allowed = socketAllowedOrigins(PRODUCTION_WEB_ORIGIN);

    for (const hostile of [
      'https://thehousekeepsscore.com.evil.test',
      'https://evil.test',
      'http://thehousekeepsscore.com',
      'https://api.thehousekeepsscore.com',
      'https://wwwthehousekeepsscore.com',
    ]) {
      expect(allowed).not.toContain(hostile);
    }
  });

  it('keeps the scheme and port of the configured origin', () => {
    // Deriving a hostname must not quietly relax http/https or move a port --
    // that would admit an origin the operator never configured.
    expect(socketAllowedOrigins('http://staging.example.org:8080')).toEqual([
      'http://staging.example.org:8080',
      'http://www.staging.example.org:8080',
    ]);
  });

  it('produces exactly two origins for a real domain, and no duplicates', () => {
    const allowed = socketAllowedOrigins(PRODUCTION_WEB_ORIGIN);
    expect(allowed).toHaveLength(2);
    expect(new Set(allowed).size).toBe(2);
  });
});

describe('hosts with no apex/www relationship are left alone', () => {
  it('returns localhost unchanged', () => {
    // www.localhost is not a thing. Development and test both run here, so a
    // spurious second entry would be carried by every local run.
    expect(socketAllowedOrigins('http://localhost:3000')).toEqual(['http://localhost:3000']);
    expect(socketAllowedOrigins('http://localhost:5173')).toEqual(['http://localhost:5173']);
  });

  it('returns a bare IP unchanged', () => {
    expect(socketAllowedOrigins('http://127.0.0.1:4001')).toEqual(['http://127.0.0.1:4001']);
  });

  it('passes a malformed value through rather than inventing one', () => {
    // env.ts owns refusing to boot on a bad WEB_ORIGIN. Substituting something
    // parseable here would take that failure away and hide the cause.
    expect(socketAllowedOrigins('not-a-url')).toEqual(['not-a-url']);
    expect(socketAllowedOrigins('')).toEqual(['']);
  });
});
