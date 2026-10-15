import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const rawDbMessage =
  "Raw database access bypasses the organization_id guard. Use tenantDb(ctx) from '@/lib/db/tenant'. " +
  "Only lib/db/** and the health route may use the raw client.";

// Environment scoping (audit 15 item 5): process.env is read only in these files.
// Everything else gets configuration through getEnv() in lib/env.ts, so a variable
// cannot be consumed without being declared, validated, and documented.
const PROCESS_ENV_ALLOWED = [
  "lib/env.ts", //                    the runtime schema (DATABASE_URL, INFERENCE_MODE, OLLAMA_BASE_URL)
  "drizzle.config.ts", //             the only reader of DATABASE_URL_UNPOOLED (migrations, owner credential)
  "next.config.ts", //                NODE_ENV, for dev-only CSP relaxations
  "instrumentation.ts", //            NEXT_RUNTIME, set by Next itself
  "lib/db/integration.test.ts", //    TEST_DATABASE_URL / TEST_APP_ROLE_PASSWORD (scratch Neon branch, tests only)
];
const processEnvMessage =
  "Do not read process.env here. Add the variable to the schema in lib/env.ts and call getEnv(). " +
  "Files allowed to read process.env are listed in PROCESS_ENV_ALLOWED in eslint.config.mjs.";

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
  // Environment scoping: process.env only in the named files above.
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"],
    ignores: PROCESS_ENV_ALLOWED,
    rules: {
      "no-restricted-properties": ["error", { object: "process", property: "env", message: processEnvMessage }],
      "no-restricted-syntax": [
        "error",
        // const { env } = process
        { selector: "VariableDeclarator[init.name='process'] > ObjectPattern > Property[key.name='env']", message: processEnvMessage },
        // globalThis.process.env
        { selector: "MemberExpression[object.name='globalThis'][property.name='process']", message: processEnvMessage },
        // import { env } from "node:process"
        { selector: "ImportDeclaration[source.value=/^(node:)?process$/] > ImportSpecifier[imported.name='env']", message: processEnvMessage },
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
