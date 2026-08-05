import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { app } from '../app.js';

/**
 * The HTTP hardening, pinned.
 *
 * Security headers and body limits are the kind of thing that disappears in a
 * refactor without anything failing, because nothing in the application reads
 * them. These assert them from the outside, as a client sees them.
 *
 * Rate limiting is deliberately not asserted by exhausting a budget: doing so
 * means firing hundreds of requests and leaves the limiter's in-memory counter
 * poisoned for anything that runs afterwards in the same process. The headers
 * below prove the limiter is mounted and what its budget is, which is the part
 * that regresses.
 *
 * Requires no database.
 */

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('security headers', () => {
  it('refuses to let a response be reinterpreted by content sniffing', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('refuses to be framed', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    // helmet sets DENY; either value defeats clickjacking.
    expect(res.headers.get('x-frame-options')).toMatch(/DENY|SAMEORIGIN/i);
  });

  it('does not advertise the server implementation', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});

describe('request body limit', () => {
  it('accepts an ordinary request body', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@test.local', password: 'x' }),
    });
    // Rejected on credentials, which means it got past the body parser.
    expect(res.status).not.toBe(413);
  });

  it('rejects a body far larger than any legitimate request', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(200_000) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/too large/i) });
  });
});

describe('malformed input is the client\'s fault, not a server fault', () => {
  it('answers 400 for a body that is not JSON', async () => {
    // This and the oversized case both used to answer 500. A client mistake
    // reported as a server error is a retry the caller should not make and an
    // alert an operator should not receive.
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/valid JSON/i) });
  });

  it('never leaks an internal message or stack in an error body', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const text = await res.text();
    expect(text).not.toMatch(/at \w+ \(|node_modules|\.ts:\d+/);
  });
});

describe('rate limiting', () => {
  it('is mounted across the API, not only on auth', async () => {
    const res = await fetch(`${baseUrl}/api/clubs`);
    // 401 — unauthenticated — but the limiter ran first and published its budget.
    expect(res.headers.get('ratelimit-limit')).toBe('300');
  });

  it('leaves the health check unlimited, so a traffic spike cannot fail the probe', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('ratelimit-limit')).toBeNull();
  });
});
