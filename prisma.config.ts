// Prisma configuration for Prisma 7+
// Note: dotenv is loaded automatically by Prisma CLI in most cases
import { defineConfig } from "prisma/config";

// Load dotenv for local development
if (process.env.NODE_ENV !== "production") {
  await import("dotenv/config");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});
