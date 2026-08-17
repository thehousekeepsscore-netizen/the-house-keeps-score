import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError, apiFetch, setAccessToken } from './api-client';

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
