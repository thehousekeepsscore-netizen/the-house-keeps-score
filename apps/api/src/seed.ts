import { prisma } from "./lib/prisma.js";
import { env } from "./env.js";
import { hashPassword } from "./utils/password.js";
import { assertSeedingAllowed, describeSeedCredentialRisk } from "./lib/seedGuard.js";

async function main() {
  // The realistic accident isn't someone typing this on purpose: it's a deploy
  // pipeline that runs `npm run seed` after `prisma migrate deploy` because
  // that is what the staging pipeline did.
  assertSeedingAllowed("a super-admin account with access to every club's money");

  const risk = describeSeedCredentialRisk();
  if (risk) console.warn(`⚠  ${risk} — the account this creates is publicly guessable.`);

  const email = env.SEED_SUPER_ADMIN_EMAIL.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });

  if (!existing) {
    console.log(`Creating Super Admin: ${email}`);
    await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(env.SEED_SUPER_ADMIN_PASSWORD),
        displayName: env.SEED_SUPER_ADMIN_NAME,
        isSuperAdmin: true,
      },
    });
  } else if (!existing.isSuperAdmin) {
    console.log(`Promoting existing user to Super Admin: ${email}`);
    await prisma.user.update({ where: { email }, data: { isSuperAdmin: true } });
  } else {
    console.log("Super Admin already exists, skipping.");
  }

  console.log("Seed complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
