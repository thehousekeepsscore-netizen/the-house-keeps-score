import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Dev and production must forward the same paths to the API.
 *
 * This is the test that was missing when live updates were broken in production
 * for the whole life of the deployment. `vite.config.ts` proxied `/api` AND
 * `/socket.io`; `vercel.json` proxied only `/api`. So in the browser the
 * Socket.IO handshake fell through to the SPA catch-all and engine.io was
 * handed the HTML shell:
 *
 *     GET /socket.io/?EIO=4&transport=polling
 *     200  text/html   <!doctype html>...
 *
 * The socket never connected, for any user, on any event. Every client listener
 * and every server emit was correct — which is exactly why repeated audits of
 * them found nothing. The transport underneath was never up, and nothing in the
 * codebase compared the two files that had to agree.
 *
 * Locally it all worked, because the dev proxy was the complete one. That is
 * the shape of this class of bug: the environment nobody tests in is the only
 * one that is wrong.
 *
 * So this test does not check that realtime works. It checks the one fact that
 * was false: that the deployed site forwards everything the dev server does.
 */

const webRoot = resolve(__dirname, '..');

interface VercelConfig {
  rewrites: { source: string; destination: string }[];
}

const vercel = (): VercelConfig =>
  JSON.parse(readFileSync(resolve(webRoot, 'vercel.json'), 'utf8'));

/**
 * The dev proxy's keys, read from the source text.
 *
 * Deliberately not imported and executed: `vite.config.ts` is a config factory
 * that reads process.env, and a test that runs it is testing its own
 * environment as much as the file. The keys are string literals, and matching
 * them is what this test is about.
 */
function devProxyPaths(): string[] {
  const src = readFileSync(resolve(webRoot, 'vite.config.ts'), 'utf8');
  const block = src.slice(src.indexOf('proxy: {'));
  const end = block.indexOf('\n      },');
  return [...block.slice(0, end).matchAll(/'(\/[^']+)':\s*\{/g)].map((m) => m[1]);
}

describe('the deployed site forwards what the dev server forwards', () => {
  it('finds both proxied paths in the dev config', () => {
    // Guards the parser itself: if this regex silently stopped matching, every
    // assertion below would pass against an empty list and prove nothing.
    expect(devProxyPaths()).toEqual(expect.arrayContaining(['/api', '/socket.io']));
  });

  it.each(devProxyPaths())('rewrites %s in vercel.json too', (path) => {
    const sources = vercel().rewrites.map((r) => r.source);
    expect(sources.some((s) => s.startsWith(path))).toBe(true);
  });

  it('sends every proxied path to the same API host', () => {
    const { rewrites } = vercel();
    const apiHosts = new Set(
      rewrites
        .filter((r) => r.destination.startsWith('http'))
        .map((r) => new URL(r.destination).origin)
    );
    // One API, not two. A socket pointed at a different deployment than the
    // REST calls would sync against state the screen never fetched.
    expect(apiHosts.size).toBe(1);
  });

  it('keeps the SPA catch-all last, because order decides', () => {
    const { rewrites } = vercel();
    const catchAll = rewrites.findIndex((r) => r.source === '/(.*)');

    expect(catchAll).toBe(rewrites.length - 1);
    // This is the precise failure that broke production: the catch-all matches
    // /socket.io as happily as it matches /some/route, so anything listed after
    // it is dead config that silently serves index.html instead.
    expect(catchAll).toBeGreaterThan(
      rewrites.findIndex((r) => r.source.startsWith('/socket.io'))
    );
  });

  it('does not let the socket rewrite drop the handshake query string', () => {
    const socket = vercel().rewrites.find((r) => r.source.startsWith('/socket.io'));

    // engine.io carries EIO, transport and sid as query parameters. Vercel
    // forwards the query automatically, but only when the destination does not
    // pin one of its own — a destination with a `?` in it replaces the lot and
    // the handshake arrives without knowing which protocol it is speaking.
    expect(socket?.destination).not.toContain('?');
    expect(socket?.destination).toContain('/socket.io/');
  });
});
