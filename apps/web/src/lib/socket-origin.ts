/**
 * Where the Socket.IO client connects.
 *
 * The socket used to be same-origin, which put it behind the Vercel rewrite in
 * apps/web/vercel.json. That rewrite forwards HTTP but does not carry a
 * WebSocket upgrade: the handshake reached Railway stripped of its Upgrade
 * headers, engine.io answered 400 (code 3), and socket.io-client did what it is
 * designed to do -- kept the polling transport and said nothing. Production ran
 * on HTTP long-polling for the entire life of the deployment. Measured against
 * Railway directly, the same upgrade returns 101 and stays open, so the server
 * was never the problem.
 *
 * Hence an absolute origin, which takes Vercel out of the socket's path
 * entirely. It is configuration rather than a constant because the value is a
 * property of the deployment, not of the code, and because a variable is what
 * makes the rollback below a redeploy instead of a revert.
 *
 * WHEN THE VARIABLE IS ABSENT the socket falls back to same-origin, and that is
 * deliberate in all four environments:
 *
 *   local      vite.config.ts proxies /socket.io with `ws: true`, so
 *              same-origin already upgrades correctly. Nothing to configure,
 *              and no reason to point a laptop at production Railway.
 *   test       jsdom never opens a socket; the factory is asserted directly.
 *   CI         `npm run build` runs with no environment at all. A build that
 *              demanded this variable would fail every CI run to protect a
 *              value CI has no use for.
 *   production supplied by the Vercel project. If it goes missing the client
 *              returns to the same-origin polling path that is running today --
 *              slower, but the proven-working baseline rather than a break.
 *
 * That last line is the rollback: the /socket.io rewrite stays in vercel.json
 * precisely so removing this variable is a complete, one-step return to the
 * previous behaviour without touching Railway, DNS, or this code.
 *
 * The trade is that a missing variable is quiet -- it ships a no-op rather than
 * a failure. A build-time gate cannot cover that (CI has no value to give it),
 * so the check belongs after deploy, where the transport is directly
 * observable: a connected socket that is still issuing /socket.io/?transport=
 * polling requests has not migrated.
 */
export const SAME_ORIGIN = '/';

export function resolveSocketOrigin(configured: string | undefined): string {
  const value = configured?.trim();
  return value ? value : SAME_ORIGIN;
}
