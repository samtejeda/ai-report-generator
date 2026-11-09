import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { DRAFT_LINE, DOCX_CONTENT_TYPE, EMPTY_SECTION_LINE } from "@/lib/reports/export-docx";
import { MAX_EXPORTS_PER_USER } from "@/lib/reports/export-limits";
import { plainText, readZip } from "@/lib/reports/docx-test-helpers";
import { seedReportTemplate, TEMPLATE_STRUCTURE } from "@/scripts/seed-report-template.mjs";
import { ENABLED, startHarness, type Handler, type Person } from "./integration-harness";

// Lets one test make the audit row for an export impossible to build; everything else is the real module.
const audit = vi.hoisted(() => ({ failExport: false }));
vi.mock("@/lib/audit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...real,
    buildAuditRow: (event: Parameters<typeof real.buildAuditRow>[0]) => {
      if (audit.failExport && event.action === "report.exported") throw new Error("audit unavailable");
      return real.buildAuditRow(event);
    },
  };
});

// GET /api/reports/{id}/export end to end: the REAL route modules, REAL sessions, the REAL
// app_runtime / auth_runtime roles with row-level security, on the scratch database. Only the audit
// builder is wrapped (to force one failure). Synthetic data only. Skipped without the TEST_* variables.
vi.setConfig({ testTimeout: 180_000 });

describe.skipIf(!ENABLED)("the Word export through the real stack", () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let exporter: { GET: Handler };
  let section: { PUT: Handler };

  let orgA: string, orgB: string;
  let ownerA: Person, assocA: Person, assocA2: Person, adminA: Person, adminA2: Person;
  let ownerB: Person, assocB: Person;
  let c1: { id: string; displayName: string }; // assigned to assocA, granted to adminA
  let c2: { id: string }; // assigned to assocA2 only
  let cB: { id: string };
  let tplA: { templateId: string; promptId: string };
  let tplB: { templateId: string; promptId: string };

  const tag = () => crypto.randomUUID().slice(0, 8);
  const SECRET = "ZedExportSectionText";
  const MISSING = "99999999-9999-4999-8999-999999999999";
  const TITLES = TEMPLATE_STRUCTURE.sections.map((s) => s.title);

  const get = (who: Person, id: string, qs = "?format=docx") => h.call(who, exporter.GET, { path: `/api/reports/${id}/export${qs}`, params: { id } });
  const save = (who: Person, reportId: string, sectionId: string, body: unknown) =>
    h.call(who, section.PUT, { method: "PUT", path: `/api/reports/${reportId}/sections/${sectionId}`, body, params: { id: reportId, sectionId } });

  const seedClient = async (orgId: string, displayName: string) => (await h.owner.insert(schema.clients).values({ organizationId: orgId, displayName }).returning())[0];
  const assign = (clientId: string, user: Person, by: Person) =>
    h.owner.insert(schema.clientAssignments).values({ organizationId: user.orgId, clientId, userId: user.userId, assignedByUserId: by.userId });

  async function mkReport(orgId: string, clientId: string, creator: Person, status: typeof schema.reports.$inferSelect.status = "draft") {
    const tpl = orgId === orgA ? tplA : tplB;
    const [r] = await h.owner
      .insert(schema.reports)
      .values({ organizationId: orgId, clientId, templateId: tpl.templateId, methodologyPromptId: tpl.promptId, createdByUserId: creator.userId, status })
      .returning();
    const sections = await h.owner
      .insert(schema.reportSections)
      .values(TEMPLATE_STRUCTURE.sections.map((s, i) => ({ organizationId: orgId, reportId: r.id, sectionKey: s.key, sectionType: "prose" as const, position: i + 1 })))
      .returning();
    return { reportId: r.id, sections: sections.sort((a, b) => a.position - b.position) };
  }
  const writeVersion = (orgId: string, reportId: string, sectionId: string, versionNumber: number, text: string, by: Person | null) =>
    h.owner.insert(schema.reportVersions).values({ organizationId: orgId, reportId, sectionId, versionNumber, editType: by ? "human_edit" : "ai_generated", content: { text }, createdByUserId: by?.userId ?? null });
  /** Walks a draft report along the allowed status transitions (the database refuses any other). */
  async function moveTo(reportId: string, ...path: (typeof schema.reports.$inferSelect.status)[]) {
    for (const status of path) await h.owner.update(schema.reports).set({ status, ...(status === "finalized" ? { finalizedAt: new Date() } : {}) }).where(eq(schema.reports.id, reportId));
  }
  const exportedRows = (orgId: string, reportId?: string) =>
    h.owner.select().from(schema.auditLog).where(and(eq(schema.auditLog.organizationId, orgId), eq(schema.auditLog.action, "report.exported"))).then((rows) => rows.filter((r) => !reportId || r.resourceId === reportId));
  const auditCount = async (orgId: string, action?: string) =>
    Number((await h.owner.execute(action ? sql`select count(*)::int as n from audit_log where organization_id = ${orgId} and action = ${action}` : sql`select count(*)::int as n from audit_log where organization_id = ${orgId}`)).rows[0].n);
  const open = (bytes: Uint8Array) => {
    const parts = readZip(bytes);
    return { parts, body: plainText(parts["word/document.xml"]), header: Object.entries(parts).filter(([k]) => /^word\/header\d*\.xml$/.test(k)).map(([, v]) => plainText(v)).join("") };
  };
  async function freshExporter(label: string) {
    const p = await h.makePerson(orgA, `${label}-${tag()}`, "associate");
    await assign(c1.id, p, ownerA);
    return p;
  }

  beforeAll(async () => {
    h = await startHarness({ appRole: "app_runtime_export", authRole: "auth_runtime_export", secret: "export-test-secret-".padEnd(48, "x") });
    exporter = (await import("@/app/api/reports/[id]/export/route")) as unknown as typeof exporter;
    section = (await import("@/app/api/reports/[id]/sections/[sectionId]/route")) as unknown as typeof section;

    const nameA = `export-A-${tag()}`;
    const nameB = `export-B-${tag()}`;
    orgA = await h.seedOrg(nameA);
    orgB = await h.seedOrg(nameB);
    [ownerA, assocA, assocA2, adminA, adminA2, ownerB, assocB] = await Promise.all([
      h.makePerson(orgA, "owner-a", "owner"),
      h.makePerson(orgA, "assoc-a", "associate"),
      h.makePerson(orgA, "assoc-a2", "associate"),
      h.makePerson(orgA, "admin-a", "admin"),
      h.makePerson(orgA, "admin-a2", "admin"),
      h.makePerson(orgB, "owner-b", "owner"),
      h.makePerson(orgB, "assoc-b", "associate"),
    ]);
    for (const name of [nameA, nameB]) expect((await seedReportTemplate(h.owner.$client, { org: `Synthetic Org ${name}` }, { apply: true })).status).toBe("created");
    const tpl = async (orgId: string) => {
      const [t] = await h.owner.select().from(schema.reportTemplates).where(eq(schema.reportTemplates.organizationId, orgId));
      return { templateId: t.id, promptId: t.activeMethodologyPromptId! };
    };
    tplA = await tpl(orgA);
    tplB = await tpl(orgB);
    c1 = await seedClient(orgA, `Quentin Clientname ${tag()}`);
    c2 = await seedClient(orgA, `Second Clientname ${tag()}`);
    cB = await seedClient(orgB, `Bee Clientname ${tag()}`);
    await assign(c1.id, assocA, ownerA);
    await assign(c1.id, adminA, ownerA);
    await assign(c2.id, assocA2, ownerA);
    await assign(cB.id, assocB, ownerB);
  }, 300_000);

  afterAll(async () => {
    audit.failExport = false;
    await h?.stop();
  });

  // ---------------------------------------------------------------------------------------
  describe("the file", () => {
    it("owner and assigned associate get the exact headers and a file with each section's current text, in order, under the template's titles", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      await writeVersion(orgA, r.reportId, r.sections[0].id, 1, "model words first", null);
      expect((await save(ownerA, r.reportId, r.sections[0].id, { text: "owner edit one", baseVersion: 1 })).status).toBe(200);
      expect((await save(assocA, r.reportId, r.sections[0].id, { text: `${SECRET} current <b>text</b> & more`, baseVersion: 2 })).status).toBe(200);
      await writeVersion(orgA, r.reportId, r.sections[2].id, 1, "model text left as it is", null);
      for (const who of [ownerA, assocA]) {
        const res = await get(who, r.reportId);
        expect(res.status, who.label).toBe(200);
        expect(res.headers.get("content-type")).toBe(DOCX_CONTENT_TYPE);
        expect(res.headers.get("content-disposition")).toBe(`attachment; filename="report-${r.reportId}.docx"`);
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(Number(res.headers.get("content-length"))).toBe(res.bytes.byteLength);
        expect([...res.bytes.slice(0, 2)]).toEqual([0x50, 0x4b]); // "PK": a zip file

        const { body } = open(res.bytes);
        const at = (needle: string) => body.indexOf(needle);
        const positions = TITLES.map((t) => at(`${t}\n`));
        expect(positions.every((p) => p >= 0), who.label).toBe(true);
        expect([...positions].sort((a, b) => a - b)).toEqual(positions); // template order
        expect(body).toContain(`${SECRET} current <b>text</b> & more`); // current version, literal text
        expect(body).not.toContain("owner edit one"); // an older version
        expect(body).not.toContain("model words first");
        expect(body).toContain("model text left as it is"); // model text exports like any text
        expect(body.split(EMPTY_SECTION_LINE).length - 1).toBe(TITLES.length - 2);
      }
    });

    it("the document and the download name carry no client name, practice name, person's name or email", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      await save(ownerA, r.reportId, r.sections[0].id, { text: "plain section text", baseVersion: 0 });
      const res = await get(ownerA, r.reportId);
      const all = Object.values(open(res.bytes).parts).join("\n");
      for (const needle of [c1.displayName, "Quentin", "Clientname", "Synthetic Org", ownerA.email, assocA.email, ownerA.userId, assocA.userId, orgA, "Synthetic owner-a", c1.id, tplA.templateId]) {
        expect(all, needle).not.toContain(needle);
      }
      expect(`${res.headers.get("content-disposition")}`).not.toMatch(/Quentin|Clientname|owner|@/);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("the draft marker follows the status", () => {
    it.each([["draft", []], ["generating", ["generating"]], ["generated", ["generating", "generated"]], ["error", ["generating", "error"]]] as const)(
      "%s: the first line and the header say DRAFT, not finalized",
      async (_name, path) => {
        const r = await mkReport(orgA, c1.id, ownerA, "draft");
        await writeVersion(orgA, r.reportId, r.sections[0].id, 1, "some text", ownerA);
        await moveTo(r.reportId, ...path);
        const res = await get(ownerA, r.reportId);
        expect(res.status).toBe(200);
        const { body, header } = open(res.bytes);
        expect(body.startsWith(`${DRAFT_LINE}\n`)).toBe(true);
        expect(header).toContain(DRAFT_LINE);
      },
    );

    it("finalized: no marker anywhere in the file", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      await writeVersion(orgA, r.reportId, r.sections[0].id, 1, "final text", ownerA);
      await moveTo(r.reportId, "generating", "generated", "finalized");
      const res = await get(ownerA, r.reportId);
      expect(res.status).toBe(200);
      const { parts, body, header } = open(res.bytes);
      expect(body).toContain("final text");
      expect(body).not.toContain("DRAFT");
      expect(header).toBe("");
      for (const xml of Object.values(parts)) expect(xml).not.toContain("DRAFT");
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("who may export", () => {
    it("an admin, with or without a client grant, is refused (403, audited as a denial) and gets no file and writes no export row", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      await writeVersion(orgA, r.reportId, r.sections[0].id, 1, SECRET, ownerA);
      for (const who of [adminA, adminA2]) {
        const denied0 = await auditCount(orgA, "authz.denied");
        const exported0 = await auditCount(orgA, "report.exported");
        const res = await get(who, r.reportId);
        expect(res.status, who.label).toBe(403);
        expect(res.json.error?.code).toBe("forbidden");
        expect(res.headers.get("content-type")).toMatch(/json/);
        expect(res.text).not.toContain(SECRET);
        expect(await auditCount(orgA, "authz.denied")).toBe(denied0 + 1);
        expect(await auditCount(orgA, "report.exported")).toBe(exported0);
      }
      const rows = (await h.owner.select().from(schema.auditLog).where(and(eq(schema.auditLog.organizationId, orgA), eq(schema.auditLog.action, "authz.denied")))).filter((x) => x.actorUserId === adminA.userId);
      expect(rows.at(-1)).toMatchObject({ outcome: "denied", resourceType: "report", metadata: { role: "admin", reason: "role_not_allowed" } });
    });

    it("an unassigned associate, another practice's people and a missing id get the same 404, no file, no audit row, and spend no quota", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      await writeVersion(orgA, r.reportId, r.sections[0].id, 1, SECRET, ownerA);
      const other = await mkReport(orgA, c2.id, ownerA, "draft");
      const missing = await get(assocA2, MISSING);
      expect(missing.status).toBe(404);
      const cases: [Person, string][] = [[assocA2, r.reportId], [assocA, other.reportId], [ownerB, r.reportId], [assocB, other.reportId], [ownerB, MISSING]];
      const before = [await auditCount(orgA), await auditCount(orgB)];
      for (const [who, id] of cases) {
        const res = await get(who, id);
        expect(res.status, `${who.label} ${id}`).toBe(404);
        expect(res.text).toBe(missing.text);
        expect(res.headers.get("content-type")).toMatch(/json/);
      }
      const b = await mkReport(orgB, cB.id, ownerB, "draft");
      for (const who of [ownerA, assocA]) expect((await get(who, b.reportId)).text, who.label).toBe(missing.text);
      expect([await auditCount(orgA), await auditCount(orgB)]).toEqual(before);
    });

    it("a soft-deleted client's report is gone, and no session is a 401 that writes nothing", async () => {
      const gone = await seedClient(orgA, `Gone Clientname ${tag()}`);
      await assign(gone.id, assocA, ownerA);
      const r = await mkReport(orgA, gone.id, ownerA, "draft");
      expect((await get(assocA, r.reportId)).status).toBe(200);
      await h.owner.update(schema.clients).set({ deletedAt: new Date() }).where(eq(schema.clients.id, gone.id));
      expect((await get(assocA, r.reportId)).status).toBe(404);
      const before = await auditCount(orgA);
      const res = await h.call({ label: "nobody", orgId: orgA }, exporter.GET, { path: `/api/reports/${MISSING}/export?format=docx`, params: { id: MISSING } });
      expect(res.status).toBe(401);
      expect(await auditCount(orgA)).toBe(before);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("what is asked for", () => {
    it("format is required and must be docx; other query keys and a malformed id are 400, and nothing is written", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      const before = await auditCount(orgA);
      for (const qs of ["", "?", "?format=pdf", "?format=DOCX", "?format=", "?format=docx&x=1", "?format=docx&format=pdf", "?x=1", "?format[]=docx"]) {
        const res = await get(ownerA, r.reportId, qs);
        expect(res.status, qs).toBe(400);
        expect(res.json.error?.code, qs).toBe("validation_failed");
      }
      expect((await get(ownerA, "nope")).status).toBe(400);
      expect(await auditCount(orgA)).toBe(before);
    });

    it("the route answers GET only", async () => {
      expect(Object.keys(exporter).sort()).toEqual(["GET"]);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("the audit row", () => {
    it("one row per successful export: the report id, the actor and role, the format; never content", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      await save(ownerA, r.reportId, r.sections[0].id, { text: `${SECRET} audit check`, baseVersion: 0 });
      expect(await exportedRows(orgA, r.reportId)).toHaveLength(0);
      expect((await get(assocA, r.reportId)).status).toBe(200);
      expect((await get(ownerA, r.reportId)).status).toBe(200);
      const rows = await exportedRows(orgA, r.reportId);
      expect(rows).toHaveLength(2);
      expect(rows.map((x) => [x.actorUserId, (x.metadata as { role: string }).role]).sort()).toEqual([[assocA.userId, "associate"], [ownerA.userId, "owner"]].sort());
      for (const row of rows) {
        expect(row).toMatchObject({ action: "report.exported", resourceType: "report", resourceId: r.reportId, outcome: "success", organizationId: orgA });
        expect(Object.keys(row.metadata as object).sort()).toEqual(["format", "role"]);
        expect((row.metadata as { format: string }).format).toBe("docx");
      }
    });

    it("no export row, and no other audit row, holds section text, a title, a client name or the file name", async () => {
      const rows = await h.owner.select().from(schema.auditLog).where(eq(schema.auditLog.organizationId, orgA));
      expect((await exportedRows(orgA)).length).toBeGreaterThan(3);
      const text = JSON.stringify(rows);
      for (const needle of [SECRET, "Clientname", "Quentin", ...TITLES, ".docx", "report-", "<b>text</b>", "model text left as it is"]) expect(text, needle).not.toContain(needle);
    });

    it("fails closed: if the audit row cannot be built, the answer is a plain 500, no file leaves and no row exists", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      await writeVersion(orgA, r.reportId, r.sections[0].id, 1, SECRET, ownerA);
      const before = await auditCount(orgA, "report.exported");
      audit.failExport = true;
      let res;
      try {
        res = await get(ownerA, r.reportId);
      } finally {
        audit.failExport = false;
      }
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toMatch(/json/);
      expect(res.text).not.toContain(SECRET);
      expect(res.text).not.toMatch(/audit|unavailable|stack/i);
      expect(res.bytes.byteLength).toBeLessThan(200);
      expect(await auditCount(orgA, "report.exported")).toBe(before);
      // And it works again straight away.
      expect((await get(ownerA, r.reportId)).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("the limit", () => {
    it(`the ${MAX_EXPORTS_PER_USER + 1}st export in ten minutes is a 429 with Retry-After; other people, the other practice and refusals are unaffected`, async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      const person = await freshExporter("limit");
      // Refusals before the limit spend nothing.
      expect((await get(person, MISSING)).status).toBe(404);
      expect((await get(person, r.reportId, "?format=pdf")).status).toBe(400);
      for (let i = 0; i < MAX_EXPORTS_PER_USER; i++) expect((await get(person, r.reportId)).status, `export ${i + 1}`).toBe(200);
      const over = await get(person, r.reportId);
      expect(over.status).toBe(429);
      expect(over.json.error?.code).toBe("rate_limited");
      const wait = Number(over.headers.get("retry-after"));
      expect(wait).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(600);
      expect(over.headers.get("content-type")).toMatch(/json/);
      expect(over.bytes.byteLength).toBeLessThan(200);
      // The refusal wrote nothing, and exactly the allowed number of rows exist for this person.
      expect((await exportedRows(orgA)).filter((x) => x.actorUserId === person.userId)).toHaveLength(MAX_EXPORTS_PER_USER);
      // A missing report is a 404 for this person as for everyone (the limit is checked after visibility).
      expect((await get(person, MISSING)).status).toBe(404);
      // Others are unaffected.
      for (const who of [ownerA, assocA]) expect((await get(who, r.reportId)).status, who.label).toBe(200);
      const b = await mkReport(orgB, cB.id, ownerB, "draft");
      expect((await get(ownerB, b.reportId)).status).toBe(200);
    });

    it("a burst of simultaneous exports by one person lets exactly the limit through", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      const person = await freshExporter("burst");
      const results = await Promise.all(Array.from({ length: MAX_EXPORTS_PER_USER + 6 }, () => get(person, r.reportId)));
      expect(results.filter((x) => x.status === 200)).toHaveLength(MAX_EXPORTS_PER_USER);
      expect(results.filter((x) => x.status === 429)).toHaveLength(6);
      expect((await exportedRows(orgA)).filter((x) => x.actorUserId === person.userId)).toHaveLength(MAX_EXPORTS_PER_USER);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("nothing leaves, nothing is fetched", () => {
    it("an export makes no outbound HTTP call", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      await writeVersion(orgA, r.reportId, r.sections[0].id, 1, "x", ownerA);
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("no network during an export")));
      try {
        expect((await get(ownerA, r.reportId)).status).toBe(200);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("the response never carries a cookie or a cache directive that would let a shared cache keep it", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      const res = await get(ownerA, r.reportId);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("cache-control")).not.toMatch(/public|max-age|s-maxage/);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });
});
