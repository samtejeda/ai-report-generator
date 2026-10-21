import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicPath, PUBLIC_API, PUBLIC_PAGES } from "./public-surface";

// "Every route and server action re-checks session, role and organization itself" (CLAUDE.md,
// audit 03 item 2, audit 04 item 6). This reads the source on disk, so a route, page or server
// action added later without a guard fails CI instead of relying on someone remembering.

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const read = (file: string) => readFileSync(file, "utf8");
/** app/(app)/clients/[id]/route.ts -> /clients/{id} ; route groups vanish, [...x] segments too. */
const urlPath = (file: string) => {
  const p = file
    .replace(/^app\//, "")
    .replace(/(^|\/)(route|page|layout)\.(ts|tsx|js|jsx)$/, "")
    .split("/")
    .filter((seg) => !/^\(.*\)$/.test(seg))
    .join("/")
    .replace(/\/?\[\.\.\.\w+\]$/, "")
    .replace(/\[(\w+)\]/g, "{$1}");
  return "/" + p;
};

const appFiles = walk("app");
const routes = appFiles.filter((f) => /\/route\.(ts|tsx|js)$/.test(f));
const pages = appFiles.filter((f) => /\/page\.(tsx|jsx|ts|js)$/.test(f));
const layouts = appFiles.filter((f) => /\/layout\.(tsx|jsx)$/.test(f));

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const GUARD_CALL = /\b(requireRole|requireSession)\(/;

// Pages that are neither public nor guarded by requireSession/requireRole, each with the reason.
// /account/mfa is for a signed-in user who has not set up the authenticator app yet: it is the one
// place a password-only session is allowed, and it checks that itself.
const OWN_CHECK_PAGES: Record<string, string> = {
  "/account/mfa": "getEnrollingSessionOrNull(): a password session that has not enrolled MFA yet",
};

describe("route handlers", () => {
  it("the scan finds the routes we know about (guards against it silently finding nothing)", () => {
    expect(routes.map(urlPath).sort()).toEqual(["/api/admin/assignments", "/api/admin/assignments/{id}", "/api/admin/inference-endpoint", "/api/admin/users", "/api/admin/users/{id}", "/api/admin/users/{id}/deactivate", "/api/admin/users/{id}/reactivate", "/api/admin/users/{id}/reset-mfa", "/api/auth", "/api/clients", "/api/clients/{id}", "/api/health", "/api/me"]);
  });

  const publicApiPaths = new Set(PUBLIC_API.map((a) => a.path));
  const guarded = routes.filter((f) => !publicApiPaths.has(urlPath(f)));
  const open = routes.filter((f) => publicApiPaths.has(urlPath(f)));

  it.each(guarded.map((f) => [f] as const))("%s exports only guardedRoute(...) handlers", (file) => {
    const src = read(file);
    expect(src, "imports the guard").toMatch(/import\s*\{[^}]*\bguardedRoute\b[^}]*\}\s*from\s*"@\/lib\/auth\/guard"/);
    const exported = HTTP_METHODS.filter((m) => new RegExp(`export\\s+(const|async\\s+function|function)\\s+${m}\\b`).test(src));
    expect(exported.length, "exports at least one HTTP method").toBeGreaterThan(0);
    for (const m of exported) {
      expect(src, `${m} is assigned from guardedRoute`).toMatch(new RegExp(`export\\s+const\\s+${m}\\s*=\\s*guardedRoute\\s*(<[^>]*>)?\\s*\\(`));
    }
    // No re-export tricks: `export { handler as GET }` would dodge the line above.
    expect(src).not.toMatch(new RegExp(`export\\s*\\{[^}]*\\b(${HTTP_METHODS.join("|")})\\b`));
    // A guarded route names the roles that may call it.
    expect(src).toMatch(/roles:\s*\[\s*"/);
  });

  it.each(open.map((f) => [f] as const))("%s is public only because public-surface.ts says so", (file) => {
    expect(isPublicPath(urlPath(file))).toBe(true);
  });
});

describe("pages", () => {
  it("the scan finds the pages we know about", () => {
    expect(pages.map(urlPath).sort()).toEqual(["/", "/account", "/account/mfa", "/clients", "/clients/new", "/clients/{id}", "/forgot-password", "/login", "/reset-password"]);
  });

  const publicPagePaths = new Set(PUBLIC_PAGES.map((p) => p.path));
  const protectedPages = pages.filter((f) => !publicPagePaths.has(urlPath(f)));

  it.each(protectedPages.map((f) => [f] as const))("%s checks the session or role itself", (file) => {
    const path = urlPath(file);
    if (OWN_CHECK_PAGES[path]) {
      expect(read(file)).toMatch(/getEnrollingSessionOrNull\(/);
    } else {
      expect(read(file), "calls requireRole() or requireSession() in the page").toMatch(GUARD_CALL);
    }
  });

  it("public pages are exactly the ones on the public list, and none reads tenant data", () => {
    const found = pages.filter((f) => publicPagePaths.has(urlPath(f))).map(urlPath).sort();
    expect(found).toEqual([...publicPagePaths].sort());
    for (const file of pages.filter((f) => publicPagePaths.has(urlPath(f)))) {
      expect(read(file), file).not.toMatch(/tenantDb|client-access|@\/lib\/db/);
    }
  });

  it("every public-list entry still exists (no stale entries that quietly widen the surface)", () => {
    const routePaths = new Set(routes.map(urlPath));
    const pagePaths = new Set(pages.map(urlPath));
    for (const p of PUBLIC_PAGES) expect(pagePaths.has(p.path), p.path).toBe(true);
    for (const a of PUBLIC_API) expect(routePaths.has(a.path), a.path).toBe(true);
  });
});

describe("layouts (the second layer, never the only one)", () => {
  it("the (app) group requires a session, and the clients area requires a clinical role", () => {
    expect(read("app/(app)/layout.tsx")).toMatch(/requireSession\(/);
    expect(read("app/(app)/clients/layout.tsx")).toMatch(/requireRole\(\s*"owner",\s*"associate",\s*"admin"\s*\)/);
  });

  it("every page under (app) also checks for itself, whatever the layouts do", () => {
    const underApp = pages.filter((f) => f.startsWith("app/(app)/"));
    expect(underApp.length).toBeGreaterThan(0);
    for (const file of underApp) expect(read(file), file).toMatch(GUARD_CALL);
    expect(layouts.length).toBeGreaterThan(0);
  });
});

describe("server actions", () => {
  const sources = [...walk("app"), ...walk("lib"), ...walk("components")].filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
  const actionFiles = sources.filter((f) => /^\s*["']use server["']/m.test(read(f)));

  it("every file that declares server actions calls a guard (none exist yet)", () => {
    for (const file of actionFiles) expect(read(file), `${file} has "use server" but no requireRole/requireSession`).toMatch(GUARD_CALL);
  });
});
