import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { app } from '../app.js';

/**
 * /api/ready against the real app and a real database: the one answer that
 * /api/health cannot give. Driven over HTTP because the route, its limiter and
 * its status code are what a monitor sees.
 *
 * Requires a database. Excluded from `npm test`; run with `npm run test:integration`.
 */

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
  it('answers 200 ready with a measured latency when the database is there', async () => {
    const res = await fetch(`${baseUrl}/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; ready: boolean; latencyMs: number; reason?: string };
    expect(body.status).toBe('ready');
    expect(body.ready).toBe(true);
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body).not.toHaveProperty('reason');
  });

  it('needs no authentication — it is for a monitor', async () => {
    const res = await fetch(`${baseUrl}/ready`, { headers: { Authorization: 'Bearer not-a-token' } });
    expect(res.status).toBe(200);
  });

  it('leaves /api/health exactly as it was: process-only, no readiness claim', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body).not.toHaveProperty('ready');
  });
});
