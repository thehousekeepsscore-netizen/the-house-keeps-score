let accessToken: string | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

/**
 * Will the in-memory access token still be valid `marginMs` from now?
 *
 * Reads the JWT's `exp` claim by decoding the payload segment only. No
 * signature check — the client cannot verify and does not need to; it only
 * needs to avoid presenting a token the server is certain to refuse. A token
 * that is missing, not a JWT, or has no `exp` is reported as expiring, which
 * costs at most one unnecessary refresh rather than one certain refusal.
 */
export function accessTokenExpiresWithin(marginMs: number): boolean {
  if (!accessToken) return true;
  const exp = jwtExpiryMs(accessToken);
  if (exp === null) return true;
  return exp - Date.now() <= marginMs;
}

/** The `exp` claim of a JWT in milliseconds, or null if it cannot be read. */
function jwtExpiryMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

let refreshPromise: Promise<boolean> | null = null;

/**
 * Exchange the refresh cookie for a new access token — once at a time.
 *
 * Every caller in a document shares the in-flight request: a burst of 401s
 * from a resync, and the auth bootstrap on page load, all await the same
 * promise rather than each sending the cookie. That matters because the
 * server rotates the cookie on every refresh and treats a second presentation
 * of the same one as theft. The bootstrap used to call the endpoint directly,
 * which left it the one refresh path outside this dedupe.
 *
 * Resolves true when a new access token has been stored, false otherwise.
 * Never rejects: a failed refresh is an answer, not an exception.
 */
export async function refreshAccessToken(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) return false;
        const data = await res.json();
        setAccessToken(data.accessToken);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  skipAuthRetry?: boolean;
}

export async function apiFetch<T = unknown>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { body, skipAuthRetry, headers, ...rest } = options;

  const doFetch = () =>
    fetch(`/api${path}`, {
      ...rest,
      credentials: 'include',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await doFetch();

  if (res.status === 401 && !skipAuthRetry) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      res = await doFetch();
    }
  }

  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json') ? await res.json() : undefined;

  if (!res.ok) {
    throw new ApiError(res.status, (data as any)?.error ?? res.statusText, (data as any)?.details);
  }

  return data as T;
}
