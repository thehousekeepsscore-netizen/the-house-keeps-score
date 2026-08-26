import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch, setAccessToken } from './api-client';

/**
 * REST did not move with the socket.
 *
 * The socket now points at Railway directly; the REST API deliberately does
 * not. It stays same-origin behind the Vercel /api rewrite because that is what
 * makes its refresh cookie work: the cookie is httpOnly and same-site, and a
 * cross-origin fetch would simply not send it. Sign-in would survive a reload
 * exactly once and then stop.
 *
 * The two are one import apart, so the plausible mistake is not a decision --
 * it is a helpful edit that gives apiFetch the same base URL "for consistency".
 * These assert the request URL that actually reaches fetch.
 */

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  setAccessToken(null);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('REST calls stay same-origin', () => {
  it('requests a root-relative /api path', async () => {
    await apiFetch('/clubs');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/clubs');
  });

  it('names no host at all', async () => {
    // The specific regression: an absolute URL here would leave Vercel and
    // take the refresh cookie out of scope.
    await apiFetch('/clubs/abc/history');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url.startsWith('/')).toBe(true);
    expect(url).not.toMatch(/^https?:\/\//);
    expect(url).not.toContain('railway.app');
  });

  it('still sends credentials, which is what the same-origin path is for', async () => {
    await apiFetch('/clubs');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('include');
  });

  it('refreshes against a same-origin path too', async () => {
    // The refresh endpoint is a separate fetch call in this module and would
    // not be covered by the assertions above.
    fetchMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: async () => ({}),
    }) as unknown as Response);

    await apiFetch('/clubs').catch(() => undefined);

    const refreshCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/auth/refresh'));
    expect(refreshCall).toBeDefined();
    expect(refreshCall![0]).toBe('/api/auth/refresh');
  });
});
