// Short-lived single-use key/value store for OAuth CSRF state and one-time
// login codes. A real multi-instance deployment would want Redis here (like
// Lalwani Printing uses) — this in-memory version is fine for a single
// process, which is all this app needs for now.

interface Entry {
  value: string;
  expiresAt: number;
}

const store = new Map<string, Entry>();

function sweep() {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}

export function setEphemeral(key: string, value: string, ttlMs: number): void {
  sweep();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function consumeEphemeral(key: string): string | undefined {
  const entry = store.get(key);
  store.delete(key);
  if (!entry || entry.expiresAt <= Date.now()) return undefined;
  return entry.value;
}
