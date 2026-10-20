import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// "Every route and server action is documented in API.md; no orphan test routes" (CLAUDE.md,
// audit 03 item 6). Routes are found on disk, not listed here, so a new route.ts that is not in
// API.md fails CI.
function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return /^route\.(ts|tsx|js)$/.test(name) ? [full] : [];
  });
}

const api = readFileSync("API.md", "utf8");
const routes = routeFiles("app").map((file) => ({
  file,
  // app/api/health/route.ts -> /api/health ; app/api/auth/[...all]/route.ts -> /api/auth
  path: "/" + file.replace(/^app\//, "").replace(/\/route\.\w+$/, "").replace(/\/\[\.\.\.\w+\]$/, "")
    .replace(/\[(\w+)\]/g, "{$1}"),
}));

describe("API inventory", () => {
  it("finds the known routes (guards against the scan silently finding nothing)", () => {
    expect(routes.map((r) => r.path).sort()).toEqual(["/api/admin/assignments", "/api/admin/assignments/{id}", "/api/admin/inference-endpoint", "/api/admin/users", "/api/admin/users/{id}", "/api/admin/users/{id}/deactivate", "/api/admin/users/{id}/reactivate", "/api/admin/users/{id}/reset-mfa", "/api/auth", "/api/clients", "/api/clients/{id}", "/api/health", "/api/me"]);
  });

  it.each(routes.map((r) => [r.file, r.path] as const))("%s is documented in API.md as %s", (_file, path) => {
    expect(api).toContain(`\`${path}`);
  });

  it("has no test, debug, seed or admin-bypass routes", () => {
    for (const r of routes) expect(r.path, r.file).not.toMatch(/test|debug|seed|dev|backdoor|sudo|impersonate|__/i);
  });
});
