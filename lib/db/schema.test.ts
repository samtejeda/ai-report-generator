import { describe, expect, it } from "vitest";
import { getTableName, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { INSERT_ONLY_TABLES, TENANT_TABLES, UPDATABLE_TABLES } from "./tenant";

// No database needed: these inspect the Drizzle schema definition.
const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));
const configs = tables.map((t) => getTableConfig(t));
const byName = (name: string) => configs.find((c) => c.name === name)!;
const colNames = (c: ReturnType<typeof getTableConfig>) => c.columns.map((col) => col.name);

// Documented exception: audit_log keeps no FKs so purges can never be blocked by it.
const NO_ORG_FK = new Set(["audit_log"]);

describe("schema conventions", () => {
  it("covers every CLAUDE.md table", () => {
    expect(configs.map((c) => c.name).sort()).toEqual(
      [
        "audit_log",
        "client_history",
        "clients",
        "jobs",
        "methodology_prompts",
        "organizations",
        "rag_chunks",
        "rag_documents",
        "rag_embeddings",
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
  it("TENANT_TABLES plus organizations is exactly the set of tables", () => {
    const registry = TENANT_TABLES.map((t) => getTableName(t));
    expect(new Set(registry).size).toBe(registry.length);
    expect([...registry, "organizations"].sort()).toEqual(configs.map((c) => c.name).sort());
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
