import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { STATE_READS_PER_MINUTE } from "@/lib/reports/state-limits";
import { seedReportTemplate, TEMPLATE_STRUCTURE } from "@/scripts/seed-report-template.mjs";
import { ENABLED, startHarness, type Handler, type Person } from "./integration-harness";

// GET /api/reports/{id}/state (the "someone changed this section" check) end to end: the REAL
// route modules, REAL sessions, the REAL app_runtime / auth_runtime roles with row-level security,
// on the scratch database. Nothing is mocked. Synthetic data only. Skipped without the TEST_* variables.
vi.setConfig({ testTimeout: 180_000 });

describe.skipIf(!ENABLED)("the report state check through the real stack", () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let state: { GET: Handler };
  let detail: { GET: Handler };
  let section: { PUT: Handler };

  let orgA: string, orgB: string;
  let ownerA: Person, assocA: Person, assocA2: Person, adminA: Person, adminA2: Person;
  let ownerB: Person, assocB: Person;
  let c1: { id: string }; // assigned to assocA, granted to adminA
  let c2: { id: string }; // assigned to assocA2 only (adminA has no grant here)
  let cB: { id: string };
  let tplA: { templateId: string; promptId: string };
  let tplB: { templateId: string; promptId: string };

  const tag = () => crypto.randomUUID().slice(0, 8);
  const SECRET = "ZedStateSectionText";
  const MISSING = "99999999-9999-4999-8999-999999999999";
  const nameOf = (p: Person) => `Synthetic ${p.label}`;

  const check = (who: Person, id: string) => h.call(who, state.GET, { path: `/api/reports/${id}/state`, params: { id } });
  const full = (who: Person, id: string) => h.call(who, detail.GET, { path: `/api/reports/${id}`, params: { id } });
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
  const auditCount = async (orgId: string) => Number((await h.owner.execute(sql`select count(*)::int as n from audit_log where organization_id = ${orgId}`)).rows[0].n);

  /** Waits (by the database clock) until at least `seconds` remain in the current minute, so a count cannot straddle a boundary. */
  async function roomInMinute(seconds: number) {
    const left = async () => Number((await h.owner.execute(sql`select extract(epoch from (date_trunc('minute', now()) + interval '1 minute' - now()))::float8 as s`)).rows[0].s);
    const wait = await left();
    if (wait < seconds) await new Promise((r) => setTimeout(r, (wait + 0.5) * 1000));
  }
  /** A new associate who may see c1's reports, with a counter of their own. */
  async function freshReader(label: string) {
    const p = await h.makePerson(orgA, `${label}-${tag()}`, "associate");
    await assign(c1.id, p, ownerA);
    return p;
  }

  beforeAll(async () => {
    h = await startHarness({ appRole: "app_runtime_state", authRole: "auth_runtime_state", secret: "state-test-secret-".padEnd(48, "x") });
    state = (await import("@/app/api/reports/[id]/state/route")) as unknown as typeof state;
    detail = (await import("@/app/api/reports/[id]/route")) as unknown as typeof detail;
    section = (await import("@/app/api/reports/[id]/sections/[sectionId]/route")) as unknown as typeof section;

    const nameA = `state-A-${tag()}`;
    const nameB = `state-B-${tag()}`;
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
    c1 = await seedClient(orgA, `State Client One ${tag()}`);
    c2 = await seedClient(orgA, `State Client Two ${tag()}`);
    cB = await seedClient(orgB, `State Client B ${tag()}`);
    await assign(c1.id, assocA, ownerA);
    await assign(c1.id, adminA, ownerA);
    await assign(c2.id, assocA2, ownerA);
    await assign(cB.id, assocB, ownerB);
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
  });

  type S = { id: string; version: number; editType: string | null; editedAt: string | null; authorName: string | null };
  type Data = { status: string; sections: S[] };
  const SECTION_KEYS = ["authorName", "editType", "editedAt", "id", "version"];

  // ---------------------------------------------------------------------------------------
  describe("what it returns", () => {
    it("status and, per section in order, version, edit type, time and author's display name; the same facts as the full read", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      await save(ownerA, r.reportId, r.sections[0].id, { text: "one", baseVersion: 0 });
      await save(assocA, r.reportId, r.sections[0].id, { text: "two", baseVersion: 1 });
      await h.owner.insert(schema.reportVersions).values({ organizationId: orgA, reportId: r.reportId, sectionId: r.sections[1].id, versionNumber: 1, editType: "ai_generated", content: { text: "model words" }, createdByUserId: null });
      for (const who of [ownerA, assocA, adminA]) {
        const res = await check(who, r.reportId);
        expect(res.status, who.label).toBe(200);
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        expect(Object.keys(res.json).sort()).toEqual(["data"]);
        const data = res.json.data as Data;
        expect(Object.keys(data).sort()).toEqual(["sections", "status"]);
        expect(data.status).toBe("draft");
        expect(data.sections.map((s) => s.id)).toEqual(r.sections.map((s) => s.id));
        for (const s of data.sections) expect(Object.keys(s).sort()).toEqual(SECTION_KEYS);
        expect(data.sections[0]).toMatchObject({ version: 2, editType: "human_edit", authorName: nameOf(assocA) });
        expect(data.sections[1]).toMatchObject({ version: 1, editType: "ai_generated", authorName: null });
        expect(data.sections[2]).toEqual({ id: r.sections[2].id, version: 0, editType: null, editedAt: null, authorName: null });
        // The same facts the full report read gives.
        const fullData = (await full(who, r.reportId)).json.data as { status: string; sections: (S & { text: string })[] };
        expect(fullData.status).toBe(data.status);
        expect(fullData.sections.map(({ id, version, editType, editedAt, authorName }) => ({ id, version, editType, editedAt, authorName }))).toEqual(data.sections);
      }
    });

    it("a deactivated author keeps their name", async () => {
      const gone = await h.makePerson(orgA, `assoc-gone-${tag()}`, "associate");
      await assign(c1.id, gone, ownerA);
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      expect((await save(gone, r.reportId, r.sections[0].id, { text: "before leaving", baseVersion: 0 })).status).toBe(200);
      await h.owner.update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, gone.userId));
      expect(((await check(ownerA, r.reportId)).json.data as Data).sections[0].authorName).toBe(nameOf(gone));
    });

    it("no section text, title, email, user id or role is in the body, and no key beyond the documented ones", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      await save(ownerA, r.reportId, r.sections[0].id, { text: SECRET, baseVersion: 0 });
      await save(assocA, r.reportId, r.sections[0].id, { text: `${SECRET} again`, baseVersion: 1 });
      for (const who of [ownerA, assocA, adminA]) {
        const res = await check(who, r.reportId);
        const needles = [SECRET, ...TEMPLATE_STRUCTURE.sections.map((s) => s.title), ownerA.email, assocA.email, ownerA.userId, assocA.userId, orgA, r.reportId];
        for (const needle of needles.filter((n) => n !== r.reportId)) expect(res.text, `${who.label}: ${needle}`).not.toContain(needle);
        expect(res.text).not.toMatch(/"(text|title|key|email|userId|createdByUserId|role|organizationId|clientId|templateSlug|updatedAt|createdAt)"/);
      }
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("who may see which report", () => {
    it("an unassigned associate, an ungranted admin, another practice and a missing id all get the same 404", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      await save(ownerA, r.reportId, r.sections[0].id, { text: SECRET, baseVersion: 0 });
      const other = await mkReport(orgA, c2.id, ownerA, "draft");
      await save(ownerA, other.reportId, other.sections[0].id, { text: SECRET, baseVersion: 0 });
      const missing = await check(assocA2, MISSING);
      expect(missing.status).toBe(404);
      const cases: [Person, string][] = [
        [assocA2, r.reportId], // associate not assigned to c1
        [assocA, other.reportId], // associate not assigned to c2
        [adminA, other.reportId], // admin with a grant on c1 only
        [adminA2, r.reportId], // admin with no grant at all
        [ownerB, r.reportId], // another practice's owner
        [assocB, other.reportId],
      ];
      for (const [who, id] of cases) {
        const res = await check(who, id);
        expect(res.status, `${who.label} ${id}`).toBe(404);
        expect(res.text).toBe(missing.text);
        expect(res.text).not.toContain(nameOf(ownerA));
      }
      // Practice A cannot ask about practice B's report either.
      const b = await mkReport(orgB, cB.id, ownerB, "draft");
      for (const who of [ownerA, assocA, adminA]) expect((await check(who, b.reportId)).text, who.label).toBe(missing.text);
    });

    it("a report of a soft-deleted client is gone, and a malformed id is a 400", async () => {
      const gone = await seedClient(orgA, `State Gone ${tag()}`);
      await assign(gone.id, assocA, ownerA);
      const r = await mkReport(orgA, gone.id, ownerA, "draft");
      expect((await check(assocA, r.reportId)).status).toBe(200);
      await h.owner.update(schema.clients).set({ deletedAt: new Date() }).where(eq(schema.clients.id, gone.id));
      expect((await check(assocA, r.reportId)).status).toBe(404);
      expect((await check(ownerA, "nope")).status).toBe(400);
    });

    it("no session is 401 and changes nothing", async () => {
      const before = await auditCount(orgA);
      const res = await h.call({ label: "nobody", orgId: orgA }, state.GET, { path: `/api/reports/${MISSING}/state`, params: { id: MISSING } });
      expect(res.status).toBe(401);
      expect(await auditCount(orgA)).toBe(before);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("no audit row", () => {
    it("neither a successful call nor a 404 nor a 429 writes any audit row", async () => {
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      await save(ownerA, r.reportId, r.sections[0].id, { text: "x", baseVersion: 0 });
      const before = await auditCount(orgA);
      for (let i = 0; i < 5; i++) expect((await check(ownerA, r.reportId)).status).toBe(200);
      expect((await check(assocA2, r.reportId)).status).toBe(404);
      expect((await check(ownerA, MISSING)).status).toBe(404);
      expect(await auditCount(orgA)).toBe(before);
      // The full read still writes its one row, so the difference is real.
      await full(ownerA, r.reportId);
      expect(await auditCount(orgA)).toBe(before + 1);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("the limit", () => {
    it("the 121st call in a minute is a 429 with Retry-After; calls 1 to 120 were served; another person is unaffected", async () => {
      await roomInMinute(30);
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      const reader = await freshReader("limit");
      const statuses: number[] = [];
      for (let batch = 0; batch < 12; batch++) {
        statuses.push(...(await Promise.all(Array.from({ length: 10 }, () => check(reader, r.reportId)))).map((x) => x.status));
      }
      expect(statuses).toHaveLength(STATE_READS_PER_MINUTE);
      expect(statuses.every((x) => x === 200)).toBe(true);

      const over = await check(reader, r.reportId);
      expect(over.status).toBe(429);
      expect(over.json.error?.code).toBe("rate_limited");
      const wait = Number(over.headers.get("retry-after"));
      expect(wait).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(60);
      expect(over.headers.get("cache-control")).toBe("private, no-store");
      expect(Object.keys(over.json)).toEqual(["error"]);

      // The same answer for a report that does not exist or is not theirs: the limit says nothing about reports.
      const other = await mkReport(orgA, c2.id, ownerA, "draft");
      for (const id of [MISSING, other.reportId]) {
        const res = await check(reader, id);
        expect(res.status).toBe(429);
        expect(res.text).toBe(over.text);
      }
      // Other people, same practice and the other practice, are untouched, and so is the same person's full read.
      for (const who of [ownerA, assocA, adminA]) expect((await check(who, r.reportId)).status, who.label).toBe(200);
      expect((await check(ownerB, (await mkReport(orgB, cB.id, ownerB)).reportId)).status).toBe(200);
      expect((await full(reader, r.reportId)).status).toBe(200);

      // A new minute serves them again (the counter row's minute moved back by the owner connection).
      await h.owner.execute(sql`update read_limit_counters set window_start = window_start - interval '2 minutes' where user_id = ${reader.userId}`);
      expect((await check(reader, r.reportId)).status).toBe(200);
    });

    it("130 calls fired at once by one person: exactly 120 are served and 10 are refused", async () => {
      await roomInMinute(30);
      const r = await mkReport(orgA, c1.id, ownerA, "draft");
      const reader = await freshReader("burst");
      const results = await Promise.all(Array.from({ length: 130 }, () => check(reader, r.reportId)));
      expect(results.filter((x) => x.status === 200)).toHaveLength(STATE_READS_PER_MINUTE);
      expect(results.filter((x) => x.status === 429)).toHaveLength(10);
      const [row] = await h.owner.select().from(schema.readLimitCounters).where(and(eq(schema.readLimitCounters.userId, reader.userId), eq(schema.readLimitCounters.key, "report_state")));
      expect(row.count).toBe(STATE_READS_PER_MINUTE + 1);
    });

    it("keeps exactly one counter row per person however many calls, and the 429s do not grow it", async () => {
      const rows = await h.owner.select().from(schema.readLimitCounters).where(eq(schema.readLimitCounters.organizationId, orgA));
      const perUser = new Map<string, number>();
      for (const row of rows) perUser.set(row.userId, (perUser.get(row.userId) ?? 0) + 1);
      expect([...perUser.values()].every((n) => n === 1)).toBe(true);
      expect(rows.every((row) => row.count <= STATE_READS_PER_MINUTE + 1)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("cost", () => {
    it("the number of statements does not depend on how many sections were written, with one author lookup at most", async () => {
      const one = await mkReport(orgA, c1.id, ownerA, "draft");
      await save(ownerA, one.reportId, one.sections[0].id, { text: "x", baseVersion: 0 });
      const many = await mkReport(orgA, c1.id, ownerA, "draft");
      for (const [i, sec] of many.sections.entries()) await save(i % 2 ? assocA : ownerA, many.reportId, sec.id, { text: `s${i}`, baseVersion: 0 });
      const none = await mkReport(orgA, c1.id, ownerA, "draft");
      const modelOnly = await mkReport(orgA, c1.id, ownerA, "draft");
      await h.owner.insert(schema.reportVersions).values({ organizationId: orgA, reportId: modelOnly.reportId, sectionId: modelOnly.sections[0].id, versionNumber: 1, editType: "ai_generated", content: { text: "m" }, createdByUserId: null });

      const run = (id: string) => h.statementsOf(() => check(ownerA, id));
      // The session check reads `users` too; the author lookup is the one that selects by a list of ids.
      const lookups = (qs: string[]) => qs.filter((q) => /from "users"/.test(q) && /"users"\."id" in \(/.test(q)).length;
      const [sOne, sMany, sNone, sModel] = [await run(one.reportId), await run(many.reportId), await run(none.reportId), await run(modelOnly.reportId)];
      expect(sOne.length).toBe(sMany.length);
      expect(lookups(sMany)).toBe(1);
      expect(lookups(sOne)).toBe(1);
      expect(lookups(sNone)).toBe(0);
      expect(lookups(sModel)).toBe(0);
      expect(sNone.length).toBe(sOne.length - 1);
      // The section text is never read from the database for this answer.
      const versionReads = sMany.filter((q) => /from "report_versions"/.test(q));
      expect(versionReads).toHaveLength(1);
      expect(versionReads[0]).not.toContain('"content"');
      expect((await h.statementsOf(() => full(ownerA, many.reportId))).filter((q) => /from "report_versions"/.test(q)).some((q) => q.includes('"content"'))).toBe(true);
      // Cheaper than the full read: no template, no text in the answer (the version rows are still read).
      const fullStatements = await h.statementsOf(() => full(ownerA, many.reportId));
      expect(sMany.length).toBeLessThan(fullStatements.length);
    });
  });
});
