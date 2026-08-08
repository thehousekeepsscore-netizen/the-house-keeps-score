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

  /**
   * The URLs the clients actually request, matched the way Vercel matches them.
   *
   * The first version of this file only asked whether a rewrite whose source
   * STARTED WITH /socket.io existed. One did — `/socket.io/:path*` — and the
   * test went green while production stayed broken, because `:path*` does not
   * match `/socket.io/`: a trailing slash with zero segments falls straight
   * through to the SPA catch-all. `/socket.io` and `/socket.io/abc` both
   * matched; the one URL socket.io-client actually opens with did not.
   *
   * Asserting that a rule exists is not the same as asserting it fires. These
   * are the literal paths in flight, so this cannot pass on a rule that misses
   * them again.
   */
  const HANDSHAKE_PATHS = [
    '/socket.io/', // engine.io's polling handshake — the one that was missed
    '/socket.io', // no trailing slash
    '/socket.io/websocket', // the upgrade probe
    '/api/health', // REST, for the same reason
  ];

  /**
   * Vercel source patterns, reduced to what they match.
   *
   * `/:path*` becomes `(?:/(.+))?` — optional, but when present it needs a
   * slash AND at least one character after it. That last detail is the whole
   * bug: `.+` rather than `.*` is what makes `/socket.io/` fail to match, which
   * is exactly what production did. Modelled from observed behaviour on the
   * deployed site, not from reading path-to-regexp:
   *
   *     /socket.io?EIO=4...   -> engine.io handshake   (matched)
   *     /socket.io/abc        -> API: "Transport unknown" (matched)
   *     /socket.io/?EIO=4...  -> text/html SPA shell   (NOT matched)
   */
  function matches(source: string, path: string): boolean {
    const pattern = source
      .replace(/\/:[A-Za-z_]+\*/g, '(?:/(.+))?')
      .replace(/\/:[A-Za-z_]+/g, '/([^/]+)');
    return new RegExp(`^${pattern}$`).test(path);
  }

  it.each(HANDSHAKE_PATHS)('%s reaches the API rather than the SPA shell', (path) => {
    const hit = vercel().rewrites.find((r) => matches(r.source, path));

    expect(hit, `${path} fell through to ${JSON.stringify(hit?.source)}`).toBeDefined();
    expect(hit!.destination.startsWith('http')).toBe(true);
  });

  it('models :path* the way Vercel does, or the test above proves nothing', () => {
    // The exact discrepancy that let the broken config pass.
    expect(matches('/socket.io/:path*', '/socket.io')).toBe(true);
    expect(matches('/socket.io/:path*', '/socket.io/abc')).toBe(true);
    expect(matches('/socket.io/:path*', '/socket.io/')).toBe(false);
    // And the replacement genuinely covers the case the old one missed.
    expect(matches('/socket.io/(.*)', '/socket.io/')).toBe(true);
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

  it('does not let any socket rewrite drop the handshake query string', () => {
    const socket = vercel().rewrites.filter((r) => r.source.startsWith('/socket.io'));

    expect(socket.length).toBeGreaterThan(0);
    for (const r of socket) {
      // engine.io carries EIO, transport and sid as query parameters. Vercel
      // forwards the query automatically, but only when the destination does
      // not pin one of its own — a destination containing `?` replaces the lot
      // and the handshake arrives not knowing which protocol it speaks.
      expect(r.destination, r.source).not.toContain('?');
      expect(r.destination, r.source).toContain('/socket.io');
    }
  });
});
