import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import { GENERATION_LEASE_SECONDS, MAX_CONCURRENT_GENERATIONS, MAX_STARTS_PER_ORGANIZATION, MAX_STARTS_PER_USER } from "@/lib/reports/generation-limits";
import { seedReportTemplate, TEMPLATE_STRUCTURE } from "@/scripts/seed-report-template.mjs";
import { ENABLED, startHarness, type Handler, type Person } from "./integration-harness";

// Regenerate a section, and generate more than one section per report (migration 0017), end to end: the REAL
// route modules, REAL Better Auth sessions, the REAL app_runtime / auth_runtime roles with row-level security
// and the status triggers, on the scratch database. The ONLY thing replaced is the model: outbound requests to
// the practice's *.ts.net address are answered, in order, by a scripted fake (a stub of global fetch that also
// records everything sent). No Ollama is involved. Synthetic data only; every "methodology" row is clearly fake.
//
// Both modes are covered: real (three passes, with the thin-notes warning) and stub.
//
// Needs the TEST_* variables (see lib/auth/integration-harness.ts); skipped when absent.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 600_000 });

const ENDPOINT = "https://fake-box.synthtail.ts.net";
const SLUG = "psychoeducational-evaluation";
// Text that must never appear where it does not belong.
const NOTES_MARK = "ZNOTE-7731";
const NOTES = `${NOTES_MARK} Synthetic notes: the child stayed seated for the whole task and said "I like blocks 4821".`;
const MODEL_TEXT = "Zed regenerated section text 5512";
const OLD_AI = "ZOLD-AI-9914 the first version the model wrote";
const OLD_HUMAN = "ZOLD-HUMAN-3307 text a psychologist typed by hand";
const METH_TWO = "SYNTHMETH-TWO fake methodology block, pinned by the reports";

type Outbound = { url: string; headers: Headers; body: Record<string, unknown> & { messages: { role: string; content: string }[] }; model: string };
type Plan = (call: Outbound) => Response | Promise<Response>;

function completion(content: string) {
  return { id: "chatcmpl-1", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
}
const reply =
  (content: string): Plan =>
  () =>
    new Response(JSON.stringify(completion(content)), { status: 200, headers: { "content-type": "application/json" } });
const answer = (value: unknown) => reply(JSON.stringify(value));

const FILTER_OK = { template: SLUG, sufficient: true, sensitive_content_detected: false, missing_fields: [] as string[] };
const EXTRACT_OK = { observations: [`Zed extracted observation 6620`], test_scores: [], quotes: [], family_context: [] };
const GENERATE_OK = { content: MODEL_TEXT, flags: [] as string[] };
const filterPlan = (o: Partial<typeof FILTER_OK> = {}) => answer({ ...FILTER_OK, ...o });
const happy = (): Plan[] => [filterPlan(), answer(EXTRACT_OK), answer(GENERATE_OK)];
const THIN = { sufficient: false, missing_fields: ["observations"], sensitive_content_detected: false };

describe.skipIf(!ENABLED)("regenerate a section, and more than one section per report, through the real stack", () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let generate: { POST: Handler };
  let detail: { GET: Handler };

  type Practice = {
    orgId: string;
    owner: Person;
    assoc: Person;
    assoc2: Person;
    admin: Person;
    tpl: { templateId: string; pinnedPromptId: string };
    c1: { id: string };
  };

  const tag = () => crypto.randomUUID().slice(0, 8);
  const mode = (m: "real" | "stub") => {
    getEnv().INFERENCE_MODE = m;
    expect(getEnv().INFERENCE_MODE).toBe(m);
  };

  // ---- the scripted fake model --------------------------------------------------------------
  const outbound: Outbound[] = [];
  const elsewhere: string[] = [];
  const consoleOut: string[] = [];
  let queue: Plan[] = [];
  const realFetch = globalThis.fetch;
  const script = (...plans: Plan[]) => {
    queue = [...plans];
  };
  beforeAll(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).hostname.endsWith(".ts.net")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Outbound["body"];
        const call: Outbound = { url, headers: new Headers(init?.headers), body, model: String(body.model) };
        outbound.push(call);
        const next = queue.shift();
        if (!next) return new Response("no scripted answer", { status: 500 });
        return next(call);
      }
      elsewhere.push(new URL(url).hostname);
      return realFetch(input, init);
    });
    for (const level of ["error", "warn", "log"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void consoleOut.push(args.map(String).join(" ")));
  });
  beforeEach(() => {
    outbound.length = 0;
    elsewhere.length = 0;
    consoleOut.length = 0;
    queue = [];
  });

  // ---- helpers ------------------------------------------------------------------------------
  type Body = Record<string, unknown>;
  const gen = (who: Person, reportId: string, sectionId: string, body: Body | string | null = { notes: NOTES }, o: { origin?: string | null } = {}) =>
    h.call(who, generate.POST, {
      method: "POST",
      path: `/api/reports/${reportId}/sections/${sectionId}/generate`,
      params: { id: reportId, sectionId },
      ...(body === null ? {} : { body: typeof body === "string" ? undefined : body, rawBody: typeof body === "string" ? body : undefined }),
      ...o,
    });
  const get = (who: Person, id: string) => h.call(who, detail.GET, { path: `/api/reports/${id}`, params: { id } });
  const assign = (orgId: string, clientId: string, user: Person, by: Person) =>
    h.owner.insert(schema.clientAssignments).values({ organizationId: orgId, clientId, userId: user.userId, assignedByUserId: by.userId });

  type MadeReport = { reportId: string; sections: (typeof schema.reportSections.$inferSelect)[] };
  async function mkReport(
    p: Practice,
    o: { status?: typeof schema.reports.$inferSelect.status; statusBefore?: "draft" | "error" | "generated"; updatedAt?: Date; sectionType?: "prose" | "structured" } = {},
  ): Promise<MadeReport> {
    const status = o.status ?? "generated";
    const [r] = await h.owner
      .insert(schema.reports)
      .values({
        organizationId: p.orgId,
        clientId: p.c1.id,
        templateId: p.tpl.templateId,
        methodologyPromptId: p.tpl.pinnedPromptId,
        createdByUserId: p.owner.userId,
        status,
        statusBeforeGeneration: o.statusBefore ?? null,
        finalizedAt: status === "finalized" ? new Date() : null,
        ...(o.updatedAt ? { updatedAt: o.updatedAt } : {}),
      })
      .returning();
    const sections = await h.owner
      .insert(schema.reportSections)
      .values(TEMPLATE_STRUCTURE.sections.map((s, i) => ({ organizationId: p.orgId, reportId: r.id, sectionKey: s.key, sectionType: o.sectionType ?? ("prose" as const), position: i + 1 })))
      .returning();
    return { reportId: r.id, sections: sections.sort((a, b) => a.position - b.position) };
  }
  /** A version written the way the app writes one (the owner connection may insert, never change, version rows). */
  const seedVersion = (p: Practice, r: MadeReport, index: number, versionNumber: number, editType: "ai_generated" | "human_edit" | "ai_regenerated_section", text: string) =>
    h.owner.insert(schema.reportVersions).values({
      organizationId: p.orgId,
      reportId: r.reportId,
      sectionId: r.sections[index].id,
      versionNumber,
      editType,
      content: { text },
      createdByUserId: editType === "human_edit" ? p.owner.userId : null,
    });
  const versionRows = (sectionId: string) => h.owner.select().from(schema.reportVersions).where(eq(schema.reportVersions.sectionId, sectionId)).orderBy(asc(schema.reportVersions.versionNumber));
  const reportRow = async (id: string) => (await h.owner.select().from(schema.reports).where(eq(schema.reports.id, id)))[0];
  const auditRows = (orgId: string, action: string) => h.owner.select().from(schema.auditLog).where(and(eq(schema.auditLog.organizationId, orgId), eq(schema.auditLog.action, action)));
  const allAudit = (orgId: string) => h.owner.select().from(schema.auditLog).where(eq(schema.auditLog.organizationId, orgId));
  const rowsFor = async (orgId: string, action: string, reportId: string) => (await auditRows(orgId, action)).filter((a) => a.resourceId === reportId);
  const starts = async (orgId: string) => (await auditRows(orgId, "report.generation_started")).length;
  const texts = (rows: { content: unknown }[]) => rows.map((v) => (v.content as { text: string }).text);

  async function makePractice(label: string, o: { lean?: boolean } = {}): Promise<Practice> {
    const name = `regen-${label}-${tag()}`;
    const orgId = await h.seedOrg(name);
    const missing = undefined as unknown as Person;
    const [owner, assoc, assoc2, admin] = await Promise.all([
      h.makePerson(orgId, `${label}-owner`, "owner"),
      h.makePerson(orgId, `${label}-assoc`, "associate"),
      o.lean ? missing : h.makePerson(orgId, `${label}-assoc2`, "associate"),
      o.lean ? missing : h.makePerson(orgId, `${label}-admin`, "admin"),
    ]);
    expect((await seedReportTemplate(h.owner.$client, { org: `Synthetic Org ${name}` }, { apply: true })).status).toBe("created");
    const [t] = await h.owner.select().from(schema.reportTemplates).where(eq(schema.reportTemplates.organizationId, orgId));
    const [pinned] = await h.owner
      .insert(schema.methodologyPrompts)
      .values({
        organizationId: orgId,
        templateId: t.id,
        versionNumber: 2,
        content: { role: `${METH_TWO} role text`, methodology: `${METH_TWO} methodology text`, constraints: `${METH_TWO} constraints text` },
        notes: "synthetic test version",
        createdByUserId: owner.userId,
      })
      .returning();
    await h.owner.update(schema.reportTemplates).set({ activeMethodologyPromptId: pinned.id }).where(eq(schema.reportTemplates.id, t.id));
    await h.owner.update(schema.organizations).set({ inferenceEndpoint: ENDPOINT }).where(eq(schema.organizations.id, orgId));
    const [c1] = await h.owner
      .insert(schema.clients)
      .values({ organizationId: orgId, displayName: `Synthetic Client ${tag()}`, dateOfBirth: "2016-04-02", gradeLevel: "3", externalId: `EXT-${tag()}` })
      .returning();
    await assign(orgId, c1.id, assoc, owner);
    if (!o.lean) await assign(orgId, c1.id, admin, owner);
    return { orgId, owner, assoc, assoc2, admin, tpl: { templateId: t.id, pinnedPromptId: pinned.id }, c1 };
  }

  async function seedStarts(orgId: string, n: number, o: { actor?: string } = {}) {
    await h.owner.insert(schema.auditLog).values(
      Array.from({ length: n }, () => ({
        organizationId: orgId,
        actorUserId: o.actor ?? crypto.randomUUID(),
        action: "report.generation_started",
        resourceType: "report_generation",
        resourceId: crypto.randomUUID(),
        metadata: { role: "owner" },
      })),
    );
  }

  /** What must not appear in a response, an audit row, stored metadata or a console line. */
  const SECRETS = [NOTES_MARK, "I like blocks 4821", "Zed extracted observation", METH_TWO, "SYNTHMETH", "ZOLD-AI", "ZOLD-HUMAN", "fake-box", "synthtail", "ts.net", "Authorization"];
  const expectClean = (what: string, text: string) => {
    for (const needle of SECRETS) expect(text, `${what} must not contain ${needle}`).not.toContain(needle);
  };
  /** The model never sees the text being replaced: a regenerate runs from the notes alone. */
  const expectOldTextNotSent = () => {
    for (const call of outbound) {
      const sent = call.body.messages.map((m) => m.content).join("\n");
      expect(sent).not.toContain("ZOLD-");
    }
  };

  beforeAll(async () => {
    h = await startHarness({ appRole: "app_runtime_regen", authRole: "auth_runtime_regen", secret: "regenerate-test-secret-".padEnd(48, "x") });
    generate = (await import("@/app/api/reports/[id]/sections/[sectionId]/generate/route")) as unknown as typeof generate;
    detail = (await import("@/app/api/reports/[id]/route")) as unknown as typeof detail;
  }, 600_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await h?.stop();
  });

  // Each person may start 10 generations per 10 minutes and a practice 30, and a thin-notes warning is a start
  // too, so every group below has a practice of its own and stays under those numbers.

  // ---------------------------------------------------------------------------------------
  describe("real mode: another section, and a regenerate, on a generated report", () => {
    let P: Practice;
    beforeAll(async () => {
      mode("real");
      P = await makePractice("regen");
    });

    it("a second EMPTY section of a generated report is generated: version 1, ai_generated, the report stays generated; the rows say where the run started", async () => {
      const r = await mkReport(P);
      script(...happy());
      const res = await gen(P.owner, r.reportId, r.sections[1].id);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ data: { outcome: "generated", reportStatus: "generated", section: { id: r.sections[1].id, version: 1, editType: "ai_generated", text: MODEL_TEXT }, flags: [] } });
      expect(await versionRows(r.sections[1].id)).toHaveLength(1);
      expect((await reportRow(r.reportId)).status).toBe("generated");
      expect((await reportRow(r.reportId)).statusBeforeGeneration).toBeNull();
      const [started] = await rowsFor(P.orgId, "report.generation_started", r.reportId);
      expect(started.metadata).toEqual({ role: "owner", mode: "real", from_status: "generated" });
      const [version] = await versionRows(r.sections[1].id);
      const [done] = (await auditRows(P.orgId, "report.generated")).filter((a) => a.resourceId === version.id);
      expect(done.metadata).toMatchObject({ mode: "real", from_status: "generated" });
      expectClean("response", res.text);
    });

    it("an AI section is regenerated: a NEW version baseVersion + 1 (ai_regenerated_section), the old one stays, the audit row says regenerated, the model never sees the old text", async () => {
      const r = await mkReport(P);
      await seedVersion(P, r, 0, 1, "ai_generated", OLD_AI);
      script(...happy());
      const res = await gen(P.assoc, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 1 });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ data: { outcome: "generated", reportStatus: "generated", section: { id: r.sections[0].id, version: 2, editType: "ai_regenerated_section", text: MODEL_TEXT }, flags: [] } });

      const rows = await versionRows(r.sections[0].id);
      expect(rows.map((v) => [v.versionNumber, v.editType])).toEqual([
        [1, "ai_generated"],
        [2, "ai_regenerated_section"],
      ]);
      expect(texts(rows)).toEqual([OLD_AI, MODEL_TEXT]);
      expect(rows[1]).toMatchObject({ createdByUserId: null, organizationId: P.orgId });
      expect(rows[1].llmMetadata).toMatchObject({ mode: "real", methodologyPromptId: P.tpl.pinnedPromptId, costUsd: 0 });
      expect((await reportRow(r.reportId)).status).toBe("generated");

      // Audit: regenerated, not generated, for that version; from_status is a record only.
      expect((await auditRows(P.orgId, "report.generated")).filter((a) => a.resourceId === rows[1].id)).toHaveLength(0);
      const [done] = (await auditRows(P.orgId, "report.regenerated")).filter((a) => a.resourceId === rows[1].id);
      expect(done).toMatchObject({ actorUserId: P.assoc.userId, resourceType: "report_version", outcome: "success", metadata: { role: "associate", mode: "real", model: "qwen3:8b", from_status: "generated" } });
      expect(Object.keys(done.metadata as object).sort()).toEqual(["from_status", "input_tokens", "latency_ms", "mode", "model", "output_tokens", "role"]);

      expect(outbound).toHaveLength(3);
      expectOldTextNotSent();
      expectClean("response", res.text);
      expectClean("audit log", JSON.stringify(await allAudit(P.orgId)));
      expectClean("llm_metadata", JSON.stringify(rows[1].llmMetadata));
      expectClean("console", consoleOut.join("\n"));

      // The report read shows the new text, version and edit type.
      const shown = (await get(P.owner, r.reportId)).json.data as { sections: { id: string; text: string; version: number; editType: string | null }[] };
      expect(shown.sections.find((x) => x.id === r.sections[0].id)).toMatchObject({ text: MODEL_TEXT, version: 2, editType: "ai_regenerated_section" });
    });

    it("a section a PERSON edited needs replaceEdited: without it a question is asked, with no model call, no quota and no write", async () => {
      const r = await mkReport(P);
      await seedVersion(P, r, 0, 1, "human_edit", OLD_HUMAN);
      const before = await reportRow(r.reportId);
      const startsBefore = await starts(P.orgId);
      script(...happy());
      const res = await gen(P.owner, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 1 });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ data: { outcome: "needs_confirmation", reason: "edited_text", reportStatus: "generated" } });
      expect(outbound).toHaveLength(0);
      expect(await starts(P.orgId)).toBe(startsBefore);
      expect(await rowsFor(P.orgId, "report.generation_warned", r.reportId)).toHaveLength(0);
      const after = await reportRow(r.reportId);
      expect(after.status).toBe("generated");
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(texts(await versionRows(r.sections[0].id))).toEqual([OLD_HUMAN]);
      expectClean("response", res.text);

      // `confirm` (thin notes) is a different question: it does not stand for this one.
      const alone = await gen(P.owner, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 1, confirm: true });
      expect(alone.json.data).toMatchObject({ outcome: "needs_confirmation", reason: "edited_text" });
      expect(outbound).toHaveLength(0);

      // With replaceEdited it goes ahead; the person's text stays in the history.
      const yes = await gen(P.owner, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 1, replaceEdited: true });
      expect(yes.status).toBe(200);
      expect(yes.json.data).toMatchObject({ outcome: "generated", section: { version: 2, editType: "ai_regenerated_section", text: MODEL_TEXT } });
      expect(texts(await versionRows(r.sections[0].id))).toEqual([OLD_HUMAN, MODEL_TEXT]);
      expect((await versionRows(r.sections[0].id))[0].editType).toBe("human_edit");
      expectOldTextNotSent();
    });

    it("only the LATEST version counts: an AI regenerate above an earlier edit of a person needs no confirmation", async () => {
      const r = await mkReport(P);
      await seedVersion(P, r, 0, 1, "human_edit", OLD_HUMAN);
      await seedVersion(P, r, 0, 2, "ai_regenerated_section", OLD_AI);
      script(...happy());
      const res = await gen(P.assoc, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 2 });
      expect(res.json.data).toMatchObject({ outcome: "generated", section: { version: 3, editType: "ai_regenerated_section" } });
      expect(texts(await versionRows(r.sections[0].id))).toEqual([OLD_HUMAN, OLD_AI, MODEL_TEXT]);
    });

    it("the two questions are independent: replaceEdited with thin notes still warns (nothing touched); confirm too, and it goes ahead", async () => {
      const r = await mkReport(P);
      await seedVersion(P, r, 0, 1, "human_edit", OLD_HUMAN);
      const before = await reportRow(r.reportId);
      script(filterPlan(THIN));
      const warn = await gen(P.owner, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 1, replaceEdited: true });
      expect(warn.status).toBe(200);
      expect(warn.json).toEqual({ data: { outcome: "needs_confirmation", reason: "thin_notes", reportStatus: "generated", missing: ["observations"], sensitive: false } });
      expect(outbound).toHaveLength(1);
      const after = await reportRow(r.reportId);
      expect(after.status).toBe("generated");
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(texts(await versionRows(r.sections[0].id))).toEqual([OLD_HUMAN]);
      const [warned] = await rowsFor(P.orgId, "report.generation_warned", r.reportId);
      expect(warned.metadata).toMatchObject({ mode: "real", from_status: "generated", missing: "observations" });

      outbound.length = 0;
      script(filterPlan(THIN), answer(EXTRACT_OK), answer({ content: `Some text. [Please provide]`, flags: ["insufficient_input"] }));
      const go = await gen(P.owner, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 1, replaceEdited: true, confirm: true });
      expect(go.json.data).toMatchObject({ outcome: "generated", section: { version: 2, editType: "ai_regenerated_section" }, flags: ["insufficient_input"] });
      expect((await reportRow(r.reportId)).status).toBe("generated");
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("real mode: what is refused, and the version the person saw", () => {
    let G: Practice;
    beforeAll(async () => {
      mode("real");
      G = await makePractice("guards", { lean: true });
    });
    const nothingChanged = async (r: MadeReport, status: string, before: number) => {
      expect(outbound).toHaveLength(0);
      expect((await reportRow(r.reportId)).status).toBe(status);
      expect(await starts(G.orgId)).toBe(before);
    };

    it("a stale baseVersion is 409 with no call, no quota and nothing stored: 0 on a section with text, behind, ahead", async () => {
      const r = await mkReport(G);
      await seedVersion(G, r, 0, 1, "ai_generated", OLD_AI);
      await seedVersion(G, r, 0, 2, "human_edit", OLD_HUMAN);
      const before = await starts(G.orgId);
      script(...happy());
      for (const body of [{ notes: NOTES }, { notes: NOTES, baseVersion: 0 }, { notes: NOTES, baseVersion: 1 }, { notes: NOTES, baseVersion: 3 }, { notes: NOTES, baseVersion: 1, replaceEdited: true }]) {
        const res = await gen(G.owner, r.reportId, r.sections[0].id, body);
        expect(res.status, JSON.stringify(body)).toBe(409);
        expect(res.json.error?.code).toBe("conflict");
      }
      // An empty section is only ever version 0.
      expect((await gen(G.owner, r.reportId, r.sections[1].id, { notes: NOTES, baseVersion: 1 })).status).toBe(409);
      await nothingChanged(r, "generated", before);
      expect(texts(await versionRows(r.sections[0].id))).toEqual([OLD_AI, OLD_HUMAN]);
      expect(await versionRows(r.sections[1].id)).toHaveLength(0);
    });

    it("text on a draft or an error report is never regenerated (409, even at the right version); a finalized report and a live generating one are 409", async () => {
      const before = await starts(G.orgId);
      for (const status of ["draft", "error", "finalized", "generating"] as const) {
        outbound.length = 0;
        // A finalized report accepts no new version, so the text goes in first and the report is closed after.
        const r = await mkReport(G, { status: status === "finalized" ? "generated" : status });
        await seedVersion(G, r, 0, 1, "human_edit", OLD_HUMAN);
        if (status === "finalized") await h.owner.update(schema.reports).set({ status: "finalized", finalizedAt: new Date() }).where(eq(schema.reports.id, r.reportId));
        script(...happy());
        const res = await gen(G.owner, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 1, replaceEdited: true });
        expect(res.status, status).toBe(409);
        expect(res.json.error?.code).toBe("conflict");
        expect(outbound, `${status}: refused before any model call`).toHaveLength(0);
        expect((await reportRow(r.reportId)).status, status).toBe(status);
        expect(texts(await versionRows(r.sections[0].id))).toEqual([OLD_HUMAN]);
        // An EMPTY section: a finalized or generating report refuses it too; a draft or error report generates it as before.
        const empty = await gen(G.owner, r.reportId, r.sections[1].id, { notes: NOTES });
        expect(empty.status === 409, status).toBe(status === "finalized" || status === "generating");
        expect((await reportRow(r.reportId)).status, status).toBe(status === "draft" || status === "error" ? "generated" : status);
      }
      // The two non-refusals above (an empty section of a draft or error report) are first generations as before: only those spent a start.
      expect(await starts(G.orgId)).toBe(before + 2);
      for (const id of (await h.owner.select().from(schema.reports).where(eq(schema.reports.organizationId, G.orgId))).filter((x) => x.status === "generating").map((x) => x.id)) {
        await h.owner.update(schema.reports).set({ status: "error" }).where(eq(schema.reports.id, id));
      }
    });

    it("a structured section is refused", async () => {
      const r = await mkReport(G, { sectionType: "structured" });
      const before = await starts(G.orgId);
      script(...happy());
      expect((await gen(G.owner, r.reportId, r.sections[0].id)).status).toBe(409);
      await nothingChanged(r, "generated", before);
    });

    it("the body is strict in real mode: unknown keys, a bad baseVersion, a bad replaceEdited and no notes are 400 with no call", async () => {
      const r = await mkReport(G);
      const before = await starts(G.orgId);
      const bad: unknown[] = [
        { notes: NOTES, extra: 1 },
        { notes: NOTES, baseVersion: -1 },
        { notes: NOTES, baseVersion: 1.5 },
        { notes: NOTES, baseVersion: "1" },
        { notes: NOTES, baseVersion: null },
        { notes: NOTES, baseVersion: 1_000_001 },
        { notes: NOTES, replaceEdited: "yes" },
        { notes: NOTES, confirm: 1 },
        { baseVersion: 0 },
        { notes: "   " },
      ];
      for (const body of bad) expect((await gen(G.owner, r.reportId, r.sections[0].id, body as Body)).status, JSON.stringify(body)).toBe(400);
      await nothingChanged(r, "generated", before);
    });

    it("a section that moves on WHILE the filter works: 409 at the claim, one call only, the report was never touched, the person's save stays", async () => {
      const r = await mkReport(G);
      await seedVersion(G, r, 0, 1, "ai_generated", OLD_AI);
      const before = await starts(G.orgId);
      script(async () => {
        // A person saves this very section while the filter "works" (the report is still generated, so saving is allowed).
        await seedVersion(G, r, 0, 2, "human_edit", OLD_HUMAN);
        return filterPlan()(undefined as never);
      });
      const res = await gen(G.owner, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 1 });
      expect(res.status).toBe(409);
      expect(res.json.error?.code).toBe("conflict");
      expect(outbound).toHaveLength(1);
      expect((await reportRow(r.reportId)).status).toBe("generated");
      expect(texts(await versionRows(r.sections[0].id))).toEqual([OLD_AI, OLD_HUMAN]);
      expect(await starts(G.orgId)).toBe(before + 1);
    });

    it("a finalize that wins while the filter works: the claim is refused (409), the report stays finalized and nothing is stored", async () => {
      const r = await mkReport(G);
      await seedVersion(G, r, 0, 1, "ai_generated", OLD_AI);
      script(async () => {
        await h.owner.update(schema.reports).set({ status: "finalized", finalizedAt: new Date() }).where(eq(schema.reports.id, r.reportId));
        return filterPlan()(undefined as never);
      });
      const res = await gen(G.owner, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 1 });
      expect(res.status).toBe(409);
      expect(res.json.error?.code).toBe("conflict");
      expect(outbound).toHaveLength(1);
      expect((await reportRow(r.reportId)).status).toBe("finalized");
      expect(texts(await versionRows(r.sections[0].id))).toEqual([OLD_AI]);
    });

    it("a section that moves on AFTER the claim (during extract): nothing of ours is stored, the report goes back to generated, the failure row says stale", async () => {
      const r = await mkReport(G);
      await seedVersion(G, r, 0, 1, "ai_generated", OLD_AI);
      script(filterPlan(), async () => {
        // The report is generating now; this models a save that got in after a reclaim, the only way one can.
        await seedVersion(G, r, 0, 2, "human_edit", OLD_HUMAN);
        return answer(EXTRACT_OK)(undefined as never);
      }, answer(GENERATE_OK));
      const res = await gen(G.assoc, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 1 });
      expect(res.status).toBe(409);
      expect(res.json.error?.code).toBe("conflict");
      expect(outbound).toHaveLength(3);
      const row = await reportRow(r.reportId);
      expect(row.status).toBe("generated");
      expect(row.statusBeforeGeneration).toBeNull();
      expect(texts(await versionRows(r.sections[0].id))).toEqual([OLD_AI, OLD_HUMAN]);
      const failed = await rowsFor(G.orgId, "report.generation_failed", r.reportId);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ outcome: "failure", metadata: { reason: "stale", mode: "real", from_status: "generated" } });
      expect(await rowsFor(G.orgId, "report.regenerated", r.reportId)).toHaveLength(0);
    });

    it("the concurrency cap is checked at the claim for a regenerate too: 429, the report untouched, still generated", async () => {
      const r = await mkReport(G);
      await seedVersion(G, r, 0, 1, "ai_generated", OLD_AI);
      const others: string[] = [];
      script(async () => {
        for (let i = 0; i < MAX_CONCURRENT_GENERATIONS; i++) others.push((await mkReport(G, { status: "generating" })).reportId);
        return filterPlan()(undefined as never);
      });
      const res = await gen(G.owner, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 1 });
      expect(res.status).toBe(429);
      expect(res.json.error?.code).toBe("rate_limited");
      expect(outbound).toHaveLength(1);
      expect((await reportRow(r.reportId)).status).toBe("generated");
      expect(texts(await versionRows(r.sections[0].id))).toEqual([OLD_AI]);
      for (const id of others) await h.owner.update(schema.reports).set({ status: "error" }).where(eq(schema.reports.id, id));
    });

    it("nothing from the notes, the model or the old text reached the audit log or the console across all of the above", async () => {
      expectClean("audit log", JSON.stringify(await allAudit(G.orgId)));
      expectClean("console", consoleOut.join("\n"));
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("real mode: a failed or abandoned run returns the report to where it started", () => {
    let F: Practice;
    beforeAll(async () => {
      mode("real");
      F = await makePractice("fail");
    });

    it("a malformed answer twice in generate (after the claim) on a GENERATED report: back to generated, old text and versions intact, one failure row with from_status", async () => {
      const r = await mkReport(F);
      await seedVersion(F, r, 0, 1, "ai_generated", OLD_AI);
      script(filterPlan(), answer(EXTRACT_OK), reply("not json Zed-secret-1"), reply('{"content": 5}'));
      const res = await gen(F.owner, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 1 });
      expect(res.status).toBe(502);
      expect(res.json.error?.code).toBe("inference_failed");
      expect(res.text).not.toContain("Zed-secret-1");
      expectClean("response", res.text);
      expect(outbound).toHaveLength(4);
      const row = await reportRow(r.reportId);
      expect(row.status).toBe("generated");
      expect(row.statusBeforeGeneration).toBeNull();
      expect(texts(await versionRows(r.sections[0].id))).toEqual([OLD_AI]);
      const failed = await rowsFor(F.orgId, "report.generation_failed", r.reportId);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ outcome: "failure", actorUserId: F.owner.userId, metadata: { reason: "invalid_output", role: "owner", mode: "real", from_status: "generated" } });
      // The report is not left looking failed: it can be finalized or regenerated straight away.
      outbound.length = 0;
      script(...happy());
      expect((await gen(F.owner, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 1 })).json.data).toMatchObject({ outcome: "generated", section: { version: 2 } });
    });

    it.each([
      ["unreachable", () => Promise.reject(new TypeError("fetch failed")), 502, "unreachable"],
      ["timeout", () => Promise.reject(new DOMException("The operation timed out", "TimeoutError")), 504, "timeout"],
      ["a 500 answer", () => new Response("internal secret detail Zed-secret-2", { status: 500 }), 502, "bad_response"],
    ] as [string, Plan, number, string][])("the endpoint fails in extract (%s) on a generated report: generated again, text intact, a fixed code, no detail", async (_label, failing, status, reason) => {
      const r = await mkReport(F);
      await seedVersion(F, r, 0, 1, "human_edit", OLD_HUMAN);
      script(filterPlan(), failing);
      const res = await gen(F.assoc, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 1, replaceEdited: true });
      expect(res.status).toBe(status);
      expect(res.text).not.toMatch(/secret detail|Zed-secret|fetch failed|fake-box|qwen/i);
      expect(outbound).toHaveLength(2); // never retried elsewhere: one endpoint, no fallback
      expect(elsewhere).toEqual([]);
      expect((await reportRow(r.reportId)).status).toBe("generated");
      expect(texts(await versionRows(r.sections[0].id))).toEqual([OLD_HUMAN]);
      expect((await rowsFor(F.orgId, "report.generation_failed", r.reportId))[0].metadata).toMatchObject({ reason, mode: "real", from_status: "generated" });
    });

    it("a failure BEFORE the claim (the filter answers badly twice) leaves a generated report exactly as it was, with one failure row", async () => {
      const r = await mkReport(F);
      await seedVersion(F, r, 0, 1, "ai_generated", OLD_AI);
      const before = await reportRow(r.reportId);
      script(reply("nope"), reply("still nope"));
      const res = await gen(F.owner, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 1 });
      expect(res.status).toBe(502);
      const after = await reportRow(r.reportId);
      expect(after.status).toBe("generated");
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(texts(await versionRows(r.sections[0].id))).toEqual([OLD_AI]);
      const failed = await rowsFor(F.orgId, "report.generation_failed", r.reportId);
      expect(failed).toHaveLength(1);
      expect(failed[0].metadata).toMatchObject({ reason: "invalid_output", mode: "real", from_status: "generated" });
    });

    it("a run that started from DRAFT still ends in error, as before (with from_status draft); an ERROR report ends in error", async () => {
      for (const from of ["draft", "error"] as const) {
        const r = await mkReport(F, { status: from });
        script(filterPlan(), answer(EXTRACT_OK), reply("bad"), reply("bad"));
        expect((await gen(F.owner, r.reportId, r.sections[0].id)).status).toBe(502);
        const row = await reportRow(r.reportId);
        expect(row.status, from).toBe("error");
        expect(row.statusBeforeGeneration).toBeNull();
        expect((await rowsFor(F.orgId, "report.generation_failed", r.reportId))[0].metadata, from).toMatchObject({ from_status: from });
      }
    });

    it("a run left generating past the lease that STARTED from generated goes back to generated (not error), with a stale failure row; here the request is then refused, and the report is not left hidden in generating", async () => {
      const old = new Date(Date.now() - (GENERATION_LEASE_SECONDS + 30) * 1000);
      const r = await mkReport(F, { status: "generating", statusBefore: "generated", updatedAt: old });
      await seedVersion(F, r, 0, 1, "ai_generated", OLD_AI);
      script(...happy());
      // A request at a stale version: refused, but the abandoned run is reclaimed first.
      const res = await gen(F.owner, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 0 });
      expect(res.status).toBe(409);
      expect(outbound).toHaveLength(0);
      const row = await reportRow(r.reportId);
      expect(row.status).toBe("generated");
      expect(row.statusBeforeGeneration).toBeNull();
      expect(texts(await versionRows(r.sections[0].id))).toEqual([OLD_AI]);
      const failed = await rowsFor(F.orgId, "report.generation_failed", r.reportId);
      expect(failed).toHaveLength(1);
      expect(failed[0].metadata).toEqual({ reason: "stale", role: "owner", from_status: "generated" });
    });

    it("...and the same abandoned run, then a request at the right version: reclaimed to generated, then regenerated", async () => {
      const old = new Date(Date.now() - (GENERATION_LEASE_SECONDS + 30) * 1000);
      const r = await mkReport(F, { status: "generating", statusBefore: "generated", updatedAt: old });
      await seedVersion(F, r, 0, 1, "ai_generated", OLD_AI);
      script(...happy());
      const res = await gen(F.assoc, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 1 });
      expect(res.status).toBe(200);
      expect(res.json.data).toMatchObject({ outcome: "generated", section: { version: 2, editType: "ai_regenerated_section" } });
      expect((await reportRow(r.reportId)).status).toBe("generated");
      expect((await rowsFor(F.orgId, "report.generation_failed", r.reportId))[0].metadata).toMatchObject({ reason: "stale", from_status: "generated" });
    });

    it("an abandoned run that started from draft or error (or from a row claimed before 0017) goes to error, as before; a LIVE run is left alone (409)", async () => {
      const old = new Date(Date.now() - (GENERATION_LEASE_SECONDS + 30) * 1000);
      for (const statusBefore of ["draft", "error", undefined] as const) {
        const r = await mkReport(F, { status: "generating", statusBefore, updatedAt: old });
        await seedVersion(F, r, 0, 1, "ai_generated", OLD_AI);
        const res = await gen(F.owner, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 0 });
        expect(res.status).toBe(409);
        expect((await reportRow(r.reportId)).status, String(statusBefore)).toBe("error");
      }
      const live = await mkReport(F, { status: "generating", statusBefore: "generated" });
      await seedVersion(F, live, 0, 1, "ai_generated", OLD_AI);
      expect((await gen(F.owner, live.reportId, live.sections[0].id, { notes: NOTES, baseVersion: 1 })).status).toBe(409);
      const row = await reportRow(live.reportId);
      expect(row.status).toBe("generating");
      expect(row.statusBeforeGeneration).toBe("generated");
      expect(outbound).toHaveLength(0);
      await h.owner.update(schema.reports).set({ status: "generated" }).where(eq(schema.reports.id, live.reportId)); // leave nothing live behind
    });

    it("nothing from the notes, the model or the old text reached the audit log or the console across all of the above", async () => {
      expectClean("audit log", JSON.stringify(await allAudit(F.orgId)));
      expectClean("console", consoleOut.join("\n"));
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("real mode: the limits hold for a regenerate", () => {
    let L: Practice;
    beforeAll(async () => {
      mode("real");
      L = await makePractice("limits");
    });
    const regen = async (who: Person) => {
      const r = await mkReport(L);
      await seedVersion(L, r, 0, 1, "ai_generated", OLD_AI);
      return { r, res: await gen(who, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 1 }) };
    };

    it("two live generations in the practice: a third (a regenerate) is 429 with Retry-After, no call, the report untouched", async () => {
      const live: string[] = [];
      for (let i = 0; i < MAX_CONCURRENT_GENERATIONS; i++) live.push((await mkReport(L, { status: "generating" })).reportId);
      script(...happy());
      const { r, res } = await regen(L.assoc);
      expect(res.status).toBe(429);
      expect(res.json.error?.code).toBe("rate_limited");
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(outbound).toHaveLength(0);
      expect((await reportRow(r.reportId)).status).toBe("generated");
      for (const id of live) await h.owner.update(schema.reports).set({ status: "error" }).where(eq(schema.reports.id, id));
    });

    it(`${MAX_STARTS_PER_USER} starts by one person in the window: their next regenerate is 429; a colleague's still runs`, async () => {
      await seedStarts(L.orgId, MAX_STARTS_PER_USER, { actor: L.owner.userId });
      script(...happy());
      const mine = await regen(L.owner);
      expect(mine.res.status).toBe(429);
      expect(outbound).toHaveLength(0);
      expect((await reportRow(mine.r.reportId)).status).toBe("generated");
      const colleague = await regen(L.assoc);
      expect(colleague.res.status).toBe(200);
    });

    it(`${MAX_STARTS_PER_ORGANIZATION} starts in the practice in the window: everyone's next regenerate is 429`, async () => {
      await seedStarts(L.orgId, MAX_STARTS_PER_ORGANIZATION);
      outbound.length = 0;
      script(...happy());
      const res = (await regen(L.assoc)).res;
      expect(res.status).toBe(429);
      expect(outbound).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("who may regenerate (same rules as generating)", () => {
    let A: Practice;
    let B: Practice;
    beforeAll(async () => {
      mode("real");
      A = await makePractice("acc-a");
      B = await makePractice("acc-b", { lean: true });
    });

    it("an admin is 403 and audited even with a grant; an unassigned associate and another practice's owner get the same 404 as a made-up id; none spends quota or sends anything", async () => {
      const r = await mkReport(A);
      await seedVersion(A, r, 0, 1, "ai_generated", OLD_AI);
      const before = await starts(A.orgId);
      const beforeB = await starts(B.orgId);
      const denied0 = (await auditRows(A.orgId, "authz.denied")).filter((a) => a.actorUserId === A.admin.userId).length;
      script(...happy());
      const body = { notes: NOTES, baseVersion: 1 };

      const admin = await gen(A.admin, r.reportId, r.sections[0].id, body);
      expect(admin.status).toBe(403);
      expect((await auditRows(A.orgId, "authz.denied")).filter((a) => a.actorUserId === A.admin.userId).length - denied0).toBe(1);

      const madeUp = await gen(A.assoc2, crypto.randomUUID(), crypto.randomUUID(), body);
      const stranger = await gen(A.assoc2, r.reportId, r.sections[0].id, body);
      expect(stranger.status).toBe(404);
      expect(stranger.json).toEqual(madeUp.json);
      const foreign = await gen(B.owner, r.reportId, r.sections[0].id, body);
      expect(foreign.status).toBe(404);
      expect(foreign.json).toEqual(madeUp.json);

      expect((await gen({ label: "nobody", orgId: "none" } as Person, r.reportId, r.sections[0].id, body)).status).toBe(401);
      expect((await gen(A.owner, r.reportId, r.sections[0].id, body, { origin: "https://evil.example" })).status).toBe(403);

      expect(outbound).toHaveLength(0);
      expect((await reportRow(r.reportId)).status).toBe("generated");
      expect(texts(await versionRows(r.sections[0].id))).toEqual([OLD_AI]);
      expect(await starts(A.orgId)).toBe(before);
      expect(await starts(B.orgId)).toBe(beforeB);
    });

    it("the owner and an assigned associate may; an admin may read the result but never starts one", async () => {
      const r = await mkReport(A);
      await seedVersion(A, r, 0, 1, "ai_generated", OLD_AI);
      script(...happy());
      expect((await gen(A.assoc, r.reportId, r.sections[0].id, { notes: NOTES, baseVersion: 1 })).status).toBe(200);
      expect((await get(A.admin, r.reportId)).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("stub mode: the same rules, no notes", () => {
    let S: Practice;
    beforeAll(async () => {
      S = await makePractice("stub", { lean: true });
      mode("stub");
    });
    afterAll(() => mode("real"));

    it("a second empty section of a generated report is generated with no body at all", async () => {
      const r = await mkReport(S);
      script(reply("Zed stub answer 1"));
      const res = await gen(S.owner, r.reportId, r.sections[1].id, null);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ data: { reportStatus: "generated", section: { id: r.sections[1].id, version: 1, editType: "ai_generated", text: "Zed stub answer 1" } } });
      expect((await reportRow(r.reportId)).status).toBe("generated");
      expect((await rowsFor(S.orgId, "report.generation_started", r.reportId))[0].metadata).toEqual({ role: "owner", from_status: "generated" });
    });

    it("a section with text is regenerated at its version: version + 1, ai_regenerated_section, the old text stays, the audit row says regenerated", async () => {
      const r = await mkReport(S);
      await seedVersion(S, r, 0, 1, "ai_generated", OLD_AI);
      script(reply("Zed stub answer 2"));
      const res = await gen(S.owner, r.reportId, r.sections[0].id, { baseVersion: 1 });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ data: { reportStatus: "generated", section: { id: r.sections[0].id, version: 2, editType: "ai_regenerated_section", text: "Zed stub answer 2" } } });
      const rows = await versionRows(r.sections[0].id);
      expect(texts(rows)).toEqual([OLD_AI, "Zed stub answer 2"]);
      expect(rows[1].llmMetadata).toMatchObject({ mode: "stub" });
      const [done] = (await auditRows(S.orgId, "report.regenerated")).filter((a) => a.resourceId === rows[1].id);
      expect(done.metadata).toMatchObject({ role: "owner", mode: "stub", from_status: "generated" });
      expect(outbound).toHaveLength(1);
      expectOldTextNotSent();
    });

    it("a person's own edit needs replaceEdited: the question first (no call, no write), then it goes ahead", async () => {
      const r = await mkReport(S);
      await seedVersion(S, r, 0, 1, "human_edit", OLD_HUMAN);
      const startsBefore = await starts(S.orgId);
      script(reply("Zed stub answer 3"));
      const ask = await gen(S.owner, r.reportId, r.sections[0].id, { baseVersion: 1 });
      expect(ask.status).toBe(200);
      expect(ask.json).toEqual({ data: { outcome: "needs_confirmation", reason: "edited_text", reportStatus: "generated" } });
      expect(outbound).toHaveLength(0);
      expect(await starts(S.orgId)).toBe(startsBefore);
      expect(texts(await versionRows(r.sections[0].id))).toEqual([OLD_HUMAN]);
      const go = await gen(S.owner, r.reportId, r.sections[0].id, { baseVersion: 1, replaceEdited: true });
      expect(go.json.data).toMatchObject({ section: { version: 2, editType: "ai_regenerated_section" } });
      expect(texts(await versionRows(r.sections[0].id))).toEqual([OLD_HUMAN, "Zed stub answer 3"]);
    });

    it("a stale or missing baseVersion on a section with text is 409; text on a draft report is 409; finalized is 409; nothing is sent", async () => {
      const r = await mkReport(S);
      await seedVersion(S, r, 0, 1, "ai_generated", OLD_AI);
      for (const body of [null, {}, { baseVersion: 0 }, { baseVersion: 2 }]) {
        expect((await gen(S.owner, r.reportId, r.sections[0].id, body)).status, JSON.stringify(body)).toBe(409);
      }
      for (const status of ["draft", "finalized"] as const) {
        const other = await mkReport(S, { status: status === "finalized" ? "generated" : status });
        await seedVersion(S, other, 0, 1, "human_edit", OLD_HUMAN);
        if (status === "finalized") await h.owner.update(schema.reports).set({ status: "finalized", finalizedAt: new Date() }).where(eq(schema.reports.id, other.reportId));
        expect((await gen(S.owner, other.reportId, other.sections[0].id, { baseVersion: 1, replaceEdited: true })).status, status).toBe(409);
      }
      expect(outbound).toHaveLength(0);
      expect(texts(await versionRows(r.sections[0].id))).toEqual([OLD_AI]);
    });

    it("a model failure on a regenerate puts the report back to generated with the old text intact (the code only, no detail)", async () => {
      const r = await mkReport(S);
      await seedVersion(S, r, 0, 1, "ai_generated", OLD_AI);
      script(() => new Response("internal secret detail Zed-secret-3", { status: 500 }));
      const res = await gen(S.owner, r.reportId, r.sections[0].id, { baseVersion: 1 });
      expect(res.status).toBe(502);
      expect(res.json.error?.code).toBe("inference_failed");
      expect(res.text).not.toContain("Zed-secret-3");
      const row = await reportRow(r.reportId);
      expect(row.status).toBe("generated");
      expect(row.statusBeforeGeneration).toBeNull();
      expect(texts(await versionRows(r.sections[0].id))).toEqual([OLD_AI]);
      expect((await rowsFor(S.orgId, "report.generation_failed", r.reportId))[0].metadata).toMatchObject({ reason: "bad_response", mode: "stub", from_status: "generated" });
    });

    it("the stub body is strict and small: unknown keys, a bad baseVersion, a bad replaceEdited and an oversized body are 400 with no call", async () => {
      const r = await mkReport(S);
      const before = await starts(S.orgId);
      for (const body of [{ notes: NOTES }, { baseVersion: -1 }, { baseVersion: 1.5 }, { baseVersion: "1" }, { replaceEdited: 1 }, { extra: true }, "not json", `{"baseVersion":1,"pad":"${"x".repeat(200)}"}`]) {
        expect((await gen(S.owner, r.reportId, r.sections[0].id, body as Body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
      }
      expect(outbound).toHaveLength(0);
      expect(await starts(S.orgId)).toBe(before);
    });
  });
});
