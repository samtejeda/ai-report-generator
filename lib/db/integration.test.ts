import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, getTableName, sql } from "drizzle-orm";
import { Pool } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";
import { TENANT_TABLES, tenantDb } from "./tenant";

// Integration tests against a scratch Neon branch (D7: the `test` branch of the dev
// project). They need TEST_* variables from .env.test.local (gitignored) and are skipped
// when absent, so CI and fresh clones are unaffected. They NEVER fall back to
// DATABASE_URL. Synthetic data only. Rows in audit_log / methodology_prompts cannot be
// deleted by design, so each run uses fresh random organizations; reset the test branch
// from dev when it gets heavy.
try {
  process.loadEnvFile(".env.test.local");
} catch {}

// These tests talk to Neon over the internet and every tenantDb call is a transaction, so
// the 5 s default makes them flaky on a slow connection. This file only; unit tests keep 5 s.
vi.setConfig({ testTimeout: 30_000 });

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_PASSWORD = process.env.TEST_APP_ROLE_PASSWORD;
const ENABLED = Boolean(OWNER_URL && APP_PASSWORD && /^[a-f0-9]{32,}$/.test(APP_PASSWORD));
const APP_ROLE = "app_runtime_test";

// Postgres SQLSTATE codes
const INSUFFICIENT_PRIVILEGE = "42501";
const RESTRICT_VIOLATION = "23001";
const FK_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const NO_DATA_FOUND = "P0002";
const FEATURE_NOT_SUPPORTED = "0A000";

function pgCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const rec = cur as { code?: unknown; cause?: unknown };
    if (typeof rec.code === "string" && /^[0-9A-Z]{5}$/.test(rec.code)) return rec.code;
    cur = rec.cause;
  }
  return undefined;
}

async function expectPgError(p: PromiseLike<unknown>, code: string) {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, "expected the statement to fail").toBeDefined();
  expect(pgCode(err), String((err as Error)?.message)).toBe(code);
}

function vec(hot: number): number[] {
  return Array.from({ length: 768 }, (_, i) => (i === hot ? 1 : 0));
}

type AppDb = NeonDatabase<typeof schema>;

// Every table the registry says is tenant data, plus organizations (its id is the tenant).
const TENANT_TABLE_NAMES = [...TENANT_TABLES.map((t) => getTableName(t)), "organizations"];
const INVALID_TEXT_REPRESENTATION = "22P02";

describe.skipIf(!ENABLED)("database integration (Neon test branch)", () => {
  let ownerPool: Pool;
  let appPool: Pool;
  let appConnectionString = "";
  let owner: NeonDatabase<typeof schema>; // table owner: fixtures + trigger checks
  let app: NeonDatabase<typeof schema>; // app_runtime member: what production uses

  // Raw SQL as the app role, inside a transaction bound to one tenant exactly as tenantDb
  // does it. Used where a test needs to send statements tenantDb deliberately cannot.
  const asOrg = <R>(orgId: string, fn: (tx: AppDb) => Promise<R>): Promise<R> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.organization_id', ${orgId}, true)`);
      return fn(tx as unknown as AppDb);
    });

  type Fx = {
    orgId: string;
    userId: string;
    templateId: string;
    template2Id: string;
    promptId: string;
    prompt2Id: string;
    clientId: string;
    client2Id: string;
    reportId: string;
    sectionId: string;
    versionId: string;
  };

  async function seedClientSubtree(orgId: string, userId: string, templateId: string, promptId: string, label: string) {
    // One transaction for the whole subtree: each tenantDb call on its own is a transaction
    // with a tenant-binding round trip, which makes large fixtures slow.
    return tenantDb({ organizationId: orgId }, owner).transaction(async (t) => {
      const [client] = await t.insert(schema.clients, { displayName: `Synthetic ${label}` });
      const [report] = await t.insert(schema.reports, {
        clientId: client.id,
        templateId,
        methodologyPromptId: promptId,
        createdByUserId: userId,
      });
      const [section] = await t.insert(schema.reportSections, {
        reportId: report.id,
        sectionKey: "summary",
        sectionType: "prose",
        position: 1,
      });
      await t.insert(schema.reportVersions, [
        { reportId: report.id, sectionId: section.id, versionNumber: 1, editType: "ai_generated", content: { text: "synthetic" } },
        { reportId: report.id, sectionId: section.id, versionNumber: 2, editType: "human_edit", content: { text: "synthetic edit" }, createdByUserId: userId },
      ]);
      await t.insert(schema.clientHistory, { clientId: client.id, entryType: "note", occurredOn: "2026-01-01", summary: "synthetic", createdByUserId: userId });
      await t.insert(schema.clientAssignments, { clientId: client.id, userId, assignedByUserId: userId });
      const [doc] = await t.insert(schema.ragDocuments, { clientId: client.id, sourceType: "client_note", title: "synthetic note" });
      const [chunk] = await t.insert(schema.ragChunks, { documentId: doc.id, chunkIndex: 0, content: "synthetic chunk" });
      await t.insert(schema.ragEmbeddings, { chunkId: chunk.id, model: "test-model", embedding: vec(1) });
      await t.insert(schema.jobs, { type: "synthetic", resourceType: "report", resourceId: report.id });
      await t.insert(schema.auditLog, { action: "client.read", resourceType: "client", resourceId: client.id });
      return { clientId: client.id, reportId: report.id, sectionId: section.id, docId: doc.id, chunkId: chunk.id };
    });
  }

  async function seedOrg(label: string): Promise<Fx> {
    const [org] = await owner.insert(schema.organizations).values({ name: `Synthetic Org ${label}` }).returning();
    const t = tenantDb({ organizationId: org.id }, owner);
    const [user] = await t.insert(schema.users, { email: `${label.toLowerCase()}-${org.id}@example.test`, displayName: `Synthetic User ${label}`, role: "owner" });
    const [tpl] = await t.insert(schema.reportTemplates, { slug: "psychoed", name: "Synthetic template", structure: { sections: [] } });
    const [tpl2] = await t.insert(schema.reportTemplates, { slug: "other", name: "Synthetic template 2", structure: { sections: [] } });
    const [p1] = await t.insert(schema.methodologyPrompts, { templateId: tpl.id, versionNumber: 1, content: { note: "synthetic placeholder" }, notes: "synthetic v1", createdByUserId: user.id });
    const [p2] = await t.insert(schema.methodologyPrompts, { templateId: tpl2.id, versionNumber: 1, content: { note: "synthetic placeholder" }, notes: "synthetic other", createdByUserId: user.id });
    await t.update(schema.reportTemplates, tpl.id, { activeMethodologyPromptId: p1.id });
    const sub = await seedClientSubtree(org.id, user.id, tpl.id, p1.id, `${label}-1`);
    const [client2] = await t.insert(schema.clients, { displayName: `Synthetic ${label}-2` });
    const [version] = await owner.select().from(schema.reportVersions).where(eq(schema.reportVersions.reportId, sub.reportId)).limit(1);
    return {
      orgId: org.id, userId: user.id, templateId: tpl.id, template2Id: tpl2.id, promptId: p1.id, prompt2Id: p2.id,
      clientId: sub.clientId, client2Id: client2.id, reportId: sub.reportId, sectionId: sub.sectionId, versionId: version.id,
    };
  }

  let A: Fx;
  let B: Fx;
  let tA: ReturnType<typeof tenantDb>;
  let tB: ReturnType<typeof tenantDb>;

  beforeAll(async () => {
    ownerPool = new Pool({ connectionString: OWNER_URL });
    owner = drizzle(ownerPool, { schema });

    // Login role = member of app_runtime, created with SQL (not the Neon console), so it
    // inherits only the migration's grants. Password comes from the gitignored env file.
    const exists = await owner.execute(sql`select 1 from pg_roles where rolname = ${APP_ROLE}`);
    const stmt = exists.rows.length ? "ALTER ROLE" : "CREATE ROLE";
    const tail = exists.rows.length ? "" : " IN ROLE app_runtime";
    await owner.execute(sql.raw(`${stmt} ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'${tail}`));

    const appUrl = new URL(OWNER_URL!);
    appUrl.username = APP_ROLE;
    appUrl.password = APP_PASSWORD!;
    appConnectionString = appUrl.toString();
    appPool = new Pool({ connectionString: appConnectionString });
    app = drizzle(appPool, { schema });

    A = await seedOrg("A");
    B = await seedOrg("B");
    tA = tenantDb({ organizationId: A.orgId }, app);
    tB = tenantDb({ organizationId: B.orgId }, app);
  }, 180_000);

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
  });

  describe("role lockdown", () => {
    it("the login role is a plain app_runtime member: not superuser, no bypass, no broad data roles", async () => {
      const r = await app.execute(sql`
        select r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
               pg_has_role(current_user, 'app_runtime', 'member') as is_app_runtime,
               pg_has_role(current_user, 'neon_superuser', 'member') as is_neon_superuser,
               pg_has_role(current_user, 'pg_write_all_data', 'member') as can_write_all,
               pg_has_role(current_user, 'pg_read_all_data', 'member') as can_read_all
        from pg_roles r where r.rolname = current_user`);
      expect(r.rows[0]).toMatchObject({
        rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false,
        is_app_runtime: true, is_neon_superuser: false, can_write_all: false, can_read_all: false,
      });
    });

    it("cannot create organizations, delete clinical rows, or truncate", async () => {
      await expectPgError(app.execute(sql`insert into organizations (name) values ('x')`), INSUFFICIENT_PRIVILEGE);
      await expectPgError(app.execute(sql`delete from clients where id = ${A.clientId}`), INSUFFICIENT_PRIVILEGE);
      await expectPgError(app.execute(sql`delete from reports where id = ${A.reportId}`), INSUFFICIENT_PRIVILEGE);
      await expectPgError(app.execute(sql`truncate clients cascade`), INSUFFICIENT_PRIVILEGE);
    });
  });

  describe("cross-tenant isolation (audit 04 item 1)", () => {
    it("org A cannot read org B rows, by list or by id", async () => {
      const mine = await tA.find(schema.clients, { limit: 50 });
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((c) => c.organizationId === A.orgId)).toBe(true);
      expect(await tA.get(schema.clients, B.clientId)).toBeUndefined();
      expect(await tA.get(schema.reports, B.reportId)).toBeUndefined();
      expect(await tA.get(schema.methodologyPrompts, B.promptId)).toBeUndefined();
      expect(await tA.find(schema.auditLog, { limit: 50 })).toSatisfy((rows: { organizationId: string }[]) =>
        rows.every((r) => r.organizationId === A.orgId),
      );
    });

    it("org A cannot update or soft-delete org B rows (0 rows, B unchanged)", async () => {
      expect(await tA.update(schema.clients, B.clientId, { displayName: "HIJACKED" })).toHaveLength(0);
      expect(await tA.softDelete(schema.clients, B.clientId)).toHaveLength(0);
      const [row] = await owner.select().from(schema.clients).where(eq(schema.clients.id, B.clientId));
      expect(row.displayName).not.toBe("HIJACKED");
      expect(row.deletedAt).toBeNull();
    });

    it("org A cannot write a row that points at org B's parent (composite FK)", async () => {
      await expectPgError(
        tA.insert(schema.reports, { clientId: B.clientId, templateId: A.templateId, methodologyPromptId: A.promptId, createdByUserId: A.userId }),
        FK_VIOLATION,
      );
      await expectPgError(
        tA.insert(schema.reportVersions, { reportId: A.reportId, sectionId: B.sectionId, versionNumber: 99, editType: "ai_generated", content: {} }),
        FK_VIOLATION,
      );
      await expectPgError(
        tA.insert(schema.reports, { clientId: A.clientId, templateId: B.templateId, methodologyPromptId: B.promptId, createdByUserId: A.userId }),
        FK_VIOLATION,
      );
    });

    it("organization_id cannot be changed on an existing row, even with raw SQL", async () => {
      await expectPgError(
        asOrg(A.orgId, (tx) => tx.execute(sql`update clients set organization_id = ${B.orgId} where id = ${A.clientId}`)),
        RESTRICT_VIOLATION,
      );
      await expectPgError(owner.execute(sql`update clients set organization_id = ${B.orgId} where id = ${A.clientId}`), RESTRICT_VIOLATION);
    });
  });

  describe("row-level security (audit 04 item 1; migration 0004)", () => {
    const rowCount = async (table: string, where = "") =>
      Number((await owner.execute(sql.raw(`select count(*)::int as n from "${table}" ${where}`))).rows[0].n);

    it("the database and the registry agree: every table with organization_id has RLS on and a policy for app_runtime", async () => {
      const r = await owner.execute(sql`
        select c.relname::text as name, c.relrowsecurity as rls,
               exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and 'app_runtime' = any (p.roles)) as has_policy
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and (c.relname = 'organizations'
               or exists (select 1 from information_schema.columns col
                          where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'organization_id'))`);
      const rows = r.rows as { name: string; rls: boolean; has_policy: boolean }[];
      expect(rows.map((x) => x.name).sort()).toEqual([...TENANT_TABLE_NAMES].sort());
      for (const row of rows) {
        expect(row.rls, `${row.name}: RLS enabled`).toBe(true);
        expect(row.has_policy, `${row.name}: policy for app_runtime`).toBe(true);
      }
    });

    it.each(TENANT_TABLE_NAMES)("%s: raw SQL with no filter shows A only A's rows, B only B's, and no tenant nothing", async (name) => {
      const count = (where = "") => sql.raw(`select count(*)::int as n from "${name}" ${where}`);
      const asA = (where?: string) => asOrg(A.orgId, (tx) => tx.execute(count(where))).then((r) => Number(r.rows[0].n));
      const asB = (where?: string) => asOrg(B.orgId, (tx) => tx.execute(count(where))).then((r) => Number(r.rows[0].n));
      const other = (id: string) => (name === "organizations" ? `where id <> '${id}'` : `where organization_id <> '${id}'`);

      expect(await asA(), `${name}: A sees its own rows`).toBeGreaterThan(0);
      expect(await asA(other(A.orgId)), `${name}: A sees none of B's`).toBe(0);
      expect(await asB(), `${name}: B sees its own rows`).toBeGreaterThan(0);
      expect(await asB(other(B.orgId)), `${name}: B sees none of A's`).toBe(0);
      // No tenant bound: fails closed even though the role has SELECT.
      expect(Number((await app.execute(count())).rows[0].n), `${name}: nothing without a tenant`).toBe(0);
    });

    it.each(TENANT_TABLE_NAMES)("%s: org A cannot update or delete org B's rows, even with raw SQL", async (name) => {
      const priv = await owner.execute(
        sql`select has_table_privilege(${APP_ROLE}, ${name}, 'UPDATE') as u, has_table_privilege(${APP_ROLE}, ${name}, 'DELETE') as d`,
      );
      const { u, d } = priv.rows[0] as { u: boolean; d: boolean };
      const key = name === "organizations" ? "id" : "organization_id";
      const before = await rowCount(name, `where ${key} = '${B.orgId}'`);
      expect(before, `${name}: org B has fixture rows`).toBeGreaterThan(0);

      if (u) {
        const r = await asOrg(A.orgId, (tx) => tx.execute(sql.raw(`update "${name}" set ${key} = ${key} where ${key} = '${B.orgId}'`)));
        expect(r.rowCount, `${name}: update touched B rows`).toBe(0);
      }
      if (d) {
        const r = await asOrg(A.orgId, (tx) => tx.execute(sql.raw(`delete from "${name}" where ${key} = '${B.orgId}'`)));
        expect(r.rowCount, `${name}: delete touched B rows`).toBe(0);
      }
      expect(await rowCount(name, `where ${key} = '${B.orgId}'`), `${name}: B's rows unchanged`).toBe(before);
    });

    it("org A cannot insert rows for org B, even with raw SQL; the same statement for A works", async () => {
      await expectPgError(
        asOrg(A.orgId, (tx) => tx.execute(sql`insert into clients (organization_id, display_name) values (${B.orgId}, 'cross-tenant')`)),
        INSUFFICIENT_PRIVILEGE,
      );
      await expectPgError(
        asOrg(A.orgId, (tx) => tx.execute(sql`insert into audit_log (organization_id, action, resource_type) values (${B.orgId}, 'forged', 'client')`)),
        INSUFFICIENT_PRIVILEGE,
      );
      const ok = await asOrg(A.orgId, (tx) => tx.execute(sql`insert into clients (organization_id, display_name) values (${A.orgId}, 'own tenant control') returning id`));
      expect(ok.rows).toHaveLength(1);
    });

    it("organizations: a tenant sees only its own row and cannot rename another", async () => {
      const seen = await asOrg(A.orgId, (tx) => tx.execute(sql`select id from organizations`));
      expect(seen.rows.map((r) => r.id)).toEqual([A.orgId]);
      const r = await asOrg(A.orgId, (tx) => tx.execute(sql`update organizations set name = 'HIJACKED' where id = ${B.orgId}`));
      expect(r.rowCount).toBe(0);
      expect((await tB.organization())?.name).not.toBe("HIJACKED");
      expect((await tA.organization())?.id).toBe(A.orgId);
    });

    it("a setting that is not a UUID makes the query error instead of matching anything", async () => {
      await expectPgError(asOrg("not-a-uuid", (tx) => tx.execute(sql`select count(*) from clients`)), INVALID_TEXT_REPRESENTATION);
    });

    it("a pooled connection reused by the next request carries no tenant (commit and rollback)", async () => {
      const solo = new Pool({ connectionString: appConnectionString, max: 1 }); // forces the same connection
      try {
        const db = drizzle(solo, { schema });
        const bound = await db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.organization_id', ${A.orgId}, true)`);
          return Number((await tx.execute(sql`select count(*)::int as n from clients`)).rows[0].n);
        });
        expect(bound).toBeGreaterThan(0);
        expect(Number((await db.execute(sql`select count(*)::int as n from clients`)).rows[0].n)).toBe(0);

        await expectPgError(
          db.transaction(async (tx) => {
            await tx.execute(sql`select set_config('app.organization_id', ${A.orgId}, true)`);
            await tx.execute(sql`select 1/0`);
          }),
          "22012",
        );
        expect(Number((await db.execute(sql`select count(*)::int as n from clients`)).rows[0].n)).toBe(0);
        const leftover = await db.execute(sql`select current_setting('app.organization_id', true) as v`);
        expect([null, ""]).toContain(leftover.rows[0].v);
      } finally {
        await solo.end();
      }
    });

    it("concurrent requests for different tenants never see each other's rows", async () => {
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) => {
          const orgId = i % 2 ? A.orgId : B.orgId;
          return (i % 2 ? tA : tB).find(schema.clients, { limit: 50 }).then((rows) => ({ orgId, rows }));
        }),
      );
      for (const { orgId, rows } of results) {
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((c) => c.organizationId === orgId)).toBe(true);
      }
    });

    it("purge_client refuses an organization other than the session tenant (it bypasses RLS, so it checks itself)", async () => {
      await expectPgError(
        asOrg(A.orgId, (tx) => tx.execute(sql`select purge_client(${B.orgId}::uuid, ${B.clientId}::uuid)`)),
        INSUFFICIENT_PRIVILEGE,
      );
      await expectPgError(app.execute(sql`select purge_client(${B.orgId}::uuid, ${B.clientId}::uuid)`), INSUFFICIENT_PRIVILEGE);
      expect(await rowCount("clients", `where id = '${B.clientId}'`)).toBe(1);
    });
  });

  describe("immutability and append-only (audit 05 item 7, audit 04 item 9)", () => {
    it("report_versions: UPDATE and DELETE fail for the app (privileges) and for the owner (triggers)", async () => {
      await expectPgError(app.execute(sql`update report_versions set content = '{}'::jsonb where id = ${A.versionId}`), INSUFFICIENT_PRIVILEGE);
      await expectPgError(app.execute(sql`delete from report_versions where id = ${A.versionId}`), INSUFFICIENT_PRIVILEGE);
      await expectPgError(owner.execute(sql`update report_versions set content = '{}'::jsonb where id = ${A.versionId}`), RESTRICT_VIOLATION);
      await expectPgError(owner.execute(sql`delete from report_versions where id = ${A.versionId}`), RESTRICT_VIOLATION);
      await expectPgError(owner.execute(sql`truncate report_versions`), RESTRICT_VIOLATION);
    });

    it("methodology_prompts: UPDATE, DELETE, TRUNCATE all fail", async () => {
      await expectPgError(app.execute(sql`update methodology_prompts set notes = 'x' where id = ${A.promptId}`), INSUFFICIENT_PRIVILEGE);
      await expectPgError(owner.execute(sql`update methodology_prompts set notes = 'x' where id = ${A.promptId}`), RESTRICT_VIOLATION);
      await expectPgError(app.execute(sql`delete from methodology_prompts where id = ${A.promptId}`), INSUFFICIENT_PRIVILEGE);
      await expectPgError(owner.execute(sql`delete from methodology_prompts where id = ${A.promptId}`), RESTRICT_VIOLATION);
      // Postgres itself refuses a plain TRUNCATE of a table that FKs reference...
      await expectPgError(owner.execute(sql`truncate methodology_prompts`), FEATURE_NOT_SUPPORTED);
      // ...and CASCADE reaches report_versions, whose truncate trigger aborts the whole statement.
      await expectPgError(owner.execute(sql`truncate methodology_prompts cascade`), RESTRICT_VIOLATION);
      await expectPgError(owner.execute(sql`truncate clients cascade`), RESTRICT_VIOLATION);
    });

    it("audit_log: the app can append and read, but never update, delete, or truncate", async () => {
      const [row] = await tA.insert(schema.auditLog, { action: "client.read", resourceType: "client", resourceId: A.clientId, metadata: { via: "integration-test" } });
      expect(row.organizationId).toBe(A.orgId);
      await expectPgError(app.execute(sql`update audit_log set action = 'x' where id = ${row.id}`), INSUFFICIENT_PRIVILEGE);
      await expectPgError(app.execute(sql`delete from audit_log where id = ${row.id}`), INSUFFICIENT_PRIVILEGE);
      await expectPgError(owner.execute(sql`update audit_log set action = 'x' where id = ${row.id}`), RESTRICT_VIOLATION);
      await expectPgError(owner.execute(sql`delete from audit_log where id = ${row.id}`), RESTRICT_VIOLATION);
      await expectPgError(owner.execute(sql`truncate audit_log`), RESTRICT_VIOLATION);
    });

    it("the app can insert report versions, and a duplicate version number is rejected", async () => {
      const [v3] = await tA.insert(schema.reportVersions, { reportId: A.reportId, sectionId: A.sectionId, versionNumber: 3, editType: "ai_regenerated_section", content: { text: "synthetic v3" } });
      expect(v3.versionNumber).toBe(3);
      await expectPgError(
        tA.insert(schema.reportVersions, { reportId: A.reportId, sectionId: A.sectionId, versionNumber: 3, editType: "ai_generated", content: {} }),
        UNIQUE_VIOLATION,
      );
    });

    it("a FK cascade cannot bypass the trigger: deleting a client with versions outside purge fails", async () => {
      await expectPgError(owner.execute(sql`delete from clients where id = ${A.clientId}`), RESTRICT_VIOLATION);
      expect(await tA.get(schema.clients, A.clientId)).toBeDefined();
    });

    it("manually setting the purge flag does not let the app delete versions", async () => {
      await expectPgError(
        app.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.purge', 'on', true)`);
          await tx.execute(sql`delete from report_versions where id = ${A.versionId}`);
        }),
        INSUFFICIENT_PRIVILEGE,
      );
    });
  });

  describe("unique constraints and checks (audit 05 item 3)", () => {
    it("a second prompt with the same version number for a template is rejected", async () => {
      await expectPgError(
        tA.insert(schema.methodologyPrompts, { templateId: A.templateId, versionNumber: 1, content: {}, notes: "dup", createdByUserId: A.userId }),
        UNIQUE_VIOLATION,
      );
    });

    it("exactly one active prompt per template: a pointer that can only name this template's own prompt", async () => {
      // Pointing at another template's prompt is rejected by the composite FK.
      await expectPgError(tA.update(schema.reportTemplates, A.templateId, { activeMethodologyPromptId: A.prompt2Id }), FK_VIOLATION);
      // Pointing at another org's prompt is rejected too.
      await expectPgError(tA.update(schema.reportTemplates, A.templateId, { activeMethodologyPromptId: B.promptId }), FK_VIOLATION);
      // Activating a new version is moving the pointer; the prompt rows are untouched.
      const [p2] = await tA.insert(schema.methodologyPrompts, { templateId: A.templateId, versionNumber: 2, content: { note: "synthetic placeholder" }, notes: "synthetic v2", createdByUserId: A.userId });
      const [tpl] = await tA.update(schema.reportTemplates, A.templateId, { activeMethodologyPromptId: p2.id });
      expect(tpl.activeMethodologyPromptId).toBe(p2.id);
      const [old] = await owner.select().from(schema.methodologyPrompts).where(eq(schema.methodologyPrompts.id, A.promptId));
      expect(old.notes).toBe("synthetic v1");
    });

    it("a report can only use a prompt that belongs to its template", async () => {
      await expectPgError(
        tA.insert(schema.reports, { clientId: A.clientId, templateId: A.templateId, methodologyPromptId: A.prompt2Id, createdByUserId: A.userId }),
        FK_VIOLATION,
      );
    });

    it("duplicate active template slug and external id are rejected; soft-deleted ones are not", async () => {
      await expectPgError(tA.insert(schema.reportTemplates, { slug: "psychoed", name: "dup", structure: {} }), UNIQUE_VIOLATION);
      await tA.insert(schema.clients, { displayName: "ext-1", externalId: "EXT-1" });
      await expectPgError(tA.insert(schema.clients, { displayName: "ext-1 dup", externalId: "EXT-1" }), UNIQUE_VIOLATION);
      // Same external id in another tenant is fine.
      await tB.insert(schema.clients, { displayName: "ext-1 in B", externalId: "EXT-1" });
    });

    it("check constraints: human edits need an author; finalized needs finalized_at", async () => {
      await expectPgError(
        tA.insert(schema.reportVersions, { reportId: A.reportId, sectionId: A.sectionId, versionNumber: 50, editType: "human_edit", content: {} }),
        CHECK_VIOLATION,
      );
      await expectPgError(tA.update(schema.reports, A.reportId, { status: "finalized" }), CHECK_VIOLATION);
      await expectPgError(
        tA.insert(schema.ragDocuments, { sourceType: "client_note", title: "orphaned client content" }),
        CHECK_VIOLATION,
      );
    });
  });

  describe("triggers and vectors", () => {
    it("updated_at moves on update", async () => {
      const [before] = await tA.insert(schema.clients, { displayName: "tick" });
      await new Promise((r) => setTimeout(r, 25));
      const [after] = await tA.update(schema.clients, before.id, { gradeLevel: "3" });
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
      expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
    });

    it("pgvector: similarity search is tenant-filtered and the HNSW cosine index exists", async () => {
      const idx = await owner.execute(sql`select indexdef from pg_indexes where indexname = 'rag_embeddings_embedding_hnsw_idx'`);
      expect(String(idx.rows[0]?.indexdef)).toMatch(/hnsw.*vector_cosine_ops/);
      // Org B holds an identical vector for its own chunk; a search scoped to A must only see A's.
      const q = `[${vec(1).join(",")}]`;
      const hitsA = await asOrg(A.orgId, (tx) =>
        tx.execute(sql`select organization_id from rag_embeddings where organization_id = ${A.orgId} order by embedding <=> ${q}::vector limit 5`),
      );
      expect(hitsA.rows.length).toBeGreaterThan(0);
      expect(hitsA.rows.every((r) => r.organization_id === A.orgId)).toBe(true);
    });
  });

  describe("client assignments (feat/auth-authz; migration 0009)", () => {
    it("the app can assign and end an assignment, but never delete one or re-point it", async () => {
      const [row] = await tA.insert(schema.clientAssignments, { clientId: A.client2Id, userId: A.userId, assignedByUserId: A.userId });
      expect(row.organizationId).toBe(A.orgId);
      await expectPgError(app.execute(sql`delete from client_assignments where id = ${row.id}`), INSUFFICIENT_PRIVILEGE);
      await expectPgError(asOrg(A.orgId, (tx) => tx.execute(sql`update client_assignments set client_id = ${A.clientId} where id = ${row.id}`)), INSUFFICIENT_PRIVILEGE);
      await expectPgError(asOrg(A.orgId, (tx) => tx.execute(sql`update client_assignments set user_id = ${A.userId} where id = ${row.id}`)), INSUFFICIENT_PRIVILEGE);
      const ended = await tA.softDelete(schema.clientAssignments, row.id);
      expect(ended).toHaveLength(1);
      expect(ended[0].deletedAt).not.toBeNull();
    });

    it("one active assignment per client and user; an ended one can be granted again", async () => {
      const [first] = await tA.insert(schema.clientAssignments, { clientId: A.client2Id, userId: A.userId, assignedByUserId: A.userId });
      await expectPgError(tA.insert(schema.clientAssignments, { clientId: A.client2Id, userId: A.userId, assignedByUserId: A.userId }), UNIQUE_VIOLATION);
      await tA.softDelete(schema.clientAssignments, first.id);
      const [again] = await tA.insert(schema.clientAssignments, { clientId: A.client2Id, userId: A.userId, assignedByUserId: A.userId });
      expect(again.id).not.toBe(first.id);
      await tA.softDelete(schema.clientAssignments, again.id);
    });

    it("an assignment cannot cross organizations (composite FKs), and org B cannot see or end org A's", async () => {
      await expectPgError(tA.insert(schema.clientAssignments, { clientId: B.clientId, userId: A.userId, assignedByUserId: A.userId }), FK_VIOLATION);
      await expectPgError(tA.insert(schema.clientAssignments, { clientId: A.client2Id, userId: B.userId, assignedByUserId: A.userId }), FK_VIOLATION);
      await expectPgError(tA.insert(schema.clientAssignments, { clientId: A.client2Id, userId: A.userId, assignedByUserId: B.userId }), FK_VIOLATION);
      const mine = await tA.find(schema.clientAssignments, { limit: 50 });
      expect(mine.length).toBeGreaterThan(0);
      const theirs = await tB.find(schema.clientAssignments, { limit: 50 });
      expect(theirs.every((r) => r.organizationId === B.orgId)).toBe(true);
      expect(await tB.softDelete(schema.clientAssignments, mine[0].id)).toHaveLength(0);
    });
  });

  describe("hard deletion (purge_client)", () => {
    it("removes the client and every derived row, leaves other clients, other tenants, and the audit trail", async () => {
      const own = tenantDb({ organizationId: A.orgId }, owner);
      const victim = await seedClientSubtree(A.orgId, A.userId, A.templateId, A.promptId, "purge-victim");
      // Another client's history entry links to the victim's report: purge must not be blocked by it.
      await own.insert(schema.clientHistory, { clientId: A.client2Id, entryType: "note", occurredOn: "2026-02-02", reportId: victim.reportId, createdByUserId: A.userId });

      const count = async (table: string, where: string, id: string) =>
        Number((await owner.execute(sql.raw(`select count(*)::int as n from ${table} where ${where} = '${id}'`))).rows[0].n);

      const result = await tA.purgeClient(victim.clientId);
      expect(result).toEqual({
        clients: 1, client_history: 1, reports: 1, report_sections: 1, report_versions: 2,
        rag_documents: 1, rag_chunks: 1, rag_embeddings: 1, jobs: 1,
      });

      expect(await count("clients", "id", victim.clientId)).toBe(0);
      expect(await count("reports", "client_id", victim.clientId)).toBe(0);
      expect(await count("report_sections", "report_id", victim.reportId)).toBe(0);
      expect(await count("report_versions", "report_id", victim.reportId)).toBe(0);
      expect(await count("client_history", "client_id", victim.clientId)).toBe(0);
      expect(await count("client_assignments", "client_id", victim.clientId)).toBe(0);
      expect(await count("rag_documents", "client_id", victim.clientId)).toBe(0);
      expect(await count("rag_chunks", "document_id", victim.docId)).toBe(0);
      expect(await count("rag_embeddings", "chunk_id", victim.chunkId)).toBe(0);
      expect(await count("jobs", "resource_id", victim.reportId)).toBe(0);

      // Untouched: the same org's other client, org B's data, and the audit trail.
      expect(await count("clients", "id", A.clientId)).toBe(1);
      expect(await count("report_versions", "report_id", A.reportId)).toBeGreaterThan(0);
      expect(await count("clients", "id", B.clientId)).toBe(1);
      expect(await count("audit_log", "resource_id", victim.clientId)).toBe(1);
      // The cross-client link was cleared rather than blocking the purge.
      const linked = await owner.execute(sql`select report_id from client_history where client_id = ${A.client2Id} and summary is null and occurred_on = '2026-02-02'`);
      expect(linked.rows[0].report_id).toBeNull();
    });

    it("org B cannot purge org A's client", async () => {
      await expectPgError(tB.purgeClient(A.client2Id), NO_DATA_FOUND);
      expect(await tA.get(schema.clients, A.client2Id)).toBeDefined();
    });

    it("purging an unknown client fails cleanly and non-UUID input never reaches SQL", async () => {
      await expectPgError(tA.purgeClient("00000000-0000-4000-8000-000000000000"), NO_DATA_FOUND);
      await expect(tA.purgeClient("1; drop table clients")).rejects.toThrow(/UUID/);
    });
  });
});
