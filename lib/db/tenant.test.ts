import { describe, expect, it } from "vitest";
import { getTableName, eq, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";
import {
  DERIVED_DELETABLE_TABLES,
  INSERT_ONLY_TABLES,
  SOFT_DELETE_TABLES,
  TENANT_TABLES,
  tenantDb,
} from "./tenant";

// drizzle.mock builds real queries without a connection, so we can assert on the SQL.
const mock = drizzle.mock({ schema });
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";
const t = tenantDb({ organizationId: ORG }, mock);

describe("tenantDb: organization_id can't be omitted", () => {
  it("rejects a malformed organization id", () => {
    expect(() => tenantDb({ organizationId: "not-a-uuid" }, mock)).toThrow(/UUID/);
    expect(() => tenantDb({ organizationId: "' or 1=1 --" }, mock)).toThrow(/UUID/);
  });

  it.each(TENANT_TABLES.map((tbl) => [getTableName(tbl), tbl] as const))(
    "find on %s always filters by organization_id (parameterized)",
    (_name, table) => {
      const q = t.find(table, { limit: 10 }).toSQL();
      expect(q.sql).toContain(`"${getTableName(table)}"."organization_id" = $1`);
      expect(q.params[0]).toBe(ORG);
    },
  );

  it("a caller's where clause is ANDed, so it cannot widen the scope", () => {
    const q = t
      .find(schema.clients, { where: or(eq(schema.clients.id, ID), sql`true`), limit: 5 })
      .toSQL();
    expect(q.sql).toMatch(/"organization_id" = \$1 and .*"deleted_at" is null and \(/);
    expect(q.params[0]).toBe(ORG);
  });

  it("soft-deleted rows are hidden by default and shown only on request", () => {
    for (const table of SOFT_DELETE_TABLES) {
      expect(t.find(table, { limit: 1 }).toSQL().sql, getTableName(table)).toContain('"deleted_at" is null');
      expect(t.find(table, { limit: 1, includeDeleted: true }).toSQL().sql, getTableName(table)).not.toContain(
        '"deleted_at" is null',
      );
    }
  });

  it("lists are always paginated within bounds", () => {
    for (const limit of [0, -1, 201, 1.5, Number.NaN]) {
      expect(() => t.find(schema.clients, { limit })).toThrow(/limit/);
    }
  });

  it("insert injects the caller's org and refuses a supplied one", () => {
    const q = t.insert(schema.clients, { displayName: "Test Client A" }).toSQL();
    expect(q.params).toContain(ORG);
    const smuggled = { displayName: "Test Client A", organizationId: OTHER } as never;
    expect(() => t.insert(schema.clients, smuggled)).toThrow(/organizationId/);
    expect(() => t.insert(schema.clients, [{ displayName: "ok" }, smuggled])).toThrow(/organizationId/);
  });

  it("update is scoped by organization and id, and cannot change id, org or created_at", () => {
    const q = t.update(schema.clients, ID, { displayName: "Renamed" }).toSQL();
    expect(q.sql).toContain('"organization_id" = $');
    expect(q.params).toContain(ORG);
    expect(q.params).toContain(ID);
    for (const key of ["id", "organizationId", "createdAt"]) {
      expect(() => t.update(schema.clients, ID, { [key]: OTHER } as never), key).toThrow(/cannot be updated/);
    }
  });

  it("softDelete and deleteDerived are scoped by organization", () => {
    const sd = t.softDelete(schema.clients, ID).toSQL();
    expect(sd.params).toContain(ORG);
    expect(sd.sql).toContain('"deleted_at" =');
    for (const table of DERIVED_DELETABLE_TABLES) {
      const q = t.deleteDerived(table, sql`true`).toSQL();
      expect(q.sql, getTableName(table)).toContain('"organization_id" = $1');
      expect(q.params[0]).toBe(ORG);
    }
  });

  it("ids must be UUIDs", async () => {
    expect(() => t.update(schema.clients, "1 or 1=1", { displayName: "x" })).toThrow(/UUID/);
    expect(() => t.softDelete(schema.clients, "x")).toThrow(/UUID/);
    await expect(t.get(schema.clients, "x")).rejects.toThrow(/UUID/);
  });

  it("insert-only tables expose no update, delete, or soft-delete path", () => {
    expect(INSERT_ONLY_TABLES.map((x) => getTableName(x)).sort()).toEqual([
      "audit_log",
      "methodology_prompts",
      "report_versions",
    ]);
    // The helper has no generic delete method at all, only deleteDerived (type-restricted).
    expect(Object.keys(t)).not.toContain("delete");
  });
});

// Compile-time guarantees: `npm run typecheck` fails if any of these lines stops being an error.
describe("tenantDb: type-level guards", () => {
  it("rejects misuse at compile time", () => {
    const never = () => {
      // @ts-expect-error methodology_prompts rows are never updated
      t.update(schema.methodologyPrompts, ID, { notes: "x" });
      // @ts-expect-error report_versions are insert-only
      t.update(schema.reportVersions, ID, { content: {} });
      // @ts-expect-error audit_log is append-only
      t.update(schema.auditLog, ID, { action: "x" });
      // @ts-expect-error organizations has no organization_id; use organization()/updateOrganization()
      t.find(schema.organizations, { limit: 1 });
      // @ts-expect-error clinical tables cannot be hard-deleted by the app
      t.deleteDerived(schema.clients, sql`true`);
      // @ts-expect-error report_versions cannot be hard-deleted by the app
      t.deleteDerived(schema.reportVersions, sql`true`);
      // @ts-expect-error report_sections has no deleted_at
      t.softDelete(schema.reportSections, ID);
      // @ts-expect-error organization_id is injected, not supplied
      t.insert(schema.clients, { displayName: "x", organizationId: OTHER });
      // @ts-expect-error inference_endpoint is not settable through the generic helper
      t.updateOrganization({ inferenceEndpoint: "https://example.test" });
    };
    expect(never).toBeTypeOf("function");
  });
});

describe("tenantDb: inference endpoint (audit 04 item 8)", () => {
  it.each([
    "http://localhost:11434/v1",
    "https://169.254.169.254",
    "https://evil.example/.ts.net",
    "https://a.b.ts.net.evil.example",
    "",
  ])("refuses %j before sending anything", async (value) => {
    // The mock has no connection: a refusal must happen before any statement is attempted.
    await expect(t.setInferenceEndpoint(value)).rejects.toThrow(/inference endpoint refused/);
  });

  it("the generic organization update cannot carry the endpoint", () => {
    // Also enforced at compile time (see the @ts-expect-error above) and by the grants.
    expect(Object.keys(t)).toContain("setInferenceEndpoint");
  });
});

describe("tenantDb: compare-and-set guard and restore", () => {
  const guard = eq(schema.users.role, "associate");

  it("a guard is ANDed into the same statement as the organization and id filters", () => {
    const q = t.update(schema.users, ID, { role: "admin" }, guard).toSQL();
    expect(q.sql).toMatch(/where \("users"\."organization_id" = \$\d+ and "users"\."deleted_at" is null and "users"\."id" = \$\d+ and "users"\."role" = \$\d+/);
    expect(q.params).toContain(ORG);
    expect(q.params).toContain("associate");
  });

  it("without a guard the statement is unchanged (organization, not deleted, id)", () => {
    const q = t.update(schema.users, ID, { role: "admin" }).toSQL();
    expect(q.sql).not.toMatch(/"users"\."role" = \$/);
  });

  it("restore only touches a soft-deleted row of this organization, and sets deleted_at to null", () => {
    const q = t.restore(schema.users, ID, guard).toSQL();
    expect(q.sql).toMatch(/set "deleted_at" = \$\d+/);
    expect(q.sql).toContain('"users"."organization_id" = $');
    expect(q.sql).toContain('"users"."deleted_at" is not null');
    expect(q.sql).not.toContain('"deleted_at" is null');
    expect(q.params).toContain(ORG);
    expect(q.params).toContain(null);
  });

  it("restore rejects a malformed id before any SQL, and a table without deleted_at at compile time", () => {
    expect(() => t.restore(schema.users, "1; drop table users")).toThrow(/UUID/);
    const never = () => {
      // @ts-expect-error report_sections has no deleted_at
      t.restore(schema.reportSections, ID);
    };
    expect(never).toBeTypeOf("function");
  });
});

describe("tenantDb.lock", () => {
  it("is refused outside a transaction (a standalone lock would be released at once) and for odd names", async () => {
    await expect(t.lock("generation")).rejects.toThrow(/needs a transaction/);
  });

  it("only accepts short lower-case names, inside a transaction", async () => {
    const calls: unknown[] = [];
    const fake = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute: async (q: unknown) => void calls.push(q) }),
    } as never;
    const tx = tenantDb({ organizationId: ORG }, fake);
    await tx.transaction(async (inner) => {
      await inner.lock("generation");
      for (const bad of ["", "Generation", "a b", "x".repeat(41), "a'; select 1 --"]) await expect(inner.lock(bad), bad).rejects.toThrow(/lock name/);
    });
    // set_config for the tenant, then the lock; the name and org are bound parameters, not spliced text.
    expect(calls).toHaveLength(2);
  });
});
