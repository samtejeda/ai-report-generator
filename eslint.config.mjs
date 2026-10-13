import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const rawDbMessage =
  "Raw database access bypasses the organization_id guard. Use tenantDb(ctx) from '@/lib/db/tenant'. " +
  "Only lib/db/** and the health route may use the raw client.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Tenant-isolation guard (audit 04 item 1): feature code must not import the raw DB client.
  {
    files: ["**/*.{ts,tsx,mjs}"],
    ignores: ["lib/db/**", "app/api/health/route.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@/lib/db", message: rawDbMessage },
            { name: "@/lib/db/index", message: rawDbMessage },
            { name: "@neondatabase/serverless", message: rawDbMessage },
            { name: "drizzle-orm/neon-serverless", message: rawDbMessage },
            { name: "drizzle-orm/neon-http", message: rawDbMessage },
          ],
          patterns: [
            { group: ["**/lib/db", "**/lib/db/index", "**/db/index"], message: rawDbMessage },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
