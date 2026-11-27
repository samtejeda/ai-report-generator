import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    environment: "node",
    // The suites send single-entry x-forwarded-for headers as a proxy would: one trusted hop (lib/auth/client-ip.ts).
    env: { TRUSTED_PROXY_HOPS: "1" },
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules", ".next"],
  },
});
