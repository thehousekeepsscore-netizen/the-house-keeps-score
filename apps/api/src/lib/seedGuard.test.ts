import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SEED_DEFAULT_EMAIL, SEED_DEFAULT_PASSWORD } from "../env.js";
import { describeSeedCredentialRisk } from "./seedGuard.js";

/**
 * The seed defaults are published, and the warning has to know what was published.
 *
 * describeSeedCredentialRisk compares the running values against SEED_DEFAULT_EMAIL
 * and SEED_DEFAULT_PASSWORD. Those two constants are also the schema defaults, and
 * .env.example is what a person actually copies. All three have to agree, or the
 * warning goes quiet about the exact string people are using — which is the only
 * case it exists for.
 *
 * That agreement was a comment until this test. A comment does not fail CI.
 *
 * Written after a real one: this repository is public and shipped
 * `ChangeMe123!` in .env.example, with the same value as the schema default. The
 * production API said so at every boot for weeks. No account was ever created
 * from it — the seed is wired into no deploy path and the production database
 * held no such user — but the credential was readable by anyone who cloned.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");

const EXAMPLES = ["/.env.example", "/apps/api/.env.example"] as const;

/** Values as a person copying the file would actually get them. */
function readExample(relative: string): Record<string, string> {
  const text = readFileSync(resolve(repoRoot, relative.slice(1)), "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

describe("the published seed defaults and the warning that watches for them", () => {
  it.each(EXAMPLES)("%s publishes exactly the values the warning knows about", (relative) => {
    const vars = readExample(relative);
    expect(vars.SEED_SUPER_ADMIN_EMAIL, `${relative} email`).toBe(SEED_DEFAULT_EMAIL);
    expect(vars.SEED_SUPER_ADMIN_PASSWORD, `${relative} password`).toBe(SEED_DEFAULT_PASSWORD);
  });

  it.each(EXAMPLES)("%s carries nothing usable as a credential", (relative) => {
    const vars = readExample(relative);
    // .invalid can never resolve (RFC 2606), so the address cannot receive mail
    // or belong to anyone.
    expect(vars.SEED_SUPER_ADMIN_EMAIL).toMatch(/\.(invalid|example)$/);
    // An instruction, not a password. The previous value read like one, which is
    // how it ended up set in production.
    expect(vars.SEED_SUPER_ADMIN_PASSWORD).toMatch(/^set-a-secure-password$/);
  });

  /*
   * The env is mocked rather than read.
   *
   * The first version of this test called describeSeedCredentialRisk() directly
   * and asserted it warned. It failed — because apps/api/.env exists on a
   * developer machine and sets these to real values, so there was nothing to
   * warn about. The test would have passed in CI and failed locally, which is a
   * test of the machine rather than of the code.
   *
   * So the state under test is stated outright: a process whose seed values are
   * still the published ones.
   */
  it("warns when the running values are still the published ones", async () => {
    vi.resetModules();
    vi.doMock("../env.js", () => ({
      SEED_DEFAULT_EMAIL,
      SEED_DEFAULT_PASSWORD,
      env: {
        NODE_ENV: "development",
        ALLOW_PRODUCTION_SEED: false,
        SEED_SUPER_ADMIN_EMAIL: SEED_DEFAULT_EMAIL,
        SEED_SUPER_ADMIN_PASSWORD: SEED_DEFAULT_PASSWORD,
      },
    }));

    const { describeSeedCredentialRisk: warn } = await import("./seedGuard.js");
    const risk = warn();

    expect(risk, "a copied .env.example must not boot silently").not.toBeNull();
    expect(risk).toContain("SEED_SUPER_ADMIN_EMAIL");
    expect(risk).toContain("SEED_SUPER_ADMIN_PASSWORD");
    vi.doUnmock("../env.js");
    vi.resetModules();
  });

  it("says nothing once both values have been changed", async () => {
    vi.resetModules();
    vi.doMock("../env.js", () => ({
      SEED_DEFAULT_EMAIL,
      SEED_DEFAULT_PASSWORD,
      env: {
        NODE_ENV: "production",
        ALLOW_PRODUCTION_SEED: false,
        SEED_SUPER_ADMIN_EMAIL: "someone@a-real-domain.test",
        SEED_SUPER_ADMIN_PASSWORD: "a-value-nobody-published",
      },
    }));

    const { describeSeedCredentialRisk: warn } = await import("./seedGuard.js");
    expect(warn(), "a warning that never clears is noise").toBeNull();
    vi.doUnmock("../env.js");
    vi.resetModules();
  });
});
