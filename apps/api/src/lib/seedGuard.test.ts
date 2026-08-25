import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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
 * Written after a real one: this repository is public and shipped `ChangeMe123!`
 * in .env.example, with the same value as the schema default. The production API
 * said so at every boot for weeks. No account was ever created from it — the seed
 * is wired into no deploy path and the production database held no such user —
 * but the credential was readable by anyone who cloned.
 *
 * NOTHING HERE IMPORTS env.ts.
 *
 * Importing it runs the zod parse, which requires DATABASE_URL and
 * JWT_ACCESS_SECRET. On a developer machine apps/api/.env supplies them and this
 * passes; in CI there is no .env and it throws before a single test runs — which
 * is exactly what happened on the first attempt. No other test in this workspace
 * imports env.ts, so nothing had caught that.
 *
 * The constants are therefore read out of the source as text. That is not a
 * workaround: what this file asserts is what the repository PUBLISHES, and the
 * published form is the literal.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");

const EXAMPLES = ["/.env.example", "/apps/api/.env.example"] as const;

/** The literals as env.ts declares them, without evaluating the module. */
function declaredDefaults(): { email: string; password: string } {
  const src = readFileSync(resolve(repoRoot, "apps/api/src/env.ts"), "utf8");
  const grab = (name: string) => {
    const m = src.match(new RegExp(`export const ${name}\\s*=\\s*"([^"]*)"`));
    if (!m) throw new Error(`${name} is no longer declared as a string literal in env.ts`);
    return m[1];
  };
  return { email: grab("SEED_DEFAULT_EMAIL"), password: grab("SEED_DEFAULT_PASSWORD") };
}

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
    const { email, password } = declaredDefaults();
    const vars = readExample(relative);
    expect(vars.SEED_SUPER_ADMIN_EMAIL, `${relative} email`).toBe(email);
    expect(vars.SEED_SUPER_ADMIN_PASSWORD, `${relative} password`).toBe(password);
  });

  it.each(EXAMPLES)("%s carries nothing usable as a credential", (relative) => {
    const vars = readExample(relative);
    // .invalid can never resolve (RFC 2606), so the address cannot receive mail
    // or belong to anyone.
    expect(vars.SEED_SUPER_ADMIN_EMAIL).toMatch(/\.(invalid|example)$/);
    // An instruction, not a password. The previous value read like one, which is
    // how it ended up set in production.
    expect(vars.SEED_SUPER_ADMIN_PASSWORD).toBe("set-a-secure-password");
  });

  /*
   * The env is mocked rather than read.
   *
   * An earlier version called describeSeedCredentialRisk() against the real env
   * and failed locally, because apps/api/.env sets these to real values — a test
   * of the machine rather than of the code. The state under test is now stated
   * outright: a process whose seed values are still the published ones.
   */
  async function riskWith(email: string, password: string) {
    const declared = declaredDefaults();
    vi.resetModules();
    vi.doMock("../env.js", () => ({
      SEED_DEFAULT_EMAIL: declared.email,
      SEED_DEFAULT_PASSWORD: declared.password,
      env: {
        NODE_ENV: "development",
        ALLOW_PRODUCTION_SEED: false,
        SEED_SUPER_ADMIN_EMAIL: email,
        SEED_SUPER_ADMIN_PASSWORD: password,
      },
    }));
    const { describeSeedCredentialRisk } = await import("./seedGuard.js");
    const result = describeSeedCredentialRisk();
    vi.doUnmock("../env.js");
    vi.resetModules();
    return result;
  }

  it("warns when the running values are still the published ones", async () => {
    const { email, password } = declaredDefaults();
    const risk = await riskWith(email, password);
    expect(risk, "a copied .env.example must not boot silently").not.toBeNull();
    expect(risk).toContain("SEED_SUPER_ADMIN_EMAIL");
    expect(risk).toContain("SEED_SUPER_ADMIN_PASSWORD");
  });

  it("names only the half that is still a default", async () => {
    const { email } = declaredDefaults();
    const risk = await riskWith(email, "a-value-nobody-published");
    expect(risk).toContain("SEED_SUPER_ADMIN_EMAIL");
    expect(risk).not.toContain("SEED_SUPER_ADMIN_PASSWORD");
  });

  it("says nothing once both values have been changed", async () => {
    const risk = await riskWith("someone@a-real-domain.test", "a-value-nobody-published");
    expect(risk, "a warning that never clears is noise").toBeNull();
  });
});
