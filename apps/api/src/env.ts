import "dotenv/config";
import { z } from "zod";

/*
 * The seed defaults, named once so the schema below, the seed guard and the
 * startup warning all test against the same literals. These values are public —
 * they ship verbatim in .env.example — which is exactly why anything still
 * using them needs to be visible.
 *
 * They must stay identical to the two SEED_SUPER_ADMIN_* lines in BOTH copies of
 * .env.example. That equality is the mechanism: what the repository publishes is
 * exactly what describeSeedCredentialRisk warns about, so a default cannot reach
 * a deploy unannounced. Change one side without the other and the warning goes
 * quiet about the string people will actually copy — seedGuard.test.ts fails the
 * build rather than letting that happen.
 *
 * Unusable rather than merely different: `.invalid` is reserved by RFC 2606 and
 * can never resolve, and the password says what to do instead of looking like
 * one worth keeping. The pair these replaced read as real credentials, which is
 * how they came to be set in a production environment of a public repository.
 */
export const SEED_DEFAULT_EMAIL = "admin@example.invalid";
export const SEED_DEFAULT_PASSWORD = "set-a-secure-password";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4001),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),

  DATABASE_URL: z.string(),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("30d"),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().optional(),

  SEED_SUPER_ADMIN_EMAIL: z.string().email().default(SEED_DEFAULT_EMAIL),
  SEED_SUPER_ADMIN_PASSWORD: z.string().min(8).default(SEED_DEFAULT_PASSWORD),
  SEED_SUPER_ADMIN_NAME: z.string().default("Super Admin"),

  // Escape hatch for seed.ts under NODE_ENV=production. The seed defaults above
  // are public knowledge (they're in .env.example), so a seed that runs against
  // production creates a super-admin whose password anyone can read.
  ALLOW_PRODUCTION_SEED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // ---- Outbound player messaging (SMS / WhatsApp) ----
  // Everything here is optional: with no credentials the messaging layer
  // switches to a no-op that just logs, so local dev and tests never try to
  // send (or bill) anything.
  MESSAGING_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  MESSAGING_CHANNEL: z.enum(["email", "sms", "whatsapp"]).default("email"),
  // Phone numbers are stored as free text, so anything without a country
  // code gets this prefixed before sending. "91" = India.
  MESSAGING_DEFAULT_COUNTRY_CODE: z.string().default("91"),

  // Email: Resend. No template registration or regulator involved, so this is
  // the quickest channel to get running.
  RESEND_API_KEY: z.string().optional(),
  // Must be on a domain verified in Resend, e.g. "The House Keeps Score
  // <scores@yourdomain.com>".
  MESSAGING_FROM_EMAIL: z.string().optional(),

  // WhatsApp: Meta Cloud API. Business-initiated messages must use approved
  // templates (see lib/messageTemplates.ts) — free text only works inside the
  // 24h window after the player messages you, which never applies here.
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default("v21.0"),

  // SMS: Twilio.
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
});

const parsed = envSchema.parse(process.env);

/**
 * Production configuration gate.
 *
 * Most variables above have a local default so `npm run dev` works with an
 * empty .env. Those defaults are correct for a laptop and wrong for a server,
 * and every one of them fails *silently*: a WEB_ORIGIN still pointing at
 * localhost doesn't crash, it CORS-blocks every request from the real front
 * end; a half-configured OAuth pair doesn't crash, it just returns a blank
 * screen after the Google redirect. Both have already cost a debugging session
 * here.
 *
 * So in production only, a default is treated as "not configured" and the
 * process refuses to start. Booting into a broken state is worse than not
 * booting: an operator reads a startup failure, but a silent misconfiguration
 * gets reported by players.
 *
 * Deliberately not enforced outside production — development and test keep the
 * defaults and this block never executes.
 */
if (parsed.NODE_ENV === "production") {
  const problems: string[] = [];

  // Tested against process.env, not the parsed value: zod has already
  // substituted defaults, so the parsed object cannot distinguish
  // "explicitly set to the localhost value" from "never set at all".
  const requireSet = (name: keyof typeof parsed, why: string) => {
    if (!process.env[name]?.trim()) problems.push(`${name} is not set — ${why}`);
  };

  const rejectLocalhost = (name: keyof typeof parsed, why: string) => {
    const value = process.env[name]?.trim();
    if (value && /\b(localhost|127\.0\.0\.1|0\.0\.0\.0)\b/i.test(value)) {
      problems.push(`${name}="${value}" still points at localhost — ${why}`);
    }
  };

  requireSet("WEB_ORIGIN", "CORS will reject every request from the deployed front end");
  rejectLocalhost("WEB_ORIGIN", "it must be the public origin of the deployed front end");

  requireSet("GOOGLE_CLIENT_ID", "Google sign-in is the only way most players log in");
  requireSet("GOOGLE_CLIENT_SECRET", "Google sign-in cannot complete the token exchange");
  requireSet("GOOGLE_CALLBACK_URL", "Google will reject the redirect");
  rejectLocalhost("GOOGLE_CALLBACK_URL", "it must match an authorised redirect URI in the Google console");

  // JWT_ACCESS_SECRET is already required with a minimum length by the schema
  // above. What that cannot catch is the .env.example placeholder being copied
  // verbatim, which satisfies min(16) while being publicly known.
  if (process.env.JWT_ACCESS_SECRET?.trim() === "change_me_access_secret") {
    problems.push("JWT_ACCESS_SECRET is still the .env.example placeholder — anyone can forge an access token");
  }

  if (problems.length > 0) {
    const line = "─".repeat(64);
    console.error(
      [
        line,
        "  REFUSING TO START — NODE_ENV=production with incomplete configuration",
        line,
        ...problems.map((p) => `  ✗ ${p}`),
        line,
        "  Set these in the deployment environment and restart.",
        line,
      ].join("\n")
    );
    process.exit(1);
  }
}

export const env = parsed;
