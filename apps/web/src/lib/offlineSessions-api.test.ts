import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as api from './offlineSessions-api';

/**
 * What actually goes on the wire.
 *
 * This file exists because nothing tested this layer, and a one-word mistake in
 * it reached a live poker table: initSettlementRules passed
 * `body: JSON.stringify(input)`, but apiFetch serialises the body itself. The
 * server received a JSON *string* as the entire payload, express.json() is
 * strict about top-level primitives, and it rejected the request as malformed
 * before any handler ran. The host tapped Confirm and got "invalid JSON".
 *
 * No component test could have caught it. They mock this module, so they
 * intercept above the bug — the call looks perfect from up there.
 *
 * The guard below is deliberately table-driven over every writing helper rather
 * than written once for the endpoint that broke. Double-encoding is a mistake
 * anyone makes once per codebase, and it is invisible in review: `body:
 * JSON.stringify(x)` reads like exactly the right thing to write.
 */

const CLUB = 'c1';
const SESSION = 's1';

let fetchMock: ReturnType<typeof vi.fn>;

/** Everything the server would need to have parsed, as it arrived. */
function lastRequest() {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  const headers = (init.headers ?? {}) as Record<string, string>;
  return {
    url,
    method: init.method,
    contentType: headers['Content-Type'],
    raw: init.body as string | undefined,
  };
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ session: { id: SESSION, engineState: {} } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Every helper that sends a body, and what it should arrive as.
 *
 * Adding a writing endpoint without adding it here leaves it unguarded, which
 * is the situation this file was written to end.
 */
const WRITES: { name: string; call: () => Promise<unknown>; expect: Record<string, unknown> }[] = [
  {
    name: 'initSettlementRules',
    call: () => api.initSettlementRules(CLUB, SESSION, { sessionRakeAmount: 1000, winnersCutPercent: 5 }),
    expect: { sessionRakeAmount: 1000, winnersCutPercent: 5 },
  },
  {
    name: 'extendSession',
    call: () => api.extendSession(CLUB, SESSION, 30),
    expect: { minutes: 30 },
  },
  {
    name: 'requestBuyIn',
    call: () => api.requestBuyIn(CLUB, SESSION, 5000, 'u1'),
    expect: { amount: 5000, userId: 'u1' },
  },
  {
    name: 'requestCashOut',
    call: () => api.requestCashOut(CLUB, SESSION, 8000, 'u1'),
    expect: { amount: 8000, userId: 'u1' },
  },
];

describe('a request body arrives as an object the server can parse', () => {
  it.each(WRITES)('$name sends JSON the server accepts', async ({ call, expect: expected }) => {
    await call();
    const { raw, contentType } = lastRequest();

    expect(contentType).toBe('application/json');
    expect(raw).toBeTypeOf('string');

    const parsed = JSON.parse(raw!);
    // THE GUARD. Double-encoding parses back to a string rather than an
    // object, which express.json() rejects outright in strict mode — the
    // request never reaches a handler and the user sees "invalid JSON".
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject(expected);
  });
});

describe('initSettlementRules specifically', () => {
  it('posts to the session it was given', async () => {
    await api.initSettlementRules(CLUB, SESSION, { sessionRakeAmount: 1000, winnersCutPercent: 5 });
    const { url, method } = lastRequest();

    expect(method).toBe('POST');
    expect(url).toBe(`/api/clubs/${CLUB}/offline-sessions/${SESSION}/settlement-rules`);
  });

  it('sends chips, exactly as entered', async () => {
    // 1,000 chips is 1000 on the wire. There is no unit conversion anywhere
    // between the form and the engine, and this pins that nothing scales the
    // figure on the way out.
    await api.initSettlementRules(CLUB, SESSION, { sessionRakeAmount: 1000, winnersCutPercent: 5 });

    expect(JSON.parse(lastRequest().raw!)).toEqual({ sessionRakeAmount: 1000, winnersCutPercent: 5 });
  });
});
