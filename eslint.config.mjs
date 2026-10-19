import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const authDbMessage =
  "The auth database client (auth_runtime role) is for lib/auth only. Feature code gets identity from requireSession().";

const rawDbMessage =
  "Raw database access bypasses the organization_id guard. Use tenantDb(ctx) from '@/lib/db/tenant'. " +
  "Only lib/db/** and the health route may use the raw client.";

const rawDbPaths = [
  { name: "@/lib/db", message: rawDbMessage },
  { name: "@/lib/db/index", message: rawDbMessage },
  { name: "@neondatabase/serverless", message: rawDbMessage },
  { name: "drizzle-orm/neon-serverless", message: rawDbMessage },
  { name: "drizzle-orm/neon-http", message: rawDbMessage },
];
// Matches the lib/db directory import (its index) and index files, but not lib/db/tenant or
// schema. Regexes, because gitignore-style globs cannot re-include children of a matched dir.
const rawDbPatterns = [{ regex: "(^|/)lib/db(/index)?$|(^|/)db/index$|^(\\.{1,2}/)+db$", message: rawDbMessage }];

// Environment scoping (audit 15 item 5): process.env is read only in these files.
// Everything else gets configuration through getEnv() in lib/env.ts, so a variable
// cannot be consumed without being declared, validated, and documented.
const PROCESS_ENV_ALLOWED = [
  "lib/env.ts", //                    the runtime schema (DATABASE_URL, INFERENCE_MODE, OLLAMA_BASE_URL)
  "drizzle.config.ts", //             the only reader of DATABASE_URL_UNPOOLED (migrations, owner credential)
  "next.config.ts", //                NODE_ENV, for dev-only CSP relaxations
  "instrumentation.ts", //            NEXT_RUNTIME, set by Next itself
  "scripts/mfa-reset.mjs", //         break-glass MFA reset; reads DATABASE_URL_UNPOOLED (owner credential) on purpose
  "lib/db/integration.test.ts", //    TEST_DATABASE_URL / TEST_APP_ROLE_PASSWORD (scratch Neon branch, tests only)
  "lib/auth/auth.integration.test.ts", // same TEST_* variables, for the auth flows
  "lib/auth/authz.integration.test.ts", // same TEST_* variables; also sets the runtime variables the real route modules read, pointed at the scratch branch
];
const processEnvMessage =
  "Do not read process.env here. Add the variable to the schema in lib/env.ts and call getEnv(). " +
  "Files allowed to read process.env are listed in PROCESS_ENV_ALLOWED in eslint.config.mjs.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Tenant-isolation guard (audit 04 item 1): feature code must not import the raw DB client.
  // Only the client itself is restricted: lib/db/tenant and the schema modules stay importable.
  // (Same block also restricts the auth client, below, so the two rules are one config entry.)
  // Auth database guard (audit 03/04): the auth_runtime client reads credentials and sessions,
  // so only lib/auth may import it. Feature code gets identity from requireSession().
  {
    files: ["**/*.{ts,tsx,mjs}"],
    // lib/audit.test.ts builds a drizzle mock to prove a failed audit write never blocks the caller.
    ignores: ["lib/db/**", "lib/auth/**", "app/api/health/route.ts", "lib/audit.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [...rawDbPaths, { name: "@/lib/db/auth-db", message: authDbMessage }],
          patterns: [...rawDbPatterns, { regex: "(^|/)db/auth-db$", message: authDbMessage }],
        },
      ],
    },
  },
  // lib/auth may use the auth client but never the app client.
  {
    files: ["lib/auth/**/*.{ts,tsx}"],
    // The integration test opens its own pools as the test roles (like lib/db/integration.test.ts).
    ignores: ["lib/auth/auth.integration.test.ts", "lib/auth/authz.integration.test.ts"],
    rules: { "no-restricted-imports": ["error", { paths: rawDbPaths, patterns: rawDbPatterns }] },
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
