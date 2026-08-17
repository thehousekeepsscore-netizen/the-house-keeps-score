import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiFetch, ApiError } from './api-client';
import { classifyJoinRequestError } from '../components/JoinRequestList';

/**
 * The seam between the API's status codes and the screens that branch on them.
 *
 * #34 shows three different things depending on whether a decision failed with
 * 409, 403 or anything else — "another admin already handled that", "you do not
 * have permission", and a plain error. #33 produces those statuses. Neither
 * side tests the join between them: the API tests stop at the service, and the
 * component tests start from an `ApiError` that the test constructs itself.
 *
 * So this covers the one link nobody owned. If `apiFetch` ever dropped the
 * status or failed to read the body, a 409 would classify as `unknown` and
 * admins would be back to seeing a generic failure for a request that was
 * handled correctly — with every test on both sides still green.
 *
 * Deliberately about the CONTRACT, not the implementation: what a caller can
 * rely on receiving, not how the fetch is spelled.
 */

const respond = (status: number, body: unknown, contentType = 'application/json') =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: { 409: 'Conflict', 403: 'Forbidden', 500: 'Internal Server Error' }[status] ?? '',
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
  } as unknown as Response);

afterEach(() => vi.restoreAllMocks());

/**
 * Runs the call and returns the ApiError it threw.
 *
 * `.catch((e) => e)` types as `unknown`, so every assertion below would need a
 * cast. Narrowing once here keeps the tests readable AND makes "it threw the
 * wrong kind of thing" a failure with a useful message rather than a pile of
 * type errors.
 */
async function failureFrom(call: Promise<unknown>): Promise<ApiError> {
  try {
    await call;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw new Error(`Expected an ApiError, got ${String(err)}`);
  }
  throw new Error('Expected the call to reject, but it resolved');
}

describe('a failed response becomes an ApiError callers can branch on', () => {
  it('409 keeps its status and the server\'s message', async () => {
    respond(409, { error: 'This request has already been decided' });

    const err = await failureFrom(apiFetch('/clubs/c1/join-requests/r1/accept', { method: 'POST' }));

    expect(err.status).toBe(409);
    // The exact sentence the API throws, so a screen can show it if it wants to.
    expect(err.message).toBe('This request has already been decided');
  });

  it('403 keeps its status and message', async () => {
    respond(403, { error: 'Only a Club Admin or Owner can do this' });

    const err = await failureFrom(apiFetch('/clubs/c1/join-requests/r1/accept', { method: 'POST' }));

    expect(err.status).toBe(403);
    expect(err.message).toBe('Only a Club Admin or Owner can do this');
  });

  it('anything else keeps its status too', async () => {
    respond(500, { error: 'Something went wrong' });
    const err = await failureFrom(apiFetch('/anything'));
    expect(err.status).toBe(500);
  });

  it('carries structured details when the API sends them', async () => {
    respond(400, { error: 'Validation failed', details: { fieldErrors: { amount: ['Required'] } } });
    const err = await failureFrom(apiFetch('/anything', { method: 'POST', body: {} }));
    expect(err.details).toEqual({ fieldErrors: { amount: ['Required'] } });
  });
});

describe('when the body is not announced as JSON', () => {
  /*
   * The client only parses a body when `content-type` says `application/json`,
   * so a JSON payload sent without that header is NOT read — the message falls
   * back to `statusText`.
   *
   * That is worth pinning rather than treating as a gap, because of what it
   * does NOT break: the STATUS still arrives intact, and #34 branches on the
   * status rather than the message. So a proxy that strips the header degrades
   * the wording and leaves the behaviour correct.
   */
  it('still reports the right status, and falls back to statusText for the message', async () => {
    respond(409, { error: 'This request has already been decided' }, 'text/plain');

    const err = await failureFrom(apiFetch('/clubs/c1/join-requests/r1/accept', { method: 'POST' }));

    expect(err.status).toBe(409);
    expect(err.message).toBe('Conflict');
  });

  it('and the stale branch still fires, because it reads the status', () => {
    // The point of the test above: wording degrades, behaviour does not.
    expect(classifyJoinRequestError(new ApiError(409, 'Conflict')).kind).toBe('stale');
  });
});

describe('the whole seam, end to end', () => {
  /*
   * The join #33 and #34 both assume and neither covers: an HTTP response goes
   * in, and the thing the component branches on comes out.
   */
  const throughApiFetch = async (status: number, message: string) => {
    respond(status, { error: message });
    const err = await failureFrom(apiFetch('/clubs/c1/join-requests/r1/accept', { method: 'POST' }));
    return classifyJoinRequestError(err);
  };

  it('a 409 response reaches the component as a stale list, not a failure', async () => {
    const classified = await throughApiFetch(409, 'This request has already been decided');
    expect(classified.kind).toBe('stale');
    expect(classified.message).toMatch(/Another admin already handled/i);
  });

  it('a 403 response reaches it as a permission problem', async () => {
    const classified = await throughApiFetch(403, 'Only a Club Admin or Owner can do this');
    expect(classified.kind).toBe('forbidden');
    expect(classified.message).toMatch(/do not have permission/i);
  });

  it('a 500 response reaches it as an unknown failure carrying the server\'s words', async () => {
    const classified = await throughApiFetch(500, 'Database unavailable');
    expect(classified.kind).toBe('unknown');
    expect(classified.message).toBe('Database unavailable');
  });

  it('the three are genuinely distinguishable', async () => {
    const kinds = await Promise.all([
      throughApiFetch(409, 'a'),
      throughApiFetch(403, 'b'),
      throughApiFetch(500, 'c'),
    ]);
    expect(new Set(kinds.map((k) => k.kind)).size).toBe(3);
  });
});

describe('a successful response is unaffected', () => {
  it('returns the parsed body', async () => {
    respond(200, [{ id: 'r1' }]);
    await expect(apiFetch('/clubs/join-requests')).resolves.toEqual([{ id: 'r1' }]);
  });

  it('returns undefined for 204, without trying to parse a body', async () => {
    const json = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 204,
      statusText: 'No Content',
      headers: { get: () => null },
      json,
    } as unknown as Response);

    await expect(apiFetch('/clubs/c1/join-requests/r1/reject', { method: 'POST' })).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });
});
