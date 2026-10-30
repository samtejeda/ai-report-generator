import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { MAX_SECTION_TEXT } from "@/lib/reports/content";
import { PLACEHOLDER_CONTENT, seedReportTemplate, TEMPLATE_SLUG, TEMPLATE_STRUCTURE } from "@/scripts/seed-report-template.mjs";
import { BASE, ENABLED, startHarness, type Handler, type Person } from "./integration-harness";

// The report shell (feat/report-shell) end to end: the REAL route modules, the REAL Better Auth
// sessions, the REAL app_runtime / auth_runtime roles with row-level security and the migration
// 0013 triggers, on the scratch database. Nothing is mocked. Synthetic data only.
//
// Needs the TEST_* variables (see lib/auth/integration-harness.ts); skipped when absent.
vi.setConfig({ testTimeout: 120_000 });

describe.skipIf(!ENABLED)("report shell through the real stack", () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let collection: { GET: Handler; POST: Handler };
  let detail: { GET: Handler };
  let finalize: { POST: Handler };
  let section: { PUT: Handler };
  let versions: { GET: Handler };

  let orgA: string;
  let orgB: string;
  let ownerA: Person, assocA: Person, assocA2: Person, adminA: Person;
  let ownerB: Person, assocB: Person;
  let c1: { id: string }; // assigned to assocA and granted to adminA
  let c2: { id: string }; // assigned to assocA2 only
  let tplA: { templateId: string; promptId: string };
  let tplB: { templateId: string; promptId: string };

  const tag = () => crypto.randomUUID().slice(0, 8);
  const SECRET = "ZedSectionText";

  const create = (who: Person, body: unknown, o: { origin?: string | null; rawBody?: string } = {}) => h.call(who, collection.POST, { method: "POST", path: "/api/reports", body, ...o });
  const list = (who: Person, qs = "") => h.call(who, collection.GET, { path: `/api/reports${qs}` });
  const get = (who: Person, id: string) => h.call(who, detail.GET, { path: `/api/reports/${id}`, params: { id } });
  const save = (who: Person, reportId: string, sectionId: string, body: unknown, o: { origin?: string | null; rawBody?: string } = {}) =>
    h.call(who, section.PUT, { method: "PUT", path: `/api/reports/${reportId}/sections/${sectionId}`, body, params: { id: reportId, sectionId }, ...o });
  const history = (who: Person, reportId: string, sectionId: string, qs = "") =>
    h.call(who, versions.GET, { path: `/api/reports/${reportId}/sections/${sectionId}/versions${qs}`, params: { id: reportId, sectionId } });
  const fin = (who: Person, id: string, o: { origin?: string | null } = {}) => h.call(who, finalize.POST, { method: "POST", path: `/api/reports/${id}/finalize`, params: { id }, ...o });

  const seedClient = async (orgId: string, displayName: string, extra: Partial<typeof schema.clients.$inferInsert> = {}) =>
    (await h.owner.insert(schema.clients).values({ organizationId: orgId, displayName, ...extra }).returning())[0];
  const assign = (clientId: string, user: Person, by: Person) =>
    h.owner.insert(schema.clientAssignments).values({ organizationId: user.orgId, clientId, userId: user.userId, assignedByUserId: by.userId });

  /** A report with its six sections, inserted directly so any starting status can be set. */
  async function mkReport(orgId: string, clientId: string, creator: Person, status: typeof schema.reports.$inferSelect.status = "draft", tpl = orgId === orgA ? tplA : tplB) {
    const [r] = await h.owner
      .insert(schema.reports)
      .values({ organizationId: orgId, clientId, templateId: tpl.templateId, methodologyPromptId: tpl.promptId, createdByUserId: creator.userId, status, finalizedAt: status === "finalized" ? new Date() : null })
      .returning();
    const sections = await h.owner
      .insert(schema.reportSections)
      .values(TEMPLATE_STRUCTURE.sections.map((s, i) => ({ organizationId: orgId, reportId: r.id, sectionKey: s.key, sectionType: "prose" as const, position: i + 1 })))
      .returning();
    return { reportId: r.id, sections: sections.sort((a, b) => a.position - b.position) };
  }
  const versionRows = (sectionId: string) => h.owner.select().from(schema.reportVersions).where(eq(schema.reportVersions.sectionId, sectionId)).orderBy(asc(schema.reportVersions.versionNumber));
  const reportRow = async (id: string) => (await h.owner.select().from(schema.reports).where(eq(schema.reports.id, id)))[0];
  const auditRows = (orgId: string, action: string) => h.owner.select().from(schema.auditLog).where(and(eq(schema.auditLog.organizationId, orgId), eq(schema.auditLog.action, action)));

  const REPORT_KEYS = ["clientId", "createdAt", "finalizedAt", "id", "status", "updatedAt"];
  const SECTION_KEYS = ["authorName", "editType", "editedAt", "id", "key", "position", "text", "title", "type", "version"];
  const VERSION_KEYS = ["authorName", "createdAt", "editType", "id", "text", "version"];

  beforeAll(async () => {
    h = await startHarness({ appRole: "app_runtime_reports", authRole: "auth_runtime_reports", secret: "reports-test-secret-".padEnd(48, "x") });
    collection = (await import("@/app/api/reports/route")) as unknown as typeof collection;
    detail = (await import("@/app/api/reports/[id]/route")) as unknown as typeof detail;
    finalize = (await import("@/app/api/reports/[id]/finalize/route")) as unknown as typeof finalize;
    section = (await import("@/app/api/reports/[id]/sections/[sectionId]/route")) as unknown as typeof section;
    versions = (await import("@/app/api/reports/[id]/sections/[sectionId]/versions/route")) as unknown as typeof versions;

    const nameA = `reports-A-${tag()}`;
    const nameB = `reports-B-${tag()}`;
    orgA = await h.seedOrg(nameA);
    orgB = await h.seedOrg(nameB);
    [ownerA, assocA, assocA2, adminA, ownerB, assocB] = await Promise.all([
      h.makePerson(orgA, "owner-a", "owner"),
      h.makePerson(orgA, "assoc-a", "associate"),
      h.makePerson(orgA, "assoc-a2", "associate"),
      h.makePerson(orgA, "admin-a", "admin"),
      h.makePerson(orgB, "owner-b", "owner"),
      h.makePerson(orgB, "assoc-b", "associate"),
    ]);
    // The REAL seed script creates both practices' template, as Sam will run it.
    for (const name of [nameA, nameB]) {
      const r = await seedReportTemplate(h.owner.$client, { org: `Synthetic Org ${name}` }, { apply: true });
      expect(r.status).toBe("created");
    }
    const tpl = async (orgId: string) => {
      const [t] = await h.owner.select().from(schema.reportTemplates).where(eq(schema.reportTemplates.organizationId, orgId));
      return { templateId: t.id, promptId: t.activeMethodologyPromptId! };
    };
    tplA = await tpl(orgA);
    tplB = await tpl(orgB);

    c1 = await seedClient(orgA, `Report Client One ${tag()}`);
    c2 = await seedClient(orgA, `Report Client Two ${tag()}`);
    await assign(c1.id, assocA, ownerA);
    await assign(c1.id, adminA, ownerA);
    await assign(c2.id, assocA2, ownerA);
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
  });

  // ---------------------------------------------------------------------------------------
  describe("the template seed script on a real database", () => {
    it("created a layout-only template and a placeholder prompt, pinned by the template, with audit rows", async () => {
      const [t] = await h.owner.select().from(schema.reportTemplates).where(eq(schema.reportTemplates.organizationId, orgA));
      expect(t).toMatchObject({ slug: TEMPLATE_SLUG, structure: TEMPLATE_STRUCTURE, activeMethodologyPromptId: tplA.promptId });
      const [p] = await h.owner.select().from(schema.methodologyPrompts).where(eq(schema.methodologyPrompts.id, tplA.promptId));
      expect(p).toMatchObject({ templateId: t.id, versionNumber: 1, content: PLACEHOLDER_CONTENT, organizationId: orgA });
      expect((await auditRows(orgA, "template.created")).map((a) => [a.resourceId, a.metadata])).toEqual([[t.id, { method: "seed_script" }]]);
      expect((await auditRows(orgA, "methodology_prompt.created")).map((a) => a.resourceId)).toEqual([p.id]);
    });

    it("a second run is refused and changes nothing; a dry run on a practice without one creates nothing", async () => {
      const [org] = await h.owner.select().from(schema.organizations).where(eq(schema.organizations.id, orgA));
      expect(await seedReportTemplate(h.owner.$client, { org: org.name }, { apply: true })).toEqual({ status: "template_exists" });
      expect(await h.owner.select().from(schema.reportTemplates).where(eq(schema.reportTemplates.organizationId, orgA))).toHaveLength(1);

      const bare = await h.seedOrg(`reports-bare-${tag()}`);
      const [bareOrg] = await h.owner.select().from(schema.organizations).where(eq(schema.organizations.id, bare));
      expect(await seedReportTemplate(h.owner.$client, { org: bareOrg.name }, { apply: false })).toEqual({ status: "owner_not_found" });
      await h.seedUser(bare, "bare-owner", "owner");
      const dry = await seedReportTemplate(h.owner.$client, { org: bareOrg.name }, { apply: false });
      expect(dry.status).toBe("dry_run");
      expect(await h.owner.select().from(schema.reportTemplates).where(eq(schema.reportTemplates.organizationId, bare))).toHaveLength(0);
      expect(await seedReportTemplate(h.owner.$client, { org: "No Such Practice " + tag() }, { apply: true })).toEqual({ status: "org_not_found" });
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("who may call", () => {
    it("no session is 401 on every method, and nothing changes", async () => {
      const nobody = { label: "nobody", orgId: "none" };
      const r = await mkReport(orgA, c1.id, ownerA, "generated");
      const sectionId = r.sections[0].id;
      const calls = [
        h.call(nobody, collection.GET, { path: "/api/reports" }),
        h.call(nobody, collection.POST, { method: "POST", path: "/api/reports", body: { clientId: c1.id, templateSlug: TEMPLATE_SLUG } }),
        h.call(nobody, detail.GET, { path: `/api/reports/${r.reportId}`, params: { id: r.reportId } }),
        h.call(nobody, section.PUT, { method: "PUT", path: "/x", body: { text: "x", baseVersion: 0 }, params: { id: r.reportId, sectionId } }),
        h.call(nobody, versions.GET, { path: "/x", params: { id: r.reportId, sectionId } }),
        h.call(nobody, finalize.POST, { method: "POST", path: "/x", params: { id: r.reportId } }),
      ];
      for (const res of await Promise.all(calls)) expect(res.status).toBe(401);
      expect((await reportRow(r.reportId)).status).toBe("generated");
      expect(await versionRows(sectionId)).toHaveLength(0);
    });

    it("an admin reads reports of a granted client and nothing else; every write is 403, audited, and changes nothing", async () => {
      const granted = await mkReport(orgA, c1.id, ownerA, "generated");
      const other = await mkReport(orgA, c2.id, ownerA, "generated");
      expect((await get(adminA, granted.reportId)).status).toBe(200);
      expect((await history(adminA, granted.reportId, granted.sections[0].id)).status).toBe(200);
      expect((await get(adminA, other.reportId)).status).toBe(404);
      const ids = ((await list(adminA, "?limit=100")).json.data as { id: string }[]).map((x) => x.id);
      expect(ids).toContain(granted.reportId);
      expect(ids).not.toContain(other.reportId);

      const denied0 = (await auditRows(orgA, "authz.denied")).filter((r) => r.actorUserId === adminA.userId).length;
      const before = (await h.owner.select().from(schema.reports).where(eq(schema.reports.organizationId, orgA))).length;
      const writes = [
        await create(adminA, { clientId: c1.id, templateSlug: TEMPLATE_SLUG }),
        await save(adminA, granted.reportId, granted.sections[0].id, { text: "x", baseVersion: 0 }),
        await fin(adminA, granted.reportId),
      ];
      for (const w of writes) {
        expect(w.status).toBe(403);
        expect(w.json.error?.code).toBe("forbidden");
      }
      expect((await h.owner.select().from(schema.reports).where(eq(schema.reports.organizationId, orgA))).length).toBe(before);
      expect((await reportRow(granted.reportId)).status).toBe("generated");
      expect(await versionRows(granted.sections[0].id)).toHaveLength(0);
      const denied = (await auditRows(orgA, "authz.denied")).filter((r) => r.actorUserId === adminA.userId);
      expect(denied.length - denied0).toBe(3);
    });

    it("an admin with no grant at all sees no reports", async () => {
      const lonely = await h.makePerson(orgA, "admin-lonely", "admin");
      await mkReport(orgA, c1.id, ownerA, "draft");
      expect((await list(lonely)).json.data).toEqual([]);
    });

    it("no CORS headers, even to a cross-site Origin", async () => {
      const r = await create(ownerA, { clientId: c1.id, templateSlug: TEMPLATE_SLUG }, { origin: "https://evil.example" });
      expect(r.status).toBe(403);
      for (const name of r.headers.keys()) expect(name.toLowerCase()).not.toMatch(/^access-control-/);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("visibility follows the client", () => {
    it("owner sees every live client's reports; an associate only those of assigned clients; the same 404 for everything else", async () => {
      const r1 = await mkReport(orgA, c1.id, ownerA);
      const r2 = await mkReport(orgA, c2.id, ownerA);
      const foreign = await mkReport(orgB, (await seedClient(orgB, `Foreign ${tag()}`)).id, ownerB);

      const ownerIds = ((await list(ownerA, "?limit=100")).json.data as { id: string }[]).map((x) => x.id);
      expect(ownerIds).toEqual(expect.arrayContaining([r1.reportId, r2.reportId]));
      expect(ownerIds).not.toContain(foreign.reportId);
      const assocIds = ((await list(assocA, "?limit=100")).json.data as { id: string }[]).map((x) => x.id);
      expect(assocIds).toContain(r1.reportId);
      expect(assocIds).not.toContain(r2.reportId);

      const answers = [r2.reportId, foreign.reportId, crypto.randomUUID()].map(async (id) => (await get(assocA, id)));
      const texts = new Set((await Promise.all(answers)).map((a) => `${a.status}:${a.text}`));
      expect(texts.size).toBe(1);
      expect([...texts][0].startsWith("404:")).toBe(true);
    });

    it("practice B cannot reach practice A's reports through any route, and the reverse; a section id from another report is a 404", async () => {
      const a = await mkReport(orgA, c1.id, ownerA, "generated");
      const bClient = await seedClient(orgB, `B Client ${tag()}`);
      const b = await mkReport(orgB, bClient.id, ownerB, "generated");
      const madeUp = await get(ownerB, crypto.randomUUID());
      const cross = await get(ownerB, a.reportId);
      expect(cross.status).toBe(404);
      expect(cross.text).toBe(madeUp.text);
      expect((await save(ownerB, a.reportId, a.sections[0].id, { text: "x", baseVersion: 0 })).status).toBe(404);
      expect((await history(ownerB, a.reportId, a.sections[0].id)).status).toBe(404);
      expect((await fin(ownerB, a.reportId)).status).toBe(404);
      expect((await get(ownerA, b.reportId)).status).toBe(404);
      expect((await get(assocB, a.reportId)).status).toBe(404);
      expect((await fin(assocB, a.reportId)).status).toBe(404);
      // B's own section id under A's report, and A's section id under B's report: not found either way.
      expect((await save(ownerA, a.reportId, b.sections[0].id, { text: "x", baseVersion: 0 })).status).toBe(404);
      expect((await save(ownerB, b.reportId, a.sections[0].id, { text: "x", baseVersion: 0 })).status).toBe(404);
      // Another report in the SAME practice.
      const a2 = await mkReport(orgA, c1.id, ownerA, "generated");
      expect((await save(ownerA, a.reportId, a2.sections[0].id, { text: "x", baseVersion: 0 })).status).toBe(404);
      expect((await history(ownerA, a.reportId, a2.sections[0].id)).status).toBe(404);
      expect(await versionRows(a.sections[0].id)).toHaveLength(0);
      expect(await versionRows(a2.sections[0].id)).toHaveLength(0);
      expect((await reportRow(a.reportId)).status).toBe("generated");
    });

    it("deleting the client hides its reports from every role on every route", async () => {
      const client = await seedClient(orgA, `Doomed ${tag()}`);
      await assign(client.id, assocA, ownerA);
      const r = await mkReport(orgA, client.id, ownerA, "generated");
      expect((await get(assocA, r.reportId)).status).toBe(200);
      await h.owner.update(schema.clients).set({ deletedAt: new Date() }).where(eq(schema.clients.id, client.id));
      for (const who of [ownerA, assocA]) {
        expect((await get(who, r.reportId)).status, who.label).toBe(404);
        expect((await save(who, r.reportId, r.sections[0].id, { text: "x", baseVersion: 0 })).status, who.label).toBe(404);
        expect((await fin(who, r.reportId)).status, who.label).toBe(404);
        expect(((await list(who, "?limit=100")).json.data as { id: string }[]).some((x) => x.id === r.reportId)).toBe(false);
      }
      expect((await reportRow(r.reportId)).status).toBe("generated");
    });

    it("ending an assignment takes the reports away on the next request", async () => {
      const client = await seedClient(orgA, `Ended ${tag()}`);
      await assign(client.id, assocA, ownerA);
      const r = await mkReport(orgA, client.id, ownerA, "draft");
      expect((await get(assocA, r.reportId)).status).toBe(200);
      await h.owner.update(schema.clientAssignments).set({ deletedAt: new Date() }).where(and(eq(schema.clientAssignments.clientId, client.id), eq(schema.clientAssignments.userId, assocA.userId)));
      expect((await get(assocA, r.reportId)).status).toBe(404);
      expect((await save(assocA, r.reportId, r.sections[0].id, { text: "x", baseVersion: 0 })).status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("create", () => {
    it("the owner starts a report: a draft with the template's six empty sections, pinned to the active prompt, audited with ids only", async () => {
      const r = await create(ownerA, { clientId: c1.id, templateSlug: TEMPLATE_SLUG });
      expect(r.status).toBe(201);
      expect(r.headers.get("cache-control")).toBe("private, no-store");
      const data = r.json.data as Record<string, unknown>;
      expect(Object.keys(data).sort()).toEqual(REPORT_KEYS);
      expect(data).toMatchObject({ clientId: c1.id, status: "draft", finalizedAt: null });
      const row = await reportRow(data.id as string);
      expect(row).toMatchObject({ organizationId: orgA, templateId: tplA.templateId, methodologyPromptId: tplA.promptId, createdByUserId: ownerA.userId, status: "draft" });
      const secs = await h.owner.select().from(schema.reportSections).where(eq(schema.reportSections.reportId, row.id)).orderBy(asc(schema.reportSections.position));
      expect(secs.map((s) => [s.sectionKey, s.sectionType, s.position])).toEqual(TEMPLATE_STRUCTURE.sections.map((s, i) => [s.key, "prose", i + 1]));
      expect(await h.owner.select().from(schema.reportVersions).where(eq(schema.reportVersions.reportId, row.id))).toHaveLength(0);
      const rows = (await auditRows(orgA, "report.created")).filter((a) => a.resourceId === row.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorUserId: ownerA.userId, resourceType: "report", metadata: { role: "owner" } });
    });

    it("an associate starts a report for an assigned client; an unassigned, foreign, deleted or made-up client is the same 404", async () => {
      expect((await create(assocA, { clientId: c1.id, templateSlug: TEMPLATE_SLUG })).status).toBe(201);
      const foreign = await seedClient(orgB, `Foreign ${tag()}`);
      const deleted = await seedClient(orgA, `Deleted ${tag()}`, { deletedAt: new Date() });
      await assign(deleted.id, assocA, ownerA);
      const before = (await h.owner.select().from(schema.reports).where(inArray(schema.reports.organizationId, [orgA, orgB]))).length;
      const answers = new Set<string>();
      for (const clientId of [c2.id, foreign.id, deleted.id, crypto.randomUUID()]) {
        const r = await create(assocA, { clientId, templateSlug: TEMPLATE_SLUG });
        expect(r.status, clientId).toBe(404);
        answers.add(r.text);
      }
      expect(answers.size).toBe(1);
      expect((await h.owner.select().from(schema.reports).where(inArray(schema.reports.organizationId, [orgA, orgB]))).length).toBe(before);
    });

    it("practice B's owner cannot start a report on practice A's client, even naming A's template slug", async () => {
      const r = await create(ownerB, { clientId: c1.id, templateSlug: TEMPLATE_SLUG });
      expect(r.status).toBe(404);
    });

    it("a report uses the caller's own practice's template and prompt, not another practice's", async () => {
      const bClient = await seedClient(orgB, `B Client ${tag()}`);
      const r = await create(ownerB, { clientId: bClient.id, templateSlug: TEMPLATE_SLUG });
      expect(r.status).toBe(201);
      expect(await reportRow((r.json.data as { id: string }).id)).toMatchObject({ organizationId: orgB, templateId: tplB.templateId, methodologyPromptId: tplB.promptId });
    });

    it("an unknown template is a 404; a template with no active prompt yet is a 409 and creates nothing", async () => {
      expect((await create(ownerA, { clientId: c1.id, templateSlug: "nope" })).status).toBe(404);
      const bare = tag();
      await h.owner.insert(schema.reportTemplates).values({ organizationId: orgA, slug: `bare-${bare}`, name: "Bare", structure: TEMPLATE_STRUCTURE });
      const before = (await h.owner.select().from(schema.reports).where(eq(schema.reports.organizationId, orgA))).length;
      const r = await create(ownerA, { clientId: c1.id, templateSlug: `bare-${bare}` });
      expect(r.status).toBe(409);
      expect(r.json.error?.code).toBe("conflict");
      expect((await h.owner.select().from(schema.reports).where(eq(schema.reports.organizationId, orgA))).length).toBe(before);
    });

    it.each([
      ["no body", ""],
      ["not json", "{nope"],
      ["array", "[]"],
      ["null", "null"],
      ["missing slug", JSON.stringify({ clientId: crypto.randomUUID() })],
      ["missing client", JSON.stringify({ templateSlug: TEMPLATE_SLUG })],
      ["client not a uuid", JSON.stringify({ clientId: "abc", templateSlug: TEMPLATE_SLUG })],
      ["slug with a slash", JSON.stringify({ clientId: crypto.randomUUID(), templateSlug: "a/b" })],
      ["organizationId", JSON.stringify({ clientId: crypto.randomUUID(), templateSlug: TEMPLATE_SLUG, organizationId: crypto.randomUUID() })],
      ["a status", JSON.stringify({ clientId: crypto.randomUUID(), templateSlug: TEMPLATE_SLUG, status: "finalized" })],
      ["a prompt id", JSON.stringify({ clientId: crypto.randomUUID(), templateSlug: TEMPLATE_SLUG, methodologyPromptId: crypto.randomUUID() })],
    ])("rejects %s with a 400", async (_label, rawBody) => {
      const before = (await h.owner.select().from(schema.reports).where(eq(schema.reports.organizationId, orgA))).length;
      const r = await create(ownerA, undefined, { rawBody });
      expect(r.status).toBe(400);
      expect(r.json.error?.code).toBe("validation_failed");
      expect((await h.owner.select().from(schema.reports).where(eq(schema.reports.organizationId, orgA))).length).toBe(before);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("reading", () => {
    it("the detail has exactly the allow-listed fields, the template's titles in order, and no internal ids", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      const res = await get(ownerA, r.reportId);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const data = res.json.data as { sections: Record<string, unknown>[] } & Record<string, unknown>;
      expect(Object.keys(data).sort()).toEqual([...REPORT_KEYS, "sections", "templateSlug"].sort());
      expect(data.templateSlug).toBe(TEMPLATE_SLUG);
      expect(data.sections.map((s) => s.title)).toEqual(TEMPLATE_STRUCTURE.sections.map((s) => s.title));
      for (const s of data.sections) {
        expect(Object.keys(s).sort()).toEqual(SECTION_KEYS);
        expect(s).toMatchObject({ text: "", version: 0, editType: null, editedAt: null, authorName: null });
      }
      for (const secret of [orgA, tplA.promptId, tplA.templateId, ownerA.userId]) expect(res.text).not.toContain(secret);
      const viewed = (await auditRows(orgA, "report.viewed")).filter((a) => a.resourceId === r.reportId);
      expect(viewed).toHaveLength(1);
      expect(viewed[0]).toMatchObject({ actorUserId: ownerA.userId, metadata: { role: "owner" } });
    });

    it("a malformed id is a 400", async () => {
      expect((await get(ownerA, "nope")).status).toBe(400);
      const r = await mkReport(orgA, c1.id, ownerA);
      expect((await history(ownerA, r.reportId, "nope")).status).toBe(400);
      expect((await fin(ownerA, "nope")).status).toBe(400);
    });

    it("the list filters by client and status, pages strictly, and holds no section text", async () => {
      const client = await seedClient(orgA, `List ${tag()}`);
      const d = await mkReport(orgA, client.id, ownerA, "draft");
      const g = await mkReport(orgA, client.id, ownerA, "generated");
      await save(ownerA, d.reportId, d.sections[0].id, { text: SECRET, baseVersion: 0 });
      const byClient = await list(ownerA, `?clientId=${client.id}`);
      expect((byClient.json.data as { id: string }[]).map((x) => x.id).sort()).toEqual([d.reportId, g.reportId].sort());
      expect(byClient.text).not.toContain(SECRET);
      const generated = await list(ownerA, `?clientId=${client.id}&status=generated`);
      expect((generated.json.data as { id: string }[]).map((x) => x.id)).toEqual([g.reportId]);
      expect(((await list(ownerA, `?clientId=${client.id}&limit=1`)).json.data as unknown[]).length).toBe(1);
      for (const bad of ["?limit=0", "?limit=101", "?offset=-1", "?status=bogus", "?clientId=nope", "?extra=1"]) expect((await list(ownerA, bad)).status, bad).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("saving a section", () => {
    it("every save is a new numbered version; the current text is the highest; history lists them newest first", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      const sid = r.sections[1].id;
      const first = await save(ownerA, r.reportId, sid, { text: `${SECRET} one`, baseVersion: 0 });
      expect(first.status).toBe(200);
      expect(first.json.data).toMatchObject({ version: 1 });
      const second = await save(assocA, r.reportId, sid, { text: `${SECRET} two\nsecond line`, baseVersion: 1 });
      expect(second.status).toBe(200);
      expect(second.json.data).toMatchObject({ version: 2 });

      const rows = await versionRows(sid);
      expect(rows.map((v) => [v.versionNumber, v.editType, v.createdByUserId, v.content])).toEqual([
        [1, "human_edit", ownerA.userId, { text: `${SECRET} one` }],
        [2, "human_edit", assocA.userId, { text: `${SECRET} two\nsecond line` }],
      ]);
      const view = (await get(ownerA, r.reportId)).json.data as { sections: { id: string; text: string; version: number; editType: string }[] };
      expect(view.sections.find((s) => s.id === sid)).toMatchObject({ text: `${SECRET} two\nsecond line`, version: 2, editType: "human_edit" });
      expect(view.sections.filter((s) => s.id !== sid).every((s) => s.version === 0 && s.text === "")).toBe(true);

      const hist = await history(ownerA, r.reportId, sid);
      expect((hist.json.data as { version: number; text: string }[]).map((v) => [v.version, v.text])).toEqual([[2, `${SECRET} two\nsecond line`], [1, `${SECRET} one`]]);
      expect(((await history(ownerA, r.reportId, sid, "?limit=1&offset=1")).json.data as { version: number }[]).map((v) => v.version)).toEqual([1]);

      const edits = (await auditRows(orgA, "report.section_edited")).filter((a) => rows.some((v) => v.id === a.resourceId));
      expect(edits).toHaveLength(2);
      expect(JSON.stringify(edits)).not.toContain(SECRET);
    });

    it("a stale or invented baseVersion is a 409 and stores nothing; an empty text is a valid save", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      const sid = r.sections[0].id;
      await save(ownerA, r.reportId, sid, { text: "one", baseVersion: 0 });
      for (const base of [0, 2, 5]) {
        const res = await save(ownerA, r.reportId, sid, { text: SECRET, baseVersion: base });
        expect(res.status, String(base)).toBe(409);
        expect(res.json.error?.code).toBe("conflict");
        expect(res.text).not.toContain(SECRET);
      }
      expect(await versionRows(sid)).toHaveLength(1);
      expect((await save(ownerA, r.reportId, sid, { text: "", baseVersion: 1 })).status).toBe(200);
      expect(((await get(ownerA, r.reportId)).json.data as { sections: { id: string; text: string }[] }).sections.find((s) => s.id === sid)!.text).toBe("");
    });

    it("two writers starting from the same version: exactly one wins, one row exists", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      const sid = r.sections[2].id;
      const results = await Promise.all([
        save(ownerA, r.reportId, sid, { text: "from owner", baseVersion: 0 }),
        save(assocA, r.reportId, sid, { text: "from associate", baseVersion: 0 }),
        save(ownerA, r.reportId, sid, { text: "from owner again", baseVersion: 0 }),
      ]);
      expect(results.map((x) => x.status).sort()).toEqual([200, 409, 409]);
      const rows = await versionRows(sid);
      expect(rows).toHaveLength(1);
      expect(rows[0].versionNumber).toBe(1);
    });

    it.each([
      ["draft", 200],
      ["generated", 200],
      ["error", 200],
      ["generating", 409],
      ["finalized", 409],
    ] as const)("on a %s report a save is %i", async (status, expected) => {
      const r = await mkReport(orgA, c1.id, ownerA, status);
      const res = await save(ownerA, r.reportId, r.sections[0].id, { text: SECRET, baseVersion: 0 });
      expect(res.status).toBe(expected);
      expect(await versionRows(r.sections[0].id)).toHaveLength(expected === 200 ? 1 : 0);
      expect((await reportRow(r.reportId)).status).toBe(status);
    });

    it("an associate cannot save into an unassigned client's report (the same 404), and the report row is untouched", async () => {
      const r = await mkReport(orgA, c2.id, ownerA, "draft");
      const before = (await reportRow(r.reportId)).updatedAt;
      const res = await save(assocA, r.reportId, r.sections[0].id, { text: SECRET, baseVersion: 0 });
      expect(res.status).toBe(404);
      expect(res.text).not.toContain(SECRET);
      expect(await versionRows(r.sections[0].id)).toHaveLength(0);
      expect((await reportRow(r.reportId)).updatedAt).toEqual(before);
    });

    it.each([
      ["no body", { rawBody: "" }],
      ["not json", { rawBody: "{nope" }],
      ["array", { rawBody: "[]" }],
      ["missing baseVersion", { body: { text: SECRET } }],
      ["missing text", { body: { baseVersion: 0 } }],
      ["negative baseVersion", { body: { text: SECRET, baseVersion: -1 } }],
      ["fractional baseVersion", { body: { text: SECRET, baseVersion: 0.5 } }],
      ["string baseVersion", { body: { text: SECRET, baseVersion: "0" } }],
      ["text not a string", { body: { text: 7, baseVersion: 0 } }],
      ["text too long", { body: { text: SECRET + "x".repeat(MAX_SECTION_TEXT), baseVersion: 0 } }],
      ["control character", { body: { text: `${SECRET}\u0007`, baseVersion: 0 } }],
      ["nul byte", { body: { text: `${SECRET}\u0000`, baseVersion: 0 } }],
      ["editType", { body: { text: SECRET, baseVersion: 0, editType: "ai_generated" } }],
      ["a version number", { body: { text: SECRET, baseVersion: 0, versionNumber: 99 } }],
      ["a report id", { body: { text: SECRET, baseVersion: 0, reportId: crypto.randomUUID() } }],
      ["an oversize body", { rawBody: JSON.stringify({ text: "x".repeat(MAX_SECTION_TEXT + 5000), baseVersion: 0 }) }],
    ] as const)("rejects %s with a 400 that echoes nothing", async (_label, input) => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      const res = await save(ownerA, r.reportId, r.sections[0].id, "body" in input ? input.body : undefined, "rawBody" in input ? { rawBody: input.rawBody } : {});
      expect(res.status).toBe(400);
      expect(res.json.error?.code).toBe("validation_failed");
      expect(res.text).not.toContain(SECRET);
      expect(await versionRows(r.sections[0].id)).toHaveLength(0);
    });

    it("text that looks like markup or SQL is stored and returned as plain data", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      const nasty = `<script>alert(1)</script> '); drop table report_versions; --`;
      expect((await save(ownerA, r.reportId, r.sections[0].id, { text: nasty, baseVersion: 0 })).status).toBe(200);
      const view = (await get(ownerA, r.reportId)).json.data as { sections: { text: string }[] };
      expect(view.sections[0].text).toBe(nasty);
      expect((await versionRows(r.sections[0].id))[0].content).toEqual({ text: nasty });
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("finalizing", () => {
    it.each(["draft", "generating", "error", "finalized"] as const)("a %s report cannot be finalized: 409, nothing changes", async (status) => {
      const r = await mkReport(orgA, c1.id, ownerA, status);
      const before = await reportRow(r.reportId);
      const res = await fin(ownerA, r.reportId);
      expect(res.status).toBe(409);
      expect(res.json.error?.code).toBe("conflict");
      const after = await reportRow(r.reportId);
      expect(after.status).toBe(status);
      expect(after.finalizedAt?.getTime() ?? null).toBe(before.finalizedAt?.getTime() ?? null);
    });

    it("a generated report is finalized once; afterwards it accepts no edit and cannot be finalized again", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "generated");
      await save(ownerA, r.reportId, r.sections[0].id, { text: "before", baseVersion: 0 });
      const res = await fin(assocA, r.reportId);
      expect(res.status).toBe(200);
      expect(Object.keys(res.json.data as object).sort()).toEqual(REPORT_KEYS);
      expect(res.json.data).toMatchObject({ id: r.reportId, status: "finalized" });
      const row = await reportRow(r.reportId);
      expect(row.status).toBe("finalized");
      expect(row.finalizedAt).not.toBeNull();

      const late = await save(ownerA, r.reportId, r.sections[0].id, { text: SECRET, baseVersion: 1 });
      expect(late.status).toBe(409);
      expect(await versionRows(r.sections[0].id)).toHaveLength(1);
      expect((await fin(ownerA, r.reportId)).status).toBe(409);
      const text = ((await get(ownerA, r.reportId)).json.data as { sections: { text: string }[] }).sections[0].text;
      expect(text).toBe("before");

      const rows = (await auditRows(orgA, "report.finalized")).filter((a) => a.resourceId === r.reportId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorUserId: assocA.userId, metadata: { role: "associate" } });
    });

    it("an associate cannot finalize an unassigned client's report; the owner can", async () => {
      const r = await mkReport(orgA, c2.id, ownerA, "generated");
      expect((await fin(assocA, r.reportId)).status).toBe(404);
      expect((await reportRow(r.reportId)).status).toBe("generated");
      expect((await fin(ownerA, r.reportId)).status).toBe(200);
    });

    it("finalize and a save at the same moment end in a consistent state, repeatedly", async () => {
      for (let i = 0; i < 4; i++) {
        const r = await mkReport(orgA, c1.id, ownerA, "generated");
        const [f, s] = await Promise.all([fin(ownerA, r.reportId), save(assocA, r.reportId, r.sections[0].id, { text: `race ${i}`, baseVersion: 0 })]);
        expect(f.status).toBe(200);
        expect([200, 409]).toContain(s.status);
        expect((await reportRow(r.reportId)).status).toBe("finalized");
        const rows = await versionRows(r.sections[0].id);
        expect(rows).toHaveLength(s.status === 200 ? 1 : 0);
        // Whatever the order, the report accepts nothing from here on.
        expect((await save(ownerA, r.reportId, r.sections[0].id, { text: "after", baseVersion: rows.length })).status).toBe(409);
      }
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("cross-site requests", () => {
    it.each([
      ["a cross-site origin", "https://evil.example"],
      ["a look-alike origin", `${BASE}.evil.example`],
      ["the string null", "null"],
      ["no origin at all", null],
    ])("create, save and finalize are 403 with %s, even for a valid owner, and change nothing", async (_label, origin) => {
      const r = await mkReport(orgA, c1.id, ownerA, "generated");
      const before = (await h.owner.select().from(schema.reports).where(eq(schema.reports.organizationId, orgA))).length;
      expect((await create(ownerA, { clientId: c1.id, templateSlug: TEMPLATE_SLUG }, { origin })).status).toBe(403);
      expect((await save(ownerA, r.reportId, r.sections[0].id, { text: "x", baseVersion: 0 }, { origin })).status).toBe(403);
      expect((await fin(ownerA, r.reportId, { origin })).status).toBe(403);
      expect((await h.owner.select().from(schema.reports).where(eq(schema.reports.organizationId, orgA))).length).toBe(before);
      expect((await reportRow(r.reportId)).status).toBe("generated");
      expect(await versionRows(r.sections[0].id)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("who changed a section", () => {
    const nameOf = (p: Person) => `Synthetic ${p.label}`;
    type V = { id: string; version: number; editType: string; text: string; createdAt: string; authorName: string | null };
    type D = { sections: { id: string; version: number; editType: string | null; editedAt: string | null; authorName: string | null }[] };
    const hist = async (who: Person, reportId: string, sectionId: string) => (await history(who, reportId, sectionId)).json.data as V[];
    const sectionOf = async (who: Person, reportId: string, sectionId: string) => ((await get(who, reportId)).json.data as D).sections.find((x) => x.id === sectionId)!;
    /** A model-written first version, inserted as the generation code does (no author id). */
    const modelText = (orgId: string, reportId: string, sectionId: string) =>
      h.owner.insert(schema.reportVersions).values({ organizationId: orgId, reportId, sectionId, versionNumber: 1, editType: "ai_generated", content: { text: "model words" }, createdByUserId: null });

    it("the history and the detail name the person who wrote each version, and the time is the version's", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      const sid = r.sections[0].id;
      await save(ownerA, r.reportId, sid, { text: "one", baseVersion: 0 });
      await save(assocA, r.reportId, sid, { text: "two", baseVersion: 1 });
      for (const who of [ownerA, assocA, adminA]) {
        const list = await hist(who, r.reportId, sid);
        expect(list.map((v) => [v.version, v.authorName]), who.label).toEqual([[2, nameOf(assocA)], [1, nameOf(ownerA)]]);
        for (const v of list) expect(Object.keys(v).sort()).toEqual(VERSION_KEYS);
        const cur = await sectionOf(who, r.reportId, sid);
        expect(cur).toMatchObject({ version: 2, authorName: nameOf(assocA), editedAt: list[0].createdAt });
        // A section nobody has written has no author.
        expect(await sectionOf(who, r.reportId, r.sections[1].id)).toMatchObject({ version: 0, authorName: null, editedAt: null });
      }
    });

    it("model-written text has no author (null), and a person's edit on top of it has theirs", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      const sid = r.sections[0].id;
      await modelText(orgA, r.reportId, sid);
      expect(await hist(ownerA, r.reportId, sid)).toMatchObject([{ version: 1, editType: "ai_generated", authorName: null }]);
      expect(await sectionOf(ownerA, r.reportId, sid)).toMatchObject({ version: 1, editType: "ai_generated", authorName: null });
      await save(assocA, r.reportId, sid, { text: "edited", baseVersion: 1 });
      expect((await hist(ownerA, r.reportId, sid)).map((v) => [v.version, v.editType, v.authorName])).toEqual([[2, "human_edit", nameOf(assocA)], [1, "ai_generated", null]]);
      expect(await sectionOf(ownerA, r.reportId, sid)).toMatchObject({ editType: "human_edit", authorName: nameOf(assocA) });
    });

    it("a deactivated person still shows their name", async () => {
      const gone = await h.makePerson(orgA, `assoc-gone-${tag()}`, "associate");
      await assign(c1.id, gone, ownerA);
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      const sid = r.sections[0].id;
      expect((await save(gone, r.reportId, sid, { text: "before leaving", baseVersion: 0 })).status).toBe(200);
      await h.owner.update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, gone.userId));
      expect((await hist(ownerA, r.reportId, sid))[0].authorName).toBe(nameOf(gone));
      expect((await sectionOf(ownerA, r.reportId, sid)).authorName).toBe(nameOf(gone));
    });

    it("another practice's user never appears; the data layer cannot even store such an author", async () => {
      const clientB = await seedClient(orgB, `Report Client B ${tag()}`);
      await assign(clientB.id, assocB, ownerB);
      const b = await mkReport(orgB, clientB.id, ownerB, "draft");
      expect((await save(assocB, b.reportId, b.sections[0].id, { text: "from practice B", baseVersion: 0 })).status).toBe(200);
      expect((await hist(ownerB, b.reportId, b.sections[0].id))[0].authorName).toBe(nameOf(assocB));

      // A report in practice A, authored by A's people, read by every A role.
      const a = await mkReport(orgA, c1.id, ownerA, "draft");
      await save(ownerA, a.reportId, a.sections[0].id, { text: "from A", baseVersion: 0 });
      for (const who of [ownerA, assocA, adminA]) {
        for (const text of [(await get(who, a.reportId)).text, (await history(who, a.reportId, a.sections[0].id)).text]) {
          for (const other of [ownerB, assocB]) for (const needle of [nameOf(other), other.email, other.userId]) expect(text, `${who.label} saw ${needle}`).not.toContain(needle);
        }
        // And A cannot ask for B's report or its section.
        expect((await get(who, b.reportId)).status).toBe(404);
        expect((await history(who, b.reportId, b.sections[0].id)).status).toBe(404);
      }
      // The database refuses a version whose author belongs to another practice (composite foreign key).
      const forged = h.owner.insert(schema.reportVersions).values({ organizationId: orgA, reportId: a.reportId, sectionId: a.sections[1].id, versionNumber: 1, editType: "human_edit", content: { text: "forged" }, createdByUserId: ownerB.userId });
      await expect(forged).rejects.toMatchObject({ cause: { code: "23503", constraint: "report_versions_created_by_fk" } });
    });

    it("an associate who cannot see the client, and an admin without a grant, get the same 404 as for a report that does not exist", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      const sid = r.sections[0].id;
      await save(ownerA, r.reportId, sid, { text: "private", baseVersion: 0 });
      const other = await mkReport(orgA, c2.id, ownerA, "draft");
      await save(ownerA, other.reportId, other.sections[0].id, { text: "private two", baseVersion: 0 });
      const missing = "99999999-9999-4999-8999-999999999999";
      const missingDetail = await get(assocA2, missing);
      const missingHistory = await history(assocA2, missing, missing);
      expect(missingDetail.status).toBe(404);
      for (const [who, rep, sec] of [[assocA2, r.reportId, sid], [assocA, other.reportId, other.sections[0].id], [adminA, other.reportId, other.sections[0].id]] as const) {
        const d = await get(who, rep);
        const v = await history(who, rep, sec);
        expect([d.status, v.status], who.label).toEqual([404, 404]);
        expect(d.text).toBe(missingDetail.text);
        expect(v.text).toBe(missingHistory.text);
        expect(d.text + v.text).not.toContain(nameOf(ownerA));
      }
      // A section id that belongs to another report is the same 404, even for the owner.
      expect((await history(ownerA, r.reportId, other.sections[0].id)).status).toBe(404);
    });

    it("no email, user id or role of the author is in either response, and no field beyond the documented ones", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      const sid = r.sections[0].id;
      await save(ownerA, r.reportId, sid, { text: "one", baseVersion: 0 });
      await save(assocA, r.reportId, sid, { text: "two", baseVersion: 1 });
      for (const who of [ownerA, assocA, adminA]) {
        const bodies = [(await get(who, r.reportId)).text, (await history(who, r.reportId, sid)).text];
        for (const text of bodies) {
          for (const p of [ownerA, assocA]) for (const needle of [p.email, p.userId]) expect(text, `${who.label}: ${needle}`).not.toContain(needle);
          expect(text).not.toMatch(/"(email|userId|createdByUserId|role|actorUserId|organizationId)"/);
        }
        const d = (await get(who, r.reportId)).json.data as D;
        for (const x of d.sections) expect(Object.keys(x).sort()).toEqual(SECTION_KEYS);
      }
    });

    it("the save contract, its 409 and the audit are unchanged", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      const sid = r.sections[0].id;
      const ok = await save(ownerA, r.reportId, sid, { text: "one", baseVersion: 0 });
      expect(ok.status).toBe(200);
      expect(Object.keys(ok.json.data as object).sort()).toEqual(["version", "versionId"]);
      expect((await save(assocA, r.reportId, sid, { text: "late", baseVersion: 0 })).status).toBe(409);
      // One read, one `report.viewed` row with the role only; the new field adds no row and no key.
      const count = async (resourceId: string) => (await auditRows(orgA, "report.viewed")).filter((a) => a.resourceId === resourceId);
      const before = [await count(r.reportId), await count(sid)];
      await get(ownerA, r.reportId);
      await history(ownerA, r.reportId, sid);
      const after = [await count(r.reportId), await count(sid)];
      expect(after.map((x) => x.length)).toEqual(before.map((x) => x.length + 1));
      for (const row of after.flat()) expect(row.metadata).toEqual({ role: "owner" });
    });

    it("the number of statements does not grow with the number of authors or sections written (no N+1)", async () => {
      const statements = h.statementsOf;
      const one = await mkReport(orgA, c1.id, ownerA, "draft");
      await save(ownerA, one.reportId, one.sections[0].id, { text: "x", baseVersion: 0 });
      const many = await mkReport(orgA, c1.id, ownerA, "draft");
      for (const [i, sec] of many.sections.entries()) await save(i % 2 ? assocA : ownerA, many.reportId, sec.id, { text: `s${i}`, baseVersion: 0 });
      const none = await mkReport(orgA, c1.id, ownerA, "draft");

      const detailOne = await statements(() => get(ownerA, one.reportId));
      const detailMany = await statements(() => get(ownerA, many.reportId));
      const detailNone = await statements(() => get(ownerA, none.reportId));
      // The session check reads `users` too; the author lookup is the one that selects by a list of ids.
      const isUsers = (q: string) => /from "users"/.test(q) && /"users"\."id" in \(/.test(q);
      expect(detailOne.length).toBe(detailMany.length);
      expect(detailMany.filter(isUsers)).toHaveLength(1);
      expect(detailOne.filter(isUsers)).toHaveLength(1);
      expect(detailNone.filter(isUsers)).toHaveLength(0);

      const historyMany = await statements(() => history(ownerA, many.reportId, many.sections[0].id));
      expect(historyMany.filter(isUsers)).toHaveLength(1);
      // Two different authors across the six sections, still one lookup for all of them.
      const authors = new Set((await h.owner.select().from(schema.reportVersions).where(eq(schema.reportVersions.reportId, many.reportId))).map((v) => v.createdByUserId));
      expect(authors).toEqual(new Set([ownerA.userId, assocA.userId]));
      const detail = (await get(ownerA, many.reportId)).json.data as D;
      expect(new Set(detail.sections.map((x) => x.authorName))).toEqual(new Set([nameOf(ownerA), nameOf(assocA)]));
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("what leaks", () => {
    it("no audit row holds section text, a client name or a title", async () => {
      const rows = await h.owner.select().from(schema.auditLog).where(inArray(schema.auditLog.organizationId, [orgA, orgB]));
      expect(rows.length).toBeGreaterThan(20);
      const text = JSON.stringify(rows);
      for (const needle of [SECRET, "Report Client", "Reason for Referral", "drop table", "from owner"]) expect(text, needle).not.toContain(needle);
      for (const r of rows.filter((x) => x.action.startsWith("report."))) {
        expect(Object.keys(r.metadata as object).every((k) => k === "role"), r.action).toBe(true);
      }
    });

    it("nothing a practice-B caller received contains a practice-A report, section or client id, and the reverse", async () => {
      const reportsA = await h.owner.select().from(schema.reports).where(eq(schema.reports.organizationId, orgA));
      const sectionsA = await h.owner.select().from(schema.reportSections).where(eq(schema.reportSections.organizationId, orgA));
      const reportsB = await h.owner.select().from(schema.reports).where(eq(schema.reports.organizationId, orgB));
      expect(reportsA.length).toBeGreaterThan(10);
      const idsA = [...reportsA.map((r) => r.id), ...sectionsA.map((s) => s.id), c1.id, c2.id, tplA.promptId, tplA.templateId];
      for (const seen of h.seen) {
        if (seen.orgId === orgB) for (const id of idsA) expect(seen.text, `${seen.caller} saw ${id}`).not.toContain(id);
        if (seen.orgId === orgA) for (const r of reportsB) expect(seen.text, `${seen.caller} saw ${r.id}`).not.toContain(r.id);
      }
    });
  });
});
