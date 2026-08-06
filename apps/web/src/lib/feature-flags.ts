/**
 * Flags for work that ships alongside what it replaces.
 *
 * PR #3 rebuilds the live session as a new component tree rather than mutating
 * the 4,600-line screen it replaces, so both exist in the bundle until the
 * cutover. The flag is what makes that safe: the old screen stays the default
 * and the new one is opt-in until it is complete.
 *
 * Read from localStorage, settable from the URL, so it can be flipped on a real
 * phone without a build:
 *
 *   ?next-session=1   turn on      ?next-session=0   turn off
 *
 * Deliberately not a club setting: a server-side flag would be a schema change,
 * and this must not outlive the cutover. It is deleted with the old screen.
 */

const STORAGE_KEY = 'flag:next-session';
const URL_PARAM = 'next-session';

/**
 * Applied once at startup, before anything renders, so a flipped flag takes
 * effect on the same load rather than the next one.
 */
export function applyFlagOverridesFromUrl(): void {
  if (typeof window === 'undefined') return;
  const raw = new URLSearchParams(window.location.search).get(URL_PARAM);
  if (raw === null) return;
  try {
    if (raw === '0' || raw === 'false') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // Private mode, or storage disabled. The flag simply stays off — it must
    // never be the reason the app fails to start.
  }
}

export function useNextLiveSession(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
