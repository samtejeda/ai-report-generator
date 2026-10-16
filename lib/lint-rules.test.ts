import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// The import restrictions are the lint half of tenant isolation (audit 04 item 1) and of the
// credential/clinical split (audit 03): feature code may not import the app database client or
// the auth database client. These tests run the real eslint config on snippets.
const eslint = new ESLint({ cwd: process.cwd() });

async function violations(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
}

describe("import restrictions", () => {
  it("feature code cannot import the raw app database client", async () => {
    for (const spec of ["@/lib/db", "@/lib/db/index", "../../lib/db", "@neondatabase/serverless", "drizzle-orm/neon-serverless"]) {
      expect((await violations("app/api/clients/route.ts", `import * as x from "${spec}"; export default x;`)).length, spec).toBeGreaterThan(0);
    }
  });

  it("feature code may use tenantDb and the schema", async () => {
    for (const spec of ["@/lib/db/tenant", "@/lib/db/schema", "@/lib/db/schema/audit-log"]) {
      expect(await violations("app/api/clients/route.ts", `import * as x from "${spec}"; export default x;`), spec).toEqual([]);
    }
  });

  it("only lib/auth may import the auth database client", async () => {
    const code = `import * as x from "@/lib/db/auth-db"; export default x;`;
    expect((await violations("app/api/clients/route.ts", code)).length).toBeGreaterThan(0);
    expect((await violations("lib/audit.ts", code)).length).toBeGreaterThan(0);
    expect(await violations("lib/auth/session.ts", code)).toEqual([]);
  });

  it("lib/auth cannot import the app database client", async () => {
    expect((await violations("lib/auth/session.ts", `import * as x from "@/lib/db"; export default x;`)).length).toBeGreaterThan(0);
    expect((await violations("lib/auth/session.ts", `import * as x from "@neondatabase/serverless"; export default x;`)).length).toBeGreaterThan(0);
  });
});
