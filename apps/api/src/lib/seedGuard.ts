import { env, SEED_DEFAULT_EMAIL, SEED_DEFAULT_PASSWORD } from "../env.js";

/**
 * The single definition of "seeding a production database requires an explicit
 * override". Every script that writes seed data imports this one.
 *
 * It lives here rather than in seed.ts because the rule is about the class of
 * script, not about any one of them. When seed.ts was guarded alone, the
 * codebase had two security models: creating a super-admin was gated, while
 * seed-history.ts — which inserts HistoricalSessionRecord rows, i.e. money —
 * was not. A rule that only some scripts follow isn't a rule, it's a habit, and
 * the next seed script written would have inherited the unguarded half.
 *
 * @param writes Short description of what this script inserts, shown in the
 *               refusal so the operator knows what was blocked.
 */
export function assertSeedingAllowed(writes: string) {
  if (env.NODE_ENV !== "production") return;

  const line = "─".repeat(64);

  if (!env.ALLOW_PRODUCTION_SEED) {
    console.error(
      [
        line,
        "  REFUSING TO SEED — NODE_ENV=production",
        line,
        `  This would write to a production database: ${writes}.`,
        "",
        "  Seed scripts assume a database they are allowed to invent data in.",
        "  If you genuinely intend to run this against production, re-run with:",
        "",
        "      ALLOW_PRODUCTION_SEED=true npm run <script>",
        line,
      ].join("\n")
    );
    process.exit(1);
  }

  console.warn(
    [
      line,
      "  ⚠  SEEDING A PRODUCTION DATABASE",
      `     ALLOW_PRODUCTION_SEED=true — proceeding to write: ${writes}`,
      line,
    ].join("\n")
  );
}

/**
 * Returns a warning when the super-admin seed credentials are still the public
 * .env.example values, or null when they've been changed.
 *
 * Surfaced at every server start, not just in production: the failure mode is
 * a default that quietly survives from first-run to deploy day, and the only
 * reliable way to stop that is to keep saying so while it's still cheap to fix.
 * Production boots refuse on genuinely broken config; this is a nudge, not a
 * gate, because a default seed password is not wrong on a laptop.
 */
export function describeSeedCredentialRisk(): string | null {
  const stale: string[] = [];
  if (env.SEED_SUPER_ADMIN_EMAIL.toLowerCase() === SEED_DEFAULT_EMAIL) stale.push("SEED_SUPER_ADMIN_EMAIL");
  if (env.SEED_SUPER_ADMIN_PASSWORD === SEED_DEFAULT_PASSWORD) stale.push("SEED_SUPER_ADMIN_PASSWORD");

  if (stale.length === 0) return null;
  return `${stale.join(" and ")} still ${stale.length === 1 ? "has" : "have"} the public .env.example default`;
}
