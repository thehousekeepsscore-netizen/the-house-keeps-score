/**
 * Golden fixtures, generated from the engine that actually shipped.
 *
 *   npx tsx src/scripts/generateEngineFixtures.ts
 *
 * Not from the new versioned engine — from the ORIGINAL source of each version,
 * checked out of git. That distinction is the whole point. A fixture generated
 * from the new implementation proves the new implementation agrees with itself;
 * a fixture generated from `a865e06^` proves it agrees with the code that
 * decided real money in August.
 *
 *     v1  a865e06^   flat rake is a total, split, remainder to the last seat
 *     v2  a865e06    flat rake became a per-player seat fee
 *     v3  a8d7734    no pot, no rake
 *
 * Run ONCE per version, commit the output, never run it again for a version
 * that already has a file — the script refuses to overwrite one. If the suite
 * goes red, the answer is a new engine version, not a new fixture.
 *
 * Each file holds two things:
 *
 *   digest   sha256 over all 22,400 canonical results, in matrix order. The
 *            tripwire: any change to any case in any position fails it.
 *   samples  every 400th case with its full expected output. The explanation:
 *            the digest says THAT something moved, these say WHAT.
 *
 * The alternative — 22,400 inlined expectations — came to 46MB a version.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixtureCases, canonicalise, digestOf, SAMPLE_STRIDE } from '../modules/offlineSessions/engineFixtureMatrix.js';
import type { SettlementResult } from '../modules/offlineSessions/settlementEngine.js';

const ENGINE_PATH = 'apps/api/src/modules/offlineSessions/settlementEngine.ts';

const SOURCES: { version: 1 | 2 | 3; ref: string }[] = [
  { version: 1, ref: 'a865e06^' },
  { version: 2, ref: 'a865e06' },
  { version: 3, ref: 'a8d7734' },
];

const FIXTURE_DIR = resolve(import.meta.dirname, '../modules/offlineSessions/fixtures');

/** Writes a version's original source to a temp file and imports it. */
async function engineAt(ref: string) {
  const repoRoot = resolve(import.meta.dirname, '../../../..');
  const source = execFileSync('git', ['show', `${ref}:${ENGINE_PATH}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const dir = mkdtempSync(join(tmpdir(), 'engine-'));
  const file = join(dir, 'engine.ts');
  writeFileSync(file, source);
  return import(file) as Promise<{
    computeSettlement: (p: unknown, s: unknown, o: unknown) => SettlementResult;
    SETTLEMENT_ENGINE_VERSION: number;
  }>;
}

async function main() {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const cases = fixtureCases();

  for (const { version, ref } of SOURCES) {
    const out = join(FIXTURE_DIR, `engine-v${version}.json`);
    if (existsSync(out)) {
      console.log(`v${version}: ${out} exists — refusing to overwrite. Delete it deliberately if you mean to.`);
      continue;
    }

    const mod = await engineAt(ref);
    if (mod.SETTLEMENT_ENGINE_VERSION !== version) {
      throw new Error(`${ref} reports engine version ${mod.SETTLEMENT_ENGINE_VERSION}, expected ${version}`);
    }

    const canonical: string[] = [];
    const samples: unknown[] = [];

    cases.forEach((c, i) => {
      const result = mod.computeSettlement(c.players, c.settings, c.opts);
      canonical.push(canonicalise(result));
      if (i % SAMPLE_STRIDE === 0) {
        samples.push({ index: i, table: c.table, settings: c.settings, expected: JSON.parse(canonical[i]) });
      }
    });

    writeFileSync(
      out,
      JSON.stringify(
        {
          engineVersion: version,
          generatedFrom: `${ref}:${ENGINE_PATH}`,
          generatedAt: new Date().toISOString(),
          note: 'Generated from the ORIGINAL source of this version, out of git. Never regenerate: a change that fails this file needs a new engine version, not a new fixture.',
          caseCount: cases.length,
          sampleStride: SAMPLE_STRIDE,
          digest: digestOf(canonical),
          samples,
        },
        null,
        1
      )
    );
    console.log(`v${version}: ${cases.length} cases, ${samples.length} samples → engine-v${version}.json`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
