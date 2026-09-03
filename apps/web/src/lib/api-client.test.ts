import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError, accessTokenExpiresWithin, apiFetch, refreshAccessToken, setAccessToken } from './api-client';

/**
 * The seam between an HTTP response and a typed error.
 *
 * Everything downstream of this file distinguishes failures by
 * `ApiError.status`. `JoinRequestList` turns a 409 into "another admin already
 * handled that" and refreshes; a 403 into a permission message; anything else
 * into a generic one. All of that rests on `apiFetch` propagating the real
 * status and the server's own message — and nothing tested that it does.
 *
 * The gap mattered because both sides were tested from the middle outwards.
 * The API's tests stop at the service, asserting a thrown `HttpError(409)`. The
 * component's tests start from a constructed `ApiError(409)`. If `apiFetch` ever
 * flattened the status, both suites would stay green while the stale-request
 * path became dead code and admins went back to reading "failed" for a request
 * that had been handled correctly.
 *
 * These use real `Response` objects rather than hand-rolled fakes, because the
 * behaviour under test IS the header and body handling — a fake whose
 * `headers.get` returns whatever the test wants would prove nothing about
 * content-type.
 */

const originalFetch = global.fetch;

const respondWith = (response: Response) => {
  const mock = vi.fn().mockResolvedValue(response);
  global.fetch = mock as unknown as typeof fetch;
  return mock;
};

const json = (status: number, body: unknown, statusText = '') =>
  new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  setAccessToken(null);
  vi.restoreAllMocks();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('a failing response becomes an ApiError that names the status', () => {
  it('409 — the status the stale-request path depends on', async () => {
    respondWith(json(409, { error: 'This request has already been decided' }));

    const err = await apiFetch('/clubs/c1/join-requests/r1/accept', { method: 'POST' }).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toBe('This request has already been decided');
  });

  it('403 — distinguished from 409, which is the whole point', async () => {
    respondWith(json(403, { error: 'Only a Club Admin or Owner can do this' }));

    const err = (await apiFetch('/clubs/c1/join-requests/r1/accept', { method: 'POST' }).catch(
      (e) => e
    )) as ApiError;

    expect(err.status).toBe(403);
    expect(err.status).not.toBe(409);
    expect(err.message).toBe('Only a Club Admin or Owner can do this');
  });

  it('500 — status and message both survive', async () => {
    respondWith(json(500, { error: 'Something went wrong' }));

    const err = (await apiFetch('/clubs').catch((e) => e)) as ApiError;

    expect(err.status).toBe(500);
    expect(err.message).toBe('Something went wrong');
  });

  it('carries `details` through, which validation errors rely on', async () => {
    respondWith(json(400, { error: 'Validation failed', details: { fieldErrors: { amount: ['too small'] } } }));

    const err = (await apiFetch('/clubs').catch((e) => e)) as ApiError;

    expect(err.status).toBe(400);
    expect(err.details).toEqual({ fieldErrors: { amount: ['too small'] } });
  });
});

describe('a failure without a JSON content-type', () => {
  it('keeps the status and falls back to statusText — the body is NOT read', async () => {
    /*
     * Pinning actual behaviour, not endorsing it. `apiFetch` only parses when
     * the content-type says JSON, so a proxy or gateway that returns a JSON
     * body under `text/html` loses the server's message and reports statusText
     * instead. The STATUS still survives, which is what the 409 handling needs
     * — but the message does not, and a caller that shows `err.message` to a
     * user would show "Conflict".
     *
     * This is exactly how the socket.io outage presented: a JSON endpoint
     * answered with an HTML shell, and everything downstream read it as
     * something other than an error.
     */
    global.fetch = vi.fn().mockResolvedValue(
      new Response('{"error":"This request has already been decided"}', {
        status: 409,
        statusText: 'Conflict',
        headers: { 'content-type': 'text/html' },
      })
    ) as unknown as typeof fetch;

    const err = (await apiFetch('/clubs/c1/join-requests/r1/accept', { method: 'POST' }).catch(
      (e) => e
    )) as ApiError;

    expect(err.status).toBe(409);
    // The message in the body was not used, because the header did not say JSON.
    expect(err.message).toBe('Conflict');
    expect(err.message).not.toContain('already been decided');
  });
});

describe('successful responses', () => {
  it('parses a JSON body', async () => {
    respondWith(json(200, [{ id: 'c1', name: 'All in 2026' }]));

    await expect(apiFetch('/clubs')).resolves.toEqual([{ id: 'c1', name: 'All in 2026' }]);
  });

  it('returns undefined for 204 without attempting to parse', async () => {
    // A 204 has no body at all. Parsing one throws, so the early return is the
    // behaviour being pinned — every mutation-free DELETE depends on it.
    const body = new Response(null, { status: 204 });
    const jsonSpy = vi.spyOn(body, 'json');
    respondWith(body);

    await expect(apiFetch('/clubs/c1', { method: 'DELETE' })).resolves.toBeUndefined();
    expect(jsonSpy).not.toHaveBeenCalled();
  });
});

/**
 * One refresh at a time, whoever asks.
 *
 * The server rotates the refresh cookie on every refresh and reads a second
 * presentation of the same cookie as theft. So everything that refreshes from
 * one document — a burst of 401s, and the auth bootstrap on page load — must
 * share a single in-flight request. The bootstrap used to call the endpoint
 * directly, which was the one path outside this dedupe.
 */
describe('refreshing is shared, not repeated', () => {
  /** Routes by URL: the refresh answers with a token; everything else 401s until refreshed, then 200s. */
  function serverThatRotates() {
    let refreshed = false;
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/refresh')) {
        refreshCalls += 1;
        // Slow enough that concurrent callers overlap it.
        await new Promise((r) => setTimeout(r, 20));
        refreshed = true;
        return json(200, { accessToken: 'fresh-token' });
      }
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (!refreshed || auth !== 'Bearer fresh-token') return json(401, { error: 'Unauthorized' });
      return json(200, { ok: true, url });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return { fetchMock, refreshCalls: () => refreshCalls };
  }

  it('five concurrent 401s produce exactly one refresh request', async () => {
    const server = serverThatRotates();

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => apiFetch<{ ok: boolean }>(`/clubs/c${i}`))
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(server.refreshCalls(), 'one cookie presentation, not five').toBe(1);
  });

  it('the bootstrap refresh and a 401 retry overlap into one request', async () => {
    // Exactly the pair that used to be two independent mechanisms: the
    // startup refresh (now refreshAccessToken) and a 401-triggered one.
    const server = serverThatRotates();

    const [booted, data] = await Promise.all([
      refreshAccessToken(),
      apiFetch<{ ok: boolean }>('/clubs/c1'),
    ]);

    expect(booted).toBe(true);
    expect(data.ok).toBe(true);
    expect(server.refreshCalls()).toBe(1);
  });

  it('a refresh that has settled is not reused for a later request', async () => {
    // The dedupe is for overlap only. Once a refresh completes, the next
    // caller that needs one gets a fresh request — a cached false forever
    // would be as bad as a duplicate.
    const server = serverThatRotates();
    await refreshAccessToken();
    await refreshAccessToken();
    expect(server.refreshCalls()).toBe(2);
  });

  it('answers false, never rejects, when the refresh is refused', async () => {
    respondWith(json(401, { error: 'Refresh token reuse detected, please log in again' }));
    await expect(refreshAccessToken()).resolves.toBe(false);
  });

  it('stores the access token it receives', async () => {
    const server = serverThatRotates();
    await refreshAccessToken();
    expect(server.refreshCalls()).toBe(1);
    // Proven by a subsequent request carrying it: no 401, so no second refresh.
    const data = await apiFetch<{ ok: boolean }>('/clubs/c1');
    expect(data.ok).toBe(true);
    expect(server.refreshCalls()).toBe(1);
  });
});

/**
 * Reading the token's own expiry, so a handshake never sends one the server
 * is certain to refuse. Decoded, never verified: the client only needs to
 * know when, not whether.
 */
describe('accessTokenExpiresWithin', () => {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwtExpiringIn = (ms: number) => `${b64({ alg: 'HS256' })}.${b64({ sub: 'u', exp: Math.floor((Date.now() + ms) / 1000) })}.sig`;

  it('is false for a token with more life than the margin', () => {
    setAccessToken(jwtExpiringIn(10 * 60_000));
    expect(accessTokenExpiresWithin(30_000)).toBe(false);
  });

  it('is true for a token inside the margin, and for one already expired', () => {
    setAccessToken(jwtExpiringIn(20_000));
    expect(accessTokenExpiresWithin(30_000)).toBe(true);
    setAccessToken(jwtExpiringIn(-5_000));
    expect(accessTokenExpiresWithin(30_000)).toBe(true);
  });

  it('treats the boundary as expiring: exactly the margin left is not enough', () => {
    // exp is whole seconds; build one landing exactly on the margin.
    const exp = Math.floor(Date.now() / 1000) + 30;
    setAccessToken(`${b64({})}.${b64({ exp })}.sig`);
    const remaining = exp * 1000 - Date.now();
    expect(accessTokenExpiresWithin(remaining)).toBe(true);
    expect(accessTokenExpiresWithin(remaining - 1)).toBe(false);
  });

  it('is true when there is no token', () => {
    setAccessToken(null);
    expect(accessTokenExpiresWithin(30_000)).toBe(true);
  });

  it('is true for a token that is not a JWT, or has no readable exp', () => {
    // Unknown is treated as expiring: one spare refresh beats one certain refusal.
    setAccessToken('opaque-token');
    expect(accessTokenExpiresWithin(30_000)).toBe(true);
    setAccessToken(`${b64({})}.${b64({ sub: 'u' })}.sig`);
    expect(accessTokenExpiresWithin(30_000)).toBe(true);
    setAccessToken(`${b64({})}.not-base64-json.sig`);
    expect(accessTokenExpiresWithin(30_000)).toBe(true);
  });

  it('reads base64url payloads, which is what JWTs use', () => {
    // A payload whose base64 contains + and / in standard form.
    const payload = { sub: 'u', exp: Math.floor(Date.now() / 1000) + 600, pad: '????>>>>' };
    setAccessToken(`${b64({})}.${b64(payload)}.sig`);
    expect(accessTokenExpiresWithin(30_000)).toBe(false);
  });
});
