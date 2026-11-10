// Reset a user's password directly against the database.
//
// For the case where nobody can get into the app: the seed only creates
// admin@beast.com on a fresh database, and it upserts with `update: {}`, so
// re-seeding never touches an existing password. Normally you'd reset someone
// from the Users page instead — this is the way back in when no admin can log
// in at all.
//
// Run it against whichever database you mean. Production's connection string
// is in the Render dashboard under the beast-inventory-db service:
//
//   DATABASE_URL="postgres://…" npx tsx scripts/reset-password.ts admin@beast.com 'new-password'
//
// Add --create to make the account if it doesn't exist yet (ADMIN role).

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const [emailArg, passwordArg, ...rest] = process.argv.slice(2);
  const create = rest.includes("--create");
  const email = (emailArg || "").trim().toLowerCase();
  const password = passwordArg || "";

  if (!email || !password) {
    console.error('Usage: npx tsx scripts/reset-password.ts <email> <new-password> [--create]');
    process.exit(1);
  }
  if (password.length < 6) {
    console.error("Password must be at least 6 characters.");
    process.exit(1);
  }

  const host = (process.env.DATABASE_URL || "").replace(/^.*@/, "").split("/")[0] || "(unknown host)";
  const hashed = await bcrypt.hash(password, 10);
  const existing = await prisma.user.findUnique({ where: { email } });

  if (!existing) {
    if (!create) {
      const admins = await prisma.user.findMany({
        where: { role: "ADMIN" },
        select: { email: true, isActive: true },
        orderBy: { email: "asc" },
      });
      console.error(`No user "${email}" on ${host}.`);
      console.error(
        admins.length
          ? `Admin accounts there: ${admins.map((a) => a.email + (a.isActive ? "" : " (disabled)")).join(", ")}`
          : "There are no admin accounts on this database at all."
      );
      console.error("Re-run with --create to make this one.");
      process.exit(1);
    }
    await prisma.user.create({
      data: { email, password: hashed, firstName: "Admin", lastName: "User", role: "ADMIN", isActive: true },
    });
    console.log(`Created ${email} as an active ADMIN on ${host}.`);
  } else {
    await prisma.user.update({
      where: { email },
      // Re-enable at the same time: a disabled account reports the same
      // "invalid" message at the login screen, which is easy to misread.
      data: { password: hashed, isActive: true },
    });
    console.log(`Reset the password for ${email} on ${host} (role ${existing.role}, now active).`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
