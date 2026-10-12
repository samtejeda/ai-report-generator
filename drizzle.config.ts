import { defineConfig } from "drizzle-kit";

// drizzle-kit does not read .env.local on its own. Missing file is fine (CI, prod).
try {
  process.loadEnvFile(".env.local");
} catch {}

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema/index.ts",
  out: "./drizzle",
  // Direct (unpooled) connection: DDL needs it. App code uses DATABASE_URL via lib/db.
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED ?? "" },
});
