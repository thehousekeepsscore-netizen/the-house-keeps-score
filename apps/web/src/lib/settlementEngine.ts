/**
 * The settlement engine — the server's, not a copy of it.
 *
 * This file used to be 500 hand-maintained lines that mirrored
 * `apps/api/src/modules/offlineSessions/settlementEngine.ts`, kept in step by a
 * comment at the top of each asking the next person to remember. PR #22 made
 * the drift detectable by running both copies over a cross product and
 * comparing them field by field; this makes it impossible by deleting one.
 *
 * Why it mattered: the preview an admin reviews and approves is computed here,
 * and the figures actually committed are computed there. Two copies meant the
 * host could approve one settlement while the club recorded another, with no
 * error and nothing to notice it. Now the preview and the commit are the same
 * function, so the only way they can disagree is if the inputs differ — which
 * is a question about inputs, and answerable.
 *
 * The engine imports nothing, which is what lets one file serve a Node service
 * and a browser bundle. Keep it that way: a single `node:` import here would
 * break the web build.
 *
 * The API is the home rather than a shared package because `apps/api` compiles
 * with `rootDir: src` — a file outside it changes the emitted layout and
 * therefore the deployed start path. A `packages/settlement-engine` workspace
 * is the tidier long-term home, and it is a build-and-deploy change rather than
 * a code one, so it is not being made in the same step as the versioning.
 */

export * from '../../../api/src/modules/offlineSessions/settlementEngine';
