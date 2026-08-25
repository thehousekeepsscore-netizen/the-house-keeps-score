import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `immutable` is a promise, and this is what makes it true.
 *
 * vercel.json tells browsers that anything under /assets/ may be cached for a
 * year and never revalidated. That is only safe because every file there is
 * content-hashed: a changed file gets a new name, so the cached copy can never
 * be stale — it just stops being referenced.
 *
 * If a build ever emitted an unhashed file into /assets/, the header would
 * become a promise the build cannot keep, and browsers would pin a stale copy
 * for a year with no way to invalidate it short of renaming the path. That
 * failure is silent, slow to appear, and impossible to fix retroactively for
 * anyone who already cached it.
 *
 * So the build output is checked rather than assumed. This runs a real
 * production build into a temporary directory instead of inspecting the vite
 * config, because the config is not the thing the promise depends on — the
 * emitted filenames are.
 */

const WEB_ROOT = resolve(__dirname, '..');

/** Vite's default: name, dash, base64url hash, extension. */
const CONTENT_HASHED = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

describe('every asset the header rule covers is content-hashed', () => {
  it('emits no unhashed file into /assets/', () => {
    const out = mkdtempSync(join(tmpdir(), 'thks-assets-'));
    try {
      execFileSync('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], {
        cwd: WEB_ROOT,
        stdio: 'pipe',
      });

      const assets = readdirSync(join(out, 'assets'));

      // Guard against the assertion passing because nothing was emitted.
      expect(assets.length).toBeGreaterThan(5);

      const unhashed = assets.filter((f) => !CONTENT_HASHED.test(f));
      expect(unhashed).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('the cache rule is scoped to immutable assets only', () => {
  const config = JSON.parse(readFileSync(join(WEB_ROOT, 'vercel.json'), 'utf8')) as {
    headers?: { source: string; headers: { key: string; value: string }[] }[];
    rewrites?: { source: string; destination: string }[];
  };

  it('caches /assets/ for a year, immutably', () => {
    const rule = config.headers?.find((h) => h.source === '/assets/(.*)');
    expect(rule).toBeDefined();

    const cacheControl = rule!.headers.find((h) => h.key.toLowerCase() === 'cache-control');
    expect(cacheControl?.value).toContain('immutable');
    expect(cacheControl?.value).toContain('max-age=31536000');
    expect(cacheControl?.value).toContain('public');
  });

  it('does not cache anything that is not content-hashed', () => {
    // index.html carries no hash — it is the file whose contents change while
    // its URL stays the same, so caching it immutably would pin the whole app
    // to one build. The API and socket paths must never be cached at all.
    const sources = (config.headers ?? []).map((h) => h.source);

    expect(sources).toEqual(['/assets/(.*)']);
    for (const s of sources) {
      expect(s).not.toMatch(/^\/(\(|$)/); // no catch-all
      expect(s).not.toContain('index.html');
      expect(s).not.toContain('/api');
      expect(s).not.toContain('socket.io');
    }
  });

  it('leaves the existing rewrites untouched', () => {
    // The header block is additive; the API proxy and SPA fallback are what
    // make the deployment work at all.
    const destinations = (config.rewrites ?? []).map((r) => r.source);
    expect(destinations).toEqual(['/api/:path*', '/socket.io', '/socket.io/(.*)', '/(.*)']);
  });
});
