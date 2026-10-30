import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/neon-serverless";
import { and, eq } from "drizzle-orm";
import * as schema from "./schema";
import type { SessionContext } from "@/lib/auth/session";
import { REPORT_WRITE_ROLES } from "@/lib/auth/permissions";
import { authorNames, reportVisibilityFilter, type SectionView, type VersionView } from "./report-access";
import { createReport, finalizeReport, saveSection } from "./report-write";
import { tenantDb } from "./tenant";

// SQL-shape tests without a connection. Behavior against a real database (two practices, three
// roles) is in lib/auth/reports.integration.test.ts.
const mock = drizzle.mock({ schema });
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";
const as = (role: SessionContext["role"]): SessionContext => ({ userId: USER, organizationId: ORG, role, signedInAt: new Date("2026-10-20T12:00:00Z") });

function sqlOf(filter: ReturnType<typeof reportVisibilityFilter>) {
  if (!filter) throw new Error("no filter");
  return tenantDb({ organizationId: ORG }, mock).find(schema.reports, { where: and(eq(schema.reports.id, ID), filter), limit: 1 }).toSQL();
}

describe("report visibility follows the client", () => {
  it("owner: the report's own client must exist in the practice and be live; no assignment rule", () => {
    const q = sqlOf(reportVisibilityFilter(as("owner")));
    expect(q.sql).toContain('from "clients"');
    expect(q.sql).toContain('"clients"."organization_id" = "reports"."organization_id"');
    expect(q.sql).toContain('"clients"."id" = "reports"."client_id"');
    expect(q.sql).toContain('"clients"."deleted_at" is null');
    expect(q.sql).not.toContain("client_assignments");
  });

  it.each(["associate", "admin"] as const)("%s: also the client must be assigned or granted to this user", (role) => {
    const q = sqlOf(reportVisibilityFilter(as(role)));
    expect(q.sql).toContain('from "client_assignments"');
    expect(q.sql).toContain('"client_assignments"."client_id" = "clients"."id"');
    expect(q.sql).toContain('"client_assignments"."deleted_at" is null');
    expect(q.params).toContain(USER);
    expect(q.sql).not.toContain(USER);
  });

  it("an unknown role sees no reports (the default is deny)", () => {
    expect(reportVisibilityFilter(as("superuser" as never))).toBeNull();
  });
});

describe("who may write", () => {
  it("owner and associate; the data layer refuses an admin the route should already have refused", async () => {
    expect([...REPORT_WRITE_ROLES]).toEqual(["owner", "associate"]);
    await expect(createReport(as("admin"), { clientId: ID, templateSlug: "x" }, mock)).rejects.toThrow(/not allowed/);
    await expect(saveSection(as("admin"), { reportId: ID, sectionId: ID, text: "x", baseVersion: 0 }, mock)).rejects.toThrow(/not allowed/);
    await expect(finalizeReport(as("admin"), ID, mock)).rejects.toThrow(/not allowed/);
  });

  it("each write route names the same roles as the constant, and each read route names all three", () => {
    const roles = (file: string, method: string) => JSON.parse(new RegExp(`export const ${method} = guardedRoute[^]*?roles:\\s*(\\[[^\\]]*\\])`).exec(readFileSync(file, "utf8"))![1]) as string[];
    expect(roles("app/api/reports/route.ts", "POST")).toEqual([...REPORT_WRITE_ROLES]);
    expect(roles("app/api/reports/[id]/finalize/route.ts", "POST")).toEqual([...REPORT_WRITE_ROLES]);
    expect(roles("app/api/reports/[id]/sections/[sectionId]/route.ts", "PUT")).toEqual([...REPORT_WRITE_ROLES]);
    for (const [file, method] of [
      ["app/api/reports/route.ts", "GET"],
      ["app/api/reports/[id]/route.ts", "GET"],
      ["app/api/reports/[id]/sections/[sectionId]/versions/route.ts", "GET"],
    ] as const) expect(roles(file, method)).toEqual(["owner", "associate", "admin"]);
  });
});

describe("author names", () => {
  const A = "44444444-4444-4444-8444-444444444444";
  const B = "55555555-5555-4555-8555-555555555555";
  type FindArgs = Parameters<ReturnType<typeof tenantDb>["find"]>;
  const spy = (rows: { id: string; displayName: string }[] = []) => {
    const calls: FindArgs[] = [];
    const t = { find: ((...args: FindArgs) => (calls.push(args), Promise.resolve(rows))) as unknown as ReturnType<typeof tenantDb>["find"] };
    return { t, calls };
  };

  it("asks once, for the distinct ids only, in the practice, and keeps deactivated people", async () => {
    const { t, calls } = spy([{ id: A, displayName: "Synthetic A" }, { id: B, displayName: "Synthetic B" }]);
    const names = await authorNames(t, [{ createdByUserId: A }, { createdByUserId: B }, { createdByUserId: A }, { createdByUserId: null }]);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(schema.users);
    expect(calls[0][1].includeDeleted).toBe(true);
    expect(names.get(A)).toBe("Synthetic A");
    // The statement a real tenantDb builds from those options: practice filter, only the two ids, soft-deleted rows not hidden.
    const q = tenantDb({ organizationId: ORG }, mock).find(schema.users, calls[0][1]).toSQL();
    expect(q.sql).toContain('"users"."organization_id" = $1');
    expect(q.sql).toContain('"users"."id" in (');
    expect(q.sql).not.toContain('"users"."deleted_at" is null');
    expect(q.params).toEqual(expect.arrayContaining([ORG, A, B]));
    expect(q.params.filter((p) => p === A)).toHaveLength(1);
  });

  it("asks nothing when no version has an author (model text only)", async () => {
    const { t, calls } = spy();
    expect(await authorNames(t, [{ createdByUserId: null }])).toEqual(new Map());
    expect(await authorNames(t, [])).toEqual(new Map());
    expect(calls).toHaveLength(0);
  });

  it("the views carry a display name and no id, email or role of the author", () => {
    const keys = (o: Record<string, unknown>) => Object.keys(o).sort();
    const version: VersionView = { id: "x", version: 1, editType: "human_edit", text: "", createdAt: "", authorName: null };
    const section: SectionView = { id: "x", key: "", title: "", type: "prose", position: 1, text: "", version: 0, editType: null, editedAt: null, authorName: null };
    expect(keys(version)).toEqual(["authorName", "createdAt", "editType", "id", "text", "version"]);
    expect(keys(section)).toEqual(["authorName", "editType", "editedAt", "id", "key", "position", "text", "title", "type", "version"]);
  });
});
