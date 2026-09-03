import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * What the socket is actually constructed with.
 *
 * The transport migration is one argument to one call, and every way of getting
 * it wrong is silent. Pointing at same-origin again puts the connection back
 * behind the Vercel rewrite, which forwards the handshake but drops the
 * WebSocket upgrade -- socket.io-client keeps polling and reports itself
 * connected, so nothing fails, nothing logs, and the only visible symptom is
 * latency nobody can attribute. That is precisely the state this change exists
 * to leave, and it took direct measurement against Railway to find it the first
 * time.
 *
 * So these assert the call rather than the source: the origin that was passed,
 * the path, the auth callback's behaviour, and -- as much as any of them -- what
 * is NOT in the options object.
 */

const { ioMock } = vi.hoisted(() => ({ ioMock: vi.fn() }));

vi.mock('socket.io-client', () => ({
  io: ioMock,
  Socket: class {},
}));

/**
 * Stand-in for the library socket. The factory now registers `connect` and
 * `connect_error` handlers and may call `connect()`, so the double records
 * handlers by event name and lets a test fire them.
 */
const fakeSocket = () => {
  const handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  const s = {
    removeAllListeners: vi.fn(),
    disconnect: vi.fn(),
    connect: vi.fn(),
    connected: false,
    active: true,
    on: vi.fn((event: string, fn: (...a: unknown[]) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      return s;
    }),
    /** Fire every handler registered for `event`. */
    fire: (event: string, ...args: unknown[]) => {
      for (const fn of handlers.get(event) ?? []) fn(...args);
    },
  };
  return s;
};

/** A JWT-shaped token whose payload carries `exp` (seconds) — decoded, never verified. */
function jwt(expiresInMs: number, tag = 't'): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u1', tag, exp: Math.floor((Date.now() + expiresInMs) / 1000) })}.sig`;
}

/** Route fetch: answer the refresh endpoint as the test says; nothing else is called. */
function refreshServer(outcome: 'ok' | 'refused' | 'deferred') {
  let resolve!: (r: Response) => void;
  const calls: string[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (!url.endsWith('/api/auth/refresh')) throw new Error(`unexpected fetch ${url}`);
    const ok = new Response(JSON.stringify({ accessToken: jwt(15 * 60_000, 'fresh') }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    const refused = new Response(JSON.stringify({ error: 'Invalid refresh token' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
    if (outcome === 'ok') return Promise.resolve(ok);
    if (outcome === 'refused') return Promise.resolve(refused);
    return new Promise<Response>((r) => { resolve = r; });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return {
    refreshCalls: () => calls.filter((u) => u.endsWith('/api/auth/refresh')).length,
    finish: (ok = true) => resolve(ok
      ? new Response(JSON.stringify({ accessToken: jwt(15 * 60_000, 'fresh') }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify({ error: 'no' }), { status: 401, headers: { 'content-type': 'application/json' } })),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

type IoOptions = {
  path?: string;
  auth?: (cb: (payload: unknown) => void) => void;
  autoConnect?: boolean;
  transports?: unknown;
};

/**
 * Build the socket with a given VITE_SOCKET_URL and hand back the call.
 *
 * The module memoises its socket, so each case needs a fresh module registry
 * rather than a reset singleton -- resetting the singleton would not re-read
 * the environment.
 */
async function createSocketWith(value: string | undefined) {
  vi.resetModules();
  ioMock.mockReset();
  ioMock.mockReturnValue(fakeSocket());

  if (value === undefined) vi.stubEnv('VITE_SOCKET_URL', undefined as unknown as string);
  else vi.stubEnv('VITE_SOCKET_URL', value);

  const { getSocket, resetSocket } = await import('./socket');
  const { setAccessToken, getAccessToken } = await import('./api-client');

  const sock = getSocket() as unknown as ReturnType<typeof fakeSocket>;

  expect(ioMock).toHaveBeenCalledTimes(1);
  const [origin, options] = ioMock.mock.calls[0] as [string, IoOptions];
  return { origin, options, setAccessToken, getAccessToken, getSocket, resetSocket, sock };
}

const originalFetch = global.fetch;

beforeEach(() => {
  ioMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  global.fetch = originalFetch;
});

describe('the socket connects to the configured origin', () => {
  it('passes the configured absolute origin to io()', async () => {
    const { origin } = await createSocketWith('https://api.example.test');
    expect(origin).toBe('https://api.example.test');
  });

  it('is an absolute origin, not a same-origin path', async () => {
    // The distinction that matters: anything relative goes back through Vercel.
    const { origin } = await createSocketWith('https://api.example.test');
    expect(origin.startsWith('http')).toBe(true);
    expect(origin).not.toBe('/');
  });

  it('falls back to same-origin when the variable is absent', async () => {
    // Documented, supported behaviour -- local dev and the rollback path.
    const { origin } = await createSocketWith(undefined);
    expect(origin).toBe('/');
  });

  it('treats a blank value as absent rather than as an origin', async () => {
    const { origin } = await createSocketWith('   ');
    expect(origin).toBe('/');
  });
});

describe('everything else about the connection is unchanged', () => {
  it('keeps the /socket.io path', async () => {
    // The path is independent of the origin and the server still serves it
    // there. Moving it would 404 the handshake at the new origin.
    const { options } = await createSocketWith('https://api.example.test');
    expect(options.path).toBe('/socket.io');
  });

  it('keeps autoConnect', async () => {
    const { options } = await createSocketWith('https://api.example.test');
    expect(options.autoConnect).toBe(true);
  });

  it('supplies the current access token through the auth callback', async () => {
    const { options, setAccessToken } = await createSocketWith('https://api.example.test');

    const tokenOne = jwt(10 * 60_000, 'one');
    setAccessToken(tokenOne);
    const first = vi.fn();
    options.auth!(first);
    expect(first).toHaveBeenCalledWith({ token: tokenOne });
  });

  it('re-reads the token every time it is called, which is what makes reconnects work', async () => {
    // socket.io-client invokes `auth` again on each reconnection attempt. If it
    // were a plain object captured at construction, a socket that dropped after
    // a token refresh would reconnect with the stale token and be rejected by
    // the handshake middleware -- an auth-error the user cannot clear without a
    // reload.
    const { options, setAccessToken } = await createSocketWith('https://api.example.test');

    const firstToken = jwt(10 * 60_000, 'first');
    setAccessToken(firstToken);
    const before = vi.fn();
    options.auth!(before);

    const secondToken = jwt(10 * 60_000, 'second');
    setAccessToken(secondToken);
    const after = vi.fn();
    options.auth!(after);

    expect(before).toHaveBeenCalledWith({ token: firstToken });
    expect(after).toHaveBeenCalledWith({ token: secondToken });
  });
});

describe('no transport is forced', () => {
  it('passes no transports option at all', async () => {
    /*
     * Deliberately absent, and load-bearing for rollback.
     *
     * transports: ['websocket'] is the intuitive companion to this change and
     * Vercel's own Socket.IO example recommends it -- for a server running as a
     * Vercel Function, which this one is not. Setting it here removes the
     * polling fallback, so if the client ever goes back to same-origin (by
     * rollback, by a missing variable, or by someone reverting this file) the
     * socket would not degrade to polling. It would fail outright, and realtime
     * would be dead rather than slow.
     */
    const { options } = await createSocketWith('https://api.example.test');

    expect(options.transports).toBeUndefined();
    expect(Object.keys(options)).not.toContain('transports');
  });

  it('forces no transport on the same-origin fallback either', async () => {
    const { options } = await createSocketWith(undefined);
    expect(options.transports).toBeUndefined();
  });
});

/**
 * The handshake carries a token the server will accept.
 *
 * After a quarter of an hour idle the in-memory token has expired. The
 * reconnect that follows a screen unlock used to race the HTTP refresh that
 * the resume also triggers, and usually lost: the server refused the stale
 * token, the library made that terminal, and the device sat with no live
 * updates until a reload. An iPad spent fifty-two minutes of one night that
 * way, missing every approval of its own buy-ins.
 */
describe('a handshake waits for a fresh token when it must', () => {
  it('answers immediately with a token that has plenty of life left, and refreshes nothing', async () => {
    const { options, setAccessToken } = await createSocketWith('https://api.example.test');
    const server = refreshServer('ok');
    const token = jwt(10 * 60_000);
    setAccessToken(token);

    const cb = vi.fn();
    options.auth!(cb);
    await flush();

    expect(cb).toHaveBeenCalledWith({ token });
    expect(server.refreshCalls()).toBe(0);
  });

  it('refreshes first when the token expires within the margin', async () => {
    const { options, setAccessToken, getAccessToken } = await createSocketWith('https://api.example.test');
    const { HANDSHAKE_TOKEN_MARGIN_MS } = await import('./socket');
    const server = refreshServer('ok');
    setAccessToken(jwt(HANDSHAKE_TOKEN_MARGIN_MS - 1_000, 'stale'));

    const cb = vi.fn();
    options.auth!(cb);
    await flush();

    expect(server.refreshCalls()).toBe(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toEqual({ token: getAccessToken() });
    expect(String(getAccessToken())).toContain(jwt(0, 'fresh').split('.')[0]); // a JWT, and the refreshed one
  });

  it('the margin is thirty seconds, stated rather than derived', async () => {
    // A test that reads the constant back would move with it. This one does
    // not: a token with twenty seconds left MUST be refreshed, whatever the
    // constant says, and the constant itself is pinned.
    const { HANDSHAKE_TOKEN_MARGIN_MS } = await import('./socket');
    expect(HANDSHAKE_TOKEN_MARGIN_MS).toBe(30_000);
  });

  it('refreshes a token with twenty seconds left', async () => {
    const { options, setAccessToken } = await createSocketWith('https://api.example.test');
    const server = refreshServer('ok');
    setAccessToken(jwt(20_000, 'nearly'));

    const cb = vi.fn();
    options.auth!(cb);
    await flush();

    expect(server.refreshCalls()).toBe(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not refresh a token just outside the margin', async () => {
    const { options, setAccessToken } = await createSocketWith('https://api.example.test');
    const { HANDSHAKE_TOKEN_MARGIN_MS } = await import('./socket');
    const server = refreshServer('ok');
    const token = jwt(HANDSHAKE_TOKEN_MARGIN_MS + 5_000);
    setAccessToken(token);

    const cb = vi.fn();
    options.auth!(cb);
    await flush();

    expect(server.refreshCalls()).toBe(0);
    expect(cb).toHaveBeenCalledWith({ token });
  });

  it('refreshes first when there is no token at all', async () => {
    const { options, setAccessToken } = await createSocketWith('https://api.example.test');
    const server = refreshServer('ok');
    setAccessToken(null);

    const cb = vi.fn();
    options.auth!(cb);
    await flush();

    expect(server.refreshCalls()).toBe(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect((cb.mock.calls[0][0] as { token: string }).token).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
  });

  it('still answers, with the best token it has, when the refresh is refused', async () => {
    // The handshake must never hang. A refused refresh means the server will
    // refuse the handshake too — and that refusal flows through the existing
    // state handling, which is the right place for it.
    const { options, setAccessToken } = await createSocketWith('https://api.example.test');
    refreshServer('refused');
    const stale = jwt(-1_000, 'expired');
    setAccessToken(stale);

    const cb = vi.fn();
    options.auth!(cb);
    await flush();

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ token: stale });
  });

  it('shares an in-flight refresh rather than presenting the cookie twice', async () => {
    // THE 18:35:03 SEQUENCE. Seven API calls have just 401ed and the shared
    // refresh is in flight; the socket opens in the same second. The handshake
    // must wait for that refresh, use its token, and add no second refresh.
    const { options, setAccessToken, getAccessToken } = await createSocketWith('https://api.example.test');
    const { refreshAccessToken } = await import('./api-client');
    const server = refreshServer('deferred');
    setAccessToken(jwt(-60_000, 'expired'));

    const inFlight = refreshAccessToken(); // the resume's own refresh, already started
    const cb = vi.fn();
    options.auth!(cb);
    await flush();
    expect(cb, 'still waiting on the refresh').not.toHaveBeenCalled();

    server.finish(true);
    await inFlight;
    await flush();

    expect(server.refreshCalls(), 'one refresh for both the HTTP path and the handshake').toBe(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ token: getAccessToken() });
    expect(String(getAccessToken())).not.toContain('expired');
  });

  it('a late answer for a socket that was torn down says nothing', async () => {
    const { options, setAccessToken, resetSocket } = await createSocketWith('https://api.example.test');
    const server = refreshServer('deferred');
    setAccessToken(jwt(-1_000));

    const cb = vi.fn();
    options.auth!(cb);
    resetSocket(); // sign-out while the refresh is in flight
    server.finish(true);
    await flush();

    expect(cb, 'no handshake completes for a socket that no longer exists').not.toHaveBeenCalled();
  });

  it('a late answer cannot complete a handshake for a socket built afterwards', async () => {
    const { options, setAccessToken, resetSocket, getSocket } = await createSocketWith('https://api.example.test');
    const server = refreshServer('deferred');
    setAccessToken(jwt(-1_000));

    const oldCb = vi.fn();
    options.auth!(oldCb);
    resetSocket();
    ioMock.mockReturnValue(fakeSocket());
    getSocket(); // a replacement under, potentially, a different identity
    server.finish(true);
    await flush();

    expect(oldCb).not.toHaveBeenCalled();
  });
});

/**
 * A refused handshake gets one chance to come back.
 *
 * socket.io-client stops retrying after a middleware refusal, which is right
 * when the session is gone and wrong when the token merely expired. One
 * refresh; if it yields a token, one connect; otherwise the socket stays
 * refused and the screen keeps saying "Session expired".
 */
describe('recovering from a refused handshake, once', () => {
  it('refreshes and reconnects exactly once when the refusal was terminal', async () => {
    const { sock, setAccessToken } = await createSocketWith('https://api.example.test');
    const server = refreshServer('ok');
    setAccessToken(jwt(-1_000));

    sock.active = false; // the library has given up: a middleware refusal
    sock.fire('connect_error', new Error('Invalid or expired access token'));
    await flush();

    expect(server.refreshCalls()).toBe(1);
    expect(sock.connect).toHaveBeenCalledTimes(1);
  });

  it('stays refused when the refresh is refused', async () => {
    const { sock } = await createSocketWith('https://api.example.test');
    const server = refreshServer('refused');

    sock.active = false;
    sock.fire('connect_error', new Error('Invalid or expired access token'));
    await flush();

    expect(server.refreshCalls()).toBe(1);
    expect(sock.connect).not.toHaveBeenCalled();
  });

  it('does not loop: a second refusal after the retry gets no refresh and no connect', async () => {
    const { sock } = await createSocketWith('https://api.example.test');
    const server = refreshServer('ok');

    sock.active = false;
    sock.fire('connect_error', new Error('Invalid or expired access token'));
    await flush();
    expect(sock.connect).toHaveBeenCalledTimes(1);

    // The retried handshake is refused too — a genuinely dead session.
    sock.fire('connect_error', new Error('Invalid or expired access token'));
    await flush();

    expect(server.refreshCalls(), 'no second refresh').toBe(1);
    expect(sock.connect, 'no second connect').toHaveBeenCalledTimes(1);
  });

  it('arms again after a successful connect, so a later refusal gets its own chance', async () => {
    const { sock } = await createSocketWith('https://api.example.test');
    const server = refreshServer('ok');

    sock.active = false;
    sock.fire('connect_error', new Error('x'));
    await flush();
    sock.fire('connect');
    sock.fire('connect_error', new Error('x'));
    await flush();

    expect(server.refreshCalls()).toBe(2);
    expect(sock.connect).toHaveBeenCalledTimes(2);
  });

  it('leaves transport errors to the library, which is already retrying them', async () => {
    const { sock } = await createSocketWith('https://api.example.test');
    const server = refreshServer('ok');

    sock.active = true; // still retrying on its own
    sock.fire('connect_error', new Error('xhr poll error'));
    sock.fire('connect_error', new Error('websocket error'));
    await flush();

    expect(server.refreshCalls()).toBe(0);
    expect(sock.connect).not.toHaveBeenCalled();
  });

  it('does not reconnect a socket that was torn down while the refresh was in flight', async () => {
    const { sock, resetSocket } = await createSocketWith('https://api.example.test');
    const server = refreshServer('deferred');

    sock.active = false;
    sock.fire('connect_error', new Error('Invalid or expired access token'));
    resetSocket();
    server.finish(true);
    await flush();

    expect(sock.connect).not.toHaveBeenCalled();
  });
});
