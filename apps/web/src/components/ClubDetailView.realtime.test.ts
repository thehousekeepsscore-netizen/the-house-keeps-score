import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SESSION_PATCH_EVENTS } from './ClubDetailView';

/**
 * The server emits; somebody has to be listening.
 *
 * PR #3 added seven `emitToClub` calls and zero client subscriptions. Starting a
 * night, extending the clock, lifting the time limit, freezing the table for
 * settlement, resuming it, correcting a count and removing a lobby player all
 * reached the database, the socket, and nobody's screen. Every other phone at
 * the table kept showing the old state until somebody pulled to refresh — and
 * the settling one was the worst of them, because those phones still offered
 * buttons the server had already started refusing.
 *
 * Nothing caught it because nothing could: the emit and the subscription live in
 * different applications, and neither side imports the other. So this test reads
 * the API's source and holds the client against it.
 *
 * It reads rather than imports on purpose. Importing the service would drag in
 * Prisma, the socket layer and the whole environment; the emits are a syntactic
 * fact and grep is the right tool for a syntactic fact.
 */

const API_SRC = resolve(__dirname, '../../../api/src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') && !full.includes('.test.') ? [full] : [];
  });
}

/** Every event name the API emits, read out of the source. */
function emittedEvents(): string[] {
  const found = new Set<string>();
  for (const file of walk(API_SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/emitToClub\([^,]+,\s*'([^']+)'/g)) found.add(m[1]);
  }
  return [...found].sort();
}

/** Every event this screen subscribes to, read out of its source. */
function subscribedEvents(): string[] {
  const src = readFileSync(resolve(__dirname, 'ClubDetailView.tsx'), 'utf8');
  // `club:` only — connect/disconnect are Socket.IO's own lifecycle, not ours.
  const inline = [...src.matchAll(/socket\.on\('(club:[^']+)'/g)].map((m) => m[1]);
  return [...new Set([...inline, ...SESSION_PATCH_EVENTS])].sort();
}

/**
 * Emitted, and deliberately not listened for. Each needs a reason, because an
 * unexplained entry here is how the next missing subscription hides.
 */
const INTENTIONALLY_UNHANDLED: Record<string, string> = {
  // The virtual-table module. Its router is commented out in app.ts, so nothing
  // can reach the code that emits these.
  'club:session-created': 'virtual-table module, router not mounted',
  'club:session-ended': 'virtual-table module, router not mounted',
};

describe('every session event the server emits reaches the screen', () => {
  it('has a client subscription, or a written reason not to', () => {
    const emitted = emittedEvents();
    const subscribed = new Set(subscribedEvents());

    // Sanity: if the grep breaks, the rest of this test proves nothing.
    expect(emitted.length).toBeGreaterThan(10);

    const orphans = emitted.filter(
      (event) => !subscribed.has(event) && !(event in INTENTIONALLY_UNHANDLED)
    );

    expect(orphans).toEqual([]);
  });

  it('does not subscribe to events nothing emits', () => {
    // The other direction. A listener for an event that no longer exists is a
    // handler that will never run and a reader who thinks it does.
    const emitted = new Set(emittedEvents());
    const stale = subscribedEvents().filter((event) => !emitted.has(event));
    expect(stale).toEqual([]);
  });

  it('keeps every reason in the unhandled list honest', () => {
    // A reason for an event nobody emits any more is stale documentation.
    const emitted = new Set(emittedEvents());
    const gone = Object.keys(INTENTIONALLY_UNHANDLED).filter((e) => !emitted.has(e));
    expect(gone).toEqual([]);
  });
});

describe('the seven that were missing', () => {
  // Named individually rather than counted, so a regression says which one.
  const shouldPatchSession = [
    'club:session-started-playing',
    'club:session-extended',
    'club:session-time-limit-lifted',
    'club:settling-started',
    'club:settling-cancelled',
    'club:cashout-amended',
    'club:lobby-player-removed',
  ];

  for (const event of shouldPatchSession) {
    it(`${event} patches the session on screen`, () => {
      expect(SESSION_PATCH_EVENTS).toContain(event);
    });
  }
});
