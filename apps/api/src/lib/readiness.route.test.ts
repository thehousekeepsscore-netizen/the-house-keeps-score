/**
 * The route half of readiness: the status code is the contract a monitor
 * reads, and the integration test cannot produce the 503 side because its
 * database is up. The probe is mocked here so both answers are exercised.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';

vi.mock('./readiness.js', async () => {
  const actual = await vi.importActual<typeof import('./readiness.js')>('./readiness.js');
  return { ...actual, checkReadiness: vi.fn() };
});

// app.ts loads env.ts, which validates these at import time. The unit job in CI
// has no environment at all (the integration job does), so a unit test that
// mounts the app has to supply placeholders itself. Nothing here connects to
// anything: the probe is mocked and the client is never asked to query.
process.env.DATABASE_URL ??= 'postgresql://unit:unit@127.0.0.1:1/unit';
process.env.JWT_ACCESS_SECRET ??= 'unit-test-access-secret-not-real';
process.env.REFRESH_TOKEN_DERIVATION_SECRET ??= 'unit-test-derivation-secret-not-real';

const { app } = await import('../app.js');
const { checkReadiness } = await import('./readiness.js');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /api/ready', () => {
  it('is 200 ready when the probe answers', async () => {
    vi.mocked(checkReadiness).mockResolvedValueOnce({ ready: true, latencyMs: 7 });
    const res = await fetch(`${baseUrl}/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ready', ready: true, latencyMs: 7 });
  });

  it('is 503 unavailable when the probe does not, carrying the reason', async () => {
    vi.mocked(checkReadiness).mockResolvedValueOnce({
      ready: false,
      latencyMs: 5000,
      reason: 'FATAL: (ENOTFOUND) tenant/user postgres.abc not found',
    });
    const res = await fetch(`${baseUrl}/ready`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: 'unavailable',
      ready: false,
      reason: 'FATAL: (ENOTFOUND) tenant/user postgres.abc not found',
    });
  });
});
