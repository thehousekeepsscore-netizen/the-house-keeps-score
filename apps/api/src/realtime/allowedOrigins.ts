/**
 * Which origins may open a Socket.IO connection.
 *
 * WEB_ORIGIN is a single value and it is not only a CORS setting: oauth.google
 * builds its redirects from it, so WEB_ORIGIN/login and WEB_ORIGIN/oauth/callback
 * are whatever it says. Widening it to admit a second host would therefore move
 * the OAuth redirect target as a side effect, which is not a change anybody
 * would expect from a CORS fix.
 *
 * So the socket gets its own list, derived from WEB_ORIGIN rather than
 * configured separately. Derived, because the alternative is a new environment
 * variable that has to be set correctly in every environment before the socket
 * works in any of them -- and an origin list that can disagree with WEB_ORIGIN
 * is a thing that will eventually disagree with WEB_ORIGIN.
 *
 * The pair is apex and www of the same site. That is exactly the gap this
 * closes: WEB_ORIGIN is the apex, production serves from www (the apex 308s
 * across), and the browser sends the host it is actually on. While the socket
 * reached the API through the Vercel rewrite this never mattered, because the
 * request was same-origin and CORS never engaged. Connecting to Railway
 * directly makes it cross-origin for the first time, and an Origin the server
 * does not recognise is refused at the handshake.
 *
 * Nothing else is added. A host that is not the configured site's apex/www pair
 * has no business opening a socket, and a list assembled from anything other
 * than WEB_ORIGIN would be a second place to keep the deployment's identity.
 */
export function socketAllowedOrigins(webOrigin: string): string[] {
  let url: URL;
  try {
    url = new URL(webOrigin);
  } catch {
    // Malformed values are passed through untouched rather than dropped. The
    // production gate in env.ts is what refuses to boot on a bad WEB_ORIGIN;
    // silently substituting something parseable here would hide it instead.
    return [webOrigin];
  }

  // localhost and bare IPs have no apex/www relationship to derive. Development
  // and test both run on localhost, so this is the branch they take.
  const host = url.hostname;
  if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return [url.origin];
  }

  const counterpart = new URL(webOrigin);
  counterpart.hostname = host.startsWith('www.') ? host.slice(4) : `www.${host}`;

  return [url.origin, counterpart.origin];
}
