let accessToken: string | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
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
