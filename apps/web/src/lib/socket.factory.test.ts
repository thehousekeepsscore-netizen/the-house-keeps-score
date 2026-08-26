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

/** Minimal stand-in: resetSocket() calls these when tearing the socket down. */
const fakeSocket = () => ({
  removeAllListeners: vi.fn(),
  disconnect: vi.fn(),
  connected: false,
  active: true,
});

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

  const { getSocket } = await import('./socket');
  const { setAccessToken } = await import('./api-client');

  getSocket();

  expect(ioMock).toHaveBeenCalledTimes(1);
  const [origin, options] = ioMock.mock.calls[0] as [string, IoOptions];
  return { origin, options, setAccessToken, getSocket };
}

beforeEach(() => {
  ioMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
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

    setAccessToken('token-one');
    const first = vi.fn();
    options.auth!(first);
    expect(first).toHaveBeenCalledWith({ token: 'token-one' });
  });

  it('re-reads the token every time it is called, which is what makes reconnects work', async () => {
    // socket.io-client invokes `auth` again on each reconnection attempt. If it
    // were a plain object captured at construction, a socket that dropped after
    // a token refresh would reconnect with the stale token and be rejected by
    // the handshake middleware -- an auth-error the user cannot clear without a
    // reload.
    const { options, setAccessToken } = await createSocketWith('https://api.example.test');

    setAccessToken('first-token');
    const before = vi.fn();
    options.auth!(before);

    setAccessToken('second-token');
    const after = vi.fn();
    options.auth!(after);

    expect(before).toHaveBeenCalledWith({ token: 'first-token' });
    expect(after).toHaveBeenCalledWith({ token: 'second-token' });
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
