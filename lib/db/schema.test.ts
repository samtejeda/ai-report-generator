import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableName, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { AUTH_TABLES } from "./schema/auth";
import { INSERT_ONLY_TABLES, TENANT_TABLES, UPDATABLE_TABLES } from "./tenant";

// No database needed: these inspect the Drizzle schema definition.
const allTables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));
const AUTH_TABLE_NAMES = new Set<string>(AUTH_TABLES.map((t) => getTableName(t)));
// `configs` is the tenant side (every table with the tenant conventions); the auth tables
// are a separate, documented registry with their own tests below.
const configs = allTables.filter((t) => !AUTH_TABLE_NAMES.has(getTableName(t))).map((t) => getTableConfig(t));
const authConfigs = allTables.filter((t) => AUTH_TABLE_NAMES.has(getTableName(t))).map((t) => getTableConfig(t));
const byName = (name: string) => configs.find((c) => c.name === name)!;
const colNames = (c: ReturnType<typeof getTableConfig>) => c.columns.map((col) => col.name);

// Documented exception: audit_log keeps no FKs so purges can never be blocked by it.
const NO_ORG_FK = new Set(["audit_log"]);

describe("schema conventions", () => {
  it("covers every CLAUDE.md table (plus read_limit_counters, the per-person read counter)", () => {
    expect(configs.map((c) => c.name).sort()).toEqual(
      [
        "audit_log",
        "client_assignments",
        "client_history",
        "clients",
        "jobs",
        "methodology_prompts",
        "organizations",
        "rag_chunks",
        "rag_documents",
        "rag_embeddings",
        "read_limit_counters",
        "report_sections",
        "report_templates",
        "report_versions",
        "reports",
        "users",
      ].sort(),
    );
  });

  it("every table has a uuid primary key named id with a database default", () => {
    for (const c of configs) {
      const id = c.columns.find((col) => col.name === "id");
      expect(id, c.name).toBeDefined();
      expect(id!.primary, c.name).toBe(true);
      expect(id!.columnType, c.name).toBe("PgUUID");
      expect(id!.hasDefault, c.name).toBe(true);
    }
  });

  it("every table has created_at (timestamptz, not null)", () => {
    for (const c of configs) {
      const col = c.columns.find((x) => x.name === "created_at");
      expect(col, c.name).toBeDefined();
      expect(col!.notNull, c.name).toBe(true);
    }
  });

  it("every table except organizations has a NOT NULL uuid organization_id", () => {
    for (const c of configs.filter((x) => x.name !== "organizations")) {
      const col = c.columns.find((x) => x.name === "organization_id");
      expect(col, c.name).toBeDefined();
      expect(col!.notNull, c.name).toBe(true);
      expect(col!.columnType, c.name).toBe("PgUUID");
    }
  });

  it("every org-scoped table has an FK to organizations (RESTRICT) except documented exceptions", () => {
    for (const c of configs.filter((x) => x.name !== "organizations" && !NO_ORG_FK.has(x.name))) {
      const fk = c.foreignKeys.map((f) => f.reference()).find(
        (r) => getTableName(r.foreignTable) === "organizations" && r.columns.length === 1 && r.columns[0].name === "organization_id",
      );
      expect(fk, c.name).toBeDefined();
    }
    for (const name of NO_ORG_FK) expect(byName(name).foreignKeys, name).toHaveLength(0);
  });

  it("no table stores files or blobs (audit 05 item 5)", () => {
    for (const c of configs) {
      for (const col of c.columns) expect(col.columnType, `${c.name}.${col.name}`).not.toMatch(/bytea|Bytea/i);
    }
  });

  it("columns are snake_case", () => {
    for (const c of configs) {
      for (const n of colNames(c)) expect(n, c.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("mutability model matches the tenant helper registries", () => {
  it("TENANT_TABLES plus organizations is exactly the set of tenant-side tables", () => {
    const registry = TENANT_TABLES.map((t) => getTableName(t));
    expect(new Set(registry).size).toBe(registry.length);
    expect([...registry, "organizations"].sort()).toEqual(configs.map((c) => c.name).sort());
  });

  it("the tenant registry and AUTH_TABLES together cover every table exactly once", () => {
    const tenant = [...TENANT_TABLES.map((t) => getTableName(t)), "organizations"];
    const auth: string[] = AUTH_TABLES.map((t) => getTableName(t));
    expect(tenant.filter((n) => auth.includes(n))).toEqual([]);
    expect([...tenant, ...auth].sort()).toEqual(allTables.map((t) => getTableName(t)).sort());
  });

  it("insert-only tables have no updated_at or deleted_at", () => {
    for (const t of INSERT_ONLY_TABLES) {
      const names = colNames(byName(getTableName(t)));
      expect(names).not.toContain("updated_at");
      expect(names).not.toContain("deleted_at");
    }
  });

  it("updatable tables have updated_at (kept fresh by the set_updated_at trigger)", () => {
    for (const t of UPDATABLE_TABLES) {
      const name: string = getTableName(t);
      const names: string[] = colNames(byName(name));
      expect(names, name).toContain("updated_at");
    }
  });

  it("the three immutable tables are not updatable", () => {
    const updatable = new Set<string>(UPDATABLE_TABLES.map((t) => getTableName(t)));
    for (const name of ["methodology_prompts", "report_versions", "audit_log"]) expect(updatable.has(name), name).toBe(false);
  });
});

describe("constraints and indexes", () => {
  it("every foreign key has a covering index or unique constraint (audit 05 item 4)", () => {
    for (const c of configs) {
      const leading: string[][] = [
        ...c.indexes.map((i) => i.config.columns.map((col) => ("name" in col ? (col.name as string) : "<expr>"))),
        ...c.uniqueConstraints.map((u) => u.columns.map((col) => col.name)),
        ...c.primaryKeys.map((p) => p.columns.map((col) => col.name)),
        ...c.columns.filter((col) => col.primary).map((col) => [col.name]),
      ];
      for (const fk of c.foreignKeys) {
        const cols = fk.reference().columns.map((col) => col.name);
        // Covered if an index leads with a parent-id column of the FK (cascade lookups),
        // or leads with organization_id followed by another FK column.
        const covered = leading.some(
          (l) =>
            cols.includes(l[0]) &&
            (l[0] !== "organization_id" || cols.length === 1 || cols.includes(l[1] ?? "")),
        );
        expect(covered, `${c.name}: FK on (${cols.join(", ")}) has no covering index`).toBe(true);
      }
    }
  });

  it("parents referenced by composite tenant FKs expose UNIQUE (organization_id, ...)", () => {
    for (const c of configs) {
      for (const fk of c.foreignKeys) {
        const r = fk.reference();
        if (r.columns.length < 2) continue;
        const target = getTableConfig(r.foreignTable);
        const wanted = r.foreignColumns.map((col) => col.name).join(",");
        const ok = target.uniqueConstraints.some((u) => u.columns.map((col) => col.name).join(",") === wanted);
        expect(ok, `${c.name} -> ${target.name} (${wanted})`).toBe(true);
      }
    }
  });

  it("audit_log has the composite access-path index from CLAUDE.md", () => {
    const idx = byName("audit_log").indexes.map((i) =>
      i.config.columns.map((col) => ("name" in col ? (col.name as string) : "")).join(","),
    );
    expect(idx).toContain("organization_id,resource_type,resource_id,created_at");
  });

  it("rag_embeddings has an HNSW cosine index", () => {
    const hnsw = byName("rag_embeddings").indexes.find((i) => i.config.method === "hnsw");
    expect(hnsw).toBeDefined();
  });

  it("an active methodology prompt is a pointer on the template, never a flag on the immutable row", () => {
    expect(colNames(byName("report_templates"))).toContain("active_methodology_prompt_id");
    expect(colNames(byName("methodology_prompts"))).not.toContain("is_active");
  });

  it("each template version number is unique", () => {
    const uq = byName("methodology_prompts").uniqueConstraints.map((u) => u.columns.map((col) => col.name).join(","));
    expect(uq).toContain("template_id,version_number");
  });
});

describe("row-level security is declared for every tenant table (audit 04 item 1)", () => {
  // No database needed: read the committed migrations. A new table with organization_id
  // that forgets its policy fails here in CI, before it can ship.
  const migrationSql = readdirSync("drizzle")
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(`drizzle/${f}`, "utf8"))
    .join("\n");
  const needsRls = configs.filter((c) => c.name === "organizations" || c.columns.some((col) => col.name === "organization_id"));

  it("covers the whole registry plus organizations", () => {
    expect(needsRls.map((c) => c.name).sort()).toEqual(["organizations", ...TENANT_TABLES.map((t) => getTableName(t))].sort());
  });

  it.each(needsRls.map((c) => [c.name] as const))("%s has RLS enabled and a policy for app_runtime", (name) => {
    expect(migrationSql).toContain(`ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY`);
    expect(migrationSql).toMatch(new RegExp(`CREATE POLICY "tenant_isolation" ON "${name}" AS PERMISSIVE FOR ALL TO app_runtime`));
  });

  const policies = migrationSql.match(/CREATE POLICY[\s\S]*?;\n/g) ?? [];
  const tenantPolicies = policies.filter((p) => p.includes('"tenant_isolation"'));

  it("policies fail closed: they compare against the transaction setting, never a constant", () => {
    expect(tenantPolicies.length).toBe(needsRls.length);
    for (const policy of tenantPolicies) {
      expect(policy).toContain("(SELECT app_current_org())");
      expect(policy).not.toMatch(/USING \(true\)/i);
    }
  });

  it("the only other policies are the two auth_runtime ones on users, and none is for app_runtime", () => {
    const others = policies.filter((p) => !p.includes('"tenant_isolation"'));
    expect(others.map((p) => p.match(/CREATE POLICY "([a-z_]+)" ON "([a-z_]+)"[\s\S]*? TO ([a-z_]+)/)!.slice(1).join(" "))).toEqual([
      "auth_read_identity users auth_runtime",
      "auth_verify_email users auth_runtime",
    ]);
  });
});

describe("auth tables (separate registry, role-separated instead of row-level security)", () => {
  it("are exactly the five Better Auth tables", () => {
    expect(authConfigs.map((c) => c.name).sort()).toEqual(["auth_accounts", "auth_rate_limits", "auth_sessions", "auth_two_factors", "auth_verifications"]);
  });

  it("keep the base conventions (uuid id with default, created_at) but carry no organization_id", () => {
    for (const c of authConfigs) {
      const id = c.columns.find((col) => col.name === "id");
      expect(id?.columnType, c.name).toBe("PgUUID");
      expect(id?.hasDefault, c.name).toBe(true);
      expect(colNames(c), c.name).toContain("created_at");
      expect(colNames(c), c.name).not.toContain("organization_id");
    }
  });

  it("every foreign key has a covering index and cascades from users", () => {
    for (const c of authConfigs) {
      for (const fk of c.foreignKeys) {
        const cols = fk.reference().columns.map((col) => col.name);
        expect(getTableName(fk.reference().foreignTable)).toBe("users");
        expect(fk.onDelete, c.name).toBe("cascade");
        const covered =
          c.indexes.some((i) => i.config.columns.some((col, n) => n === 0 && "name" in col && cols.includes(col.name as string))) ||
          c.uniqueConstraints.some((u) => u.columns[0] !== undefined && cols.includes(u.columns[0].name));
        expect(covered, `${c.name}: FK on (${cols.join(", ")}) has no covering index`).toBe(true);
      }
    }
  });

  it("session and reset-token secrets are unique or indexed for lookup", () => {
    const sessions = authConfigs.find((c) => c.name === "auth_sessions")!;
    expect(sessions.uniqueConstraints.map((u) => u.columns.map((col) => col.name).join(","))).toContain("token");
    const limits = authConfigs.find((c) => c.name === "auth_rate_limits")!;
    expect(limits.uniqueConstraints.map((u) => u.columns.map((col) => col.name).join(","))).toContain("key");
  });

  it("email is globally unique and lowercase on users (one account per address across practices)", () => {
    const users = byName("users");
    expect(users.uniqueConstraints.map((u) => u.columns.map((col) => col.name).join(","))).toContain("email");
    expect(users.checks.map((c) => c.name)).toContain("users_email_lowercase");
    expect(users.indexes.map((i) => i.config.name)).not.toContain("users_org_email_active_uq");
  });

  it("migrations 0006 and 0008 give app_runtime no privilege on any auth table", () => {
    const sql = readFileSync("drizzle/0006_auth_runtime_role_and_grants.sql", "utf8") + "\n" + readFileSync("drizzle/0008_auth_two_factor.sql", "utf8");
    for (const name of AUTH_TABLE_NAMES) {
      const grants = sql.match(/GRANT [^;]*;/g)?.filter((g) => g.includes(name)) ?? [];
      expect(grants.length, name).toBeGreaterThan(0);
      for (const g of grants) expect(g, `${name}: ${g}`).not.toMatch(/\bapp_runtime\b/);
    }
    expect(sql).toMatch(/REVOKE ALL ON auth_accounts, auth_sessions, auth_verifications, auth_rate_limits FROM PUBLIC, app_runtime/);
    expect(sql).toMatch(/REVOKE ALL ON auth_two_factors FROM PUBLIC, app_runtime/);
  });

  it("migration 0008: auth_runtime may flip users.two_factor_enabled, app_runtime may not, and nothing deletes an enrollment", () => {
    const sql = readFileSync("drizzle/0008_auth_two_factor.sql", "utf8");
    expect(sql).toMatch(/GRANT UPDATE \(two_factor_enabled\) ON users TO auth_runtime/);
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE ON auth_two_factors TO auth_runtime/);
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*auth_two_factors/);
    // app_runtime's column grants on users (0006) never list the flag, and 0008 adds none.
    const appGrants = (readFileSync("drizzle/0006_auth_runtime_role_and_grants.sql", "utf8") + sql).match(/GRANT [^;]*TO app_runtime;/g) ?? [];
    for (const g of appGrants) expect(g).not.toMatch(/two_factor_enabled/);
  });

  it("migrations 0006 and 0008 give auth_runtime nothing on tenant or clinical tables", () => {
    const sql = readFileSync("drizzle/0006_auth_runtime_role_and_grants.sql", "utf8") + "\n" + readFileSync("drizzle/0008_auth_two_factor.sql", "utf8");
    const granted = (sql.match(/GRANT [^;]*TO auth_runtime;/g) ?? []).join("\n");
    for (const t of [...TENANT_TABLES.map((x) => getTableName(x)), "organizations"]) {
      if (t === "users") continue;
      expect(granted, t).not.toMatch(new RegExp(`\\b${t}\\b`));
    }
    expect(granted).not.toMatch(/purge_client/);
  });
});
