import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import { GENERATION_LEASE_SECONDS, MAX_CONCURRENT_GENERATIONS, MAX_NOTES_CHARS, MAX_STARTS_PER_ORGANIZATION, MAX_STARTS_PER_USER } from "@/lib/reports/generation-limits";
import { seedReportTemplate, TEMPLATE_STRUCTURE } from "@/scripts/seed-report-template.mjs";
import { ENABLED, startHarness, type Handler, type Person } from "./integration-harness";

// Real-mode section generation (the three-pass pipeline) end to end: the REAL route modules, REAL Better
// Auth sessions, the REAL app_runtime / auth_runtime roles with row-level security and the migration 0013
// triggers, on the scratch database. The ONLY thing replaced is the model: the outbound requests to the
// practice's *.ts.net address are answered, in order, by a scripted fake (a stub of global fetch that also
// records everything sent). No Ollama is involved. Synthetic data only; every "methodology" row below is
// clearly fake text made up for the test (never the practice owner's).
//
// Needs the TEST_* variables (see lib/auth/integration-harness.ts); skipped when absent.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 600_000 });

const ENDPOINT = "https://fake-box.synthtail.ts.net";
const SLUG = "psychoeducational-evaluation";
// Text that must never appear where it does not belong: the notes, the model's words, the methodology.
const NOTES_MARK = "ZNOTE-7731";
const NOTES = `${NOTES_MARK} Synthetic notes: the child stayed seated for the whole task and said "I like blocks 4821".`;
const MODEL_TEXT = "Zed generated section text 5512";
const METH_TWO = "SYNTHMETH-TWO fake methodology block, pinned by the reports";
const METH_THREE = "SYNTHMETH-THREE fake methodology block, active on the template";
const SENSITIVE_CATEGORY = "synthetic category alpha";

type Outbound = { url: string; headers: Headers; body: Record<string, unknown> & { messages: { role: string; content: string }[] }; model: string };
type Plan = (call: Outbound) => Response | Promise<Response>;

function completion(content: string, usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }) {
  return { id: "chatcmpl-1", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage };
}
const reply =
  (content: string, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }): Plan =>
  () =>
    new Response(JSON.stringify(completion(content, usage)), { status: 200, headers: { "content-type": "application/json" } });
const answer = (value: unknown) => reply(JSON.stringify(value));

const FILTER_OK = { template: SLUG, sufficient: true, sensitive_content_detected: false, missing_fields: [] as string[] };
const EXTRACT_OK = { observations: [`Zed extracted observation 6620`], test_scores: [], quotes: [], family_context: [] };
const GENERATE_OK = { content: MODEL_TEXT, flags: [] as string[] };
const filterPlan = (o: Partial<typeof FILTER_OK> = {}) => answer({ ...FILTER_OK, ...o });
const generatePlan = (o: Partial<typeof GENERATE_OK> = {}) => answer({ ...GENERATE_OK, ...o });
const happy = (): Plan[] => [filterPlan(), answer(EXTRACT_OK), generatePlan()];

describe.skipIf(!ENABLED)("real-mode section generation (three passes) through the real stack", () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let generate: { POST: Handler };
  let detail: { GET: Handler };

  type Practice = {
    orgId: string;
    owner: Person;
    assoc: Person;
    assoc2: Person;
    admin: Person;
    tpl: { templateId: string; placeholderPromptId: string; pinnedPromptId: string; activePromptId: string };
    c1: { id: string; displayName: string };
  };

  const tag = () => crypto.randomUUID().slice(0, 8);

  // ---- the scripted fake model --------------------------------------------------------------
  const outbound: Outbound[] = [];
  const elsewhere: string[] = [];
  const consoleOut: string[] = [];
  let queue: Plan[] = [];
  const realFetch = globalThis.fetch;
  /** The next calls to the model are answered by these, in order. A call beyond the script is a test failure (500). */
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

  async function mkReport(
    p: Practice,
    o: { status?: typeof schema.reports.$inferSelect.status; promptId?: string; updatedAt?: Date; sectionType?: "prose" | "structured"; clientId?: string } = {},
  ) {
    const status = o.status ?? "draft";
    const [r] = await h.owner
      .insert(schema.reports)
      .values({
        organizationId: p.orgId,
        clientId: o.clientId ?? p.c1.id,
        templateId: p.tpl.templateId,
        methodologyPromptId: o.promptId ?? p.tpl.pinnedPromptId,
        createdByUserId: p.owner.userId,
        status,
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
  const versionRows = (sectionId: string) => h.owner.select().from(schema.reportVersions).where(eq(schema.reportVersions.sectionId, sectionId)).orderBy(asc(schema.reportVersions.versionNumber));
  const reportRow = async (id: string) => (await h.owner.select().from(schema.reports).where(eq(schema.reports.id, id)))[0];
  const auditRows = (orgId: string, action: string) => h.owner.select().from(schema.auditLog).where(and(eq(schema.auditLog.organizationId, orgId), eq(schema.auditLog.action, action)));
  const allAudit = (orgId: string) => h.owner.select().from(schema.auditLog).where(eq(schema.auditLog.organizationId, orgId));
  const rowsFor = async (orgId: string, action: string, reportId: string) => (await auditRows(orgId, action)).filter((a) => a.resourceId === reportId);

  const methodology = (marker: string, extra: Record<string, unknown> = {}) => ({
    role: `${marker} role text`,
    methodology: `${marker} methodology text`,
    constraints: `${marker} constraints text`,
    ...extra,
  });

  /** A practice with its own template, a placeholder v1 (active at first), and real synthetic v2 (pinned by reports) and v3 (made active). */
  async function makePractice(label: string, o: { endpoint?: string | null; lean?: boolean } = {}): Promise<Practice> {
    const name = `pipe-${label}-${tag()}`;
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
    const placeholderPromptId = t.activeMethodologyPromptId!;
    const prompt = async (versionNumber: number, content: Record<string, unknown>) =>
      (
        await h.owner
          .insert(schema.methodologyPrompts)
          .values({ organizationId: orgId, templateId: t.id, versionNumber, content, notes: "synthetic test version", createdByUserId: owner.userId })
          .returning()
      )[0].id;
    const pinnedPromptId = await prompt(2, methodology(METH_TWO, { sensitive_categories: [SENSITIVE_CATEGORY] }));
    const activePromptId = await prompt(3, methodology(METH_THREE));
    await h.owner.update(schema.reportTemplates).set({ activeMethodologyPromptId: activePromptId }).where(eq(schema.reportTemplates.id, t.id));
    const endpoint = o.endpoint === undefined ? ENDPOINT : o.endpoint;
    if (endpoint) await h.owner.update(schema.organizations).set({ inferenceEndpoint: endpoint }).where(eq(schema.organizations.id, orgId));
    const [c1] = await h.owner
      .insert(schema.clients)
      .values({ organizationId: orgId, displayName: `Synthetic Client ${tag()}`, dateOfBirth: "2016-04-02", gradeLevel: "3", externalId: `EXT-${tag()}` })
      .returning();
    await assign(orgId, c1.id, assoc, owner);
    if (!o.lean) await assign(orgId, c1.id, admin, owner);
    return { orgId, owner, assoc, assoc2, admin, tpl: { templateId: t.id, placeholderPromptId, pinnedPromptId, activePromptId }, c1 };
  }

  /** Ledger rows the way a real start writes them (the owner connection may insert, never change, audit rows). */
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

  /** What must not appear in any response, audit row, stored metadata or console line. */
  const SECRETS = [NOTES_MARK, "I like blocks 4821", MODEL_TEXT, "Zed extracted observation", METH_TWO, METH_THREE, "SYNTHMETH", "fake-box", "synthtail", "ts.net", "Authorization"];
  const expectClean = (what: string, text: string) => {
    for (const needle of SECRETS) expect(text, `${what} must not contain ${needle}`).not.toContain(needle);
  };

  beforeAll(async () => {
    h = await startHarness({ appRole: "app_runtime_pipeline", authRole: "auth_runtime_pipeline", secret: "pipeline-test-secret-".padEnd(48, "x") });
    generate = (await import("@/app/api/reports/[id]/sections/[sectionId]/generate/route")) as unknown as typeof generate;
    detail = (await import("@/app/api/reports/[id]/route")) as unknown as typeof detail;
    getEnv().INFERENCE_MODE = "real";
    expect(getEnv().INFERENCE_MODE).toBe("real");
  }, 600_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await h?.stop();
  });

  // Each person may start 10 generations per 10 minutes and a practice 30 (that is the point), and a
  // warning is a start too, so each group below has a practice of its own and stays under those numbers.

  // ---------------------------------------------------------------------------------------
  describe("sufficient notes: one call, three passes, one stored version", () => {
    let P: Practice;
    beforeAll(async () => {
      P = await makePractice("ok", { lean: true });
    });

    it("owner: 200 generated; one ai_generated version 1 with the closed real metadata; the report becomes generated", async () => {
      const r = await mkReport(P);
      const s = r.sections[0];
      script(...happy());
      const res = await gen(P.owner, r.reportId, s.id);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.json).toEqual({ data: { outcome: "generated", reportStatus: "generated", section: { id: s.id, version: 1, editType: "ai_generated", text: MODEL_TEXT }, flags: [] } });

      const rows = await versionRows(s.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ versionNumber: 1, editType: "ai_generated", content: { text: MODEL_TEXT }, createdByUserId: null, reportId: r.reportId, organizationId: P.orgId });
      expect(rows[0].llmMetadata).toEqual({
        mode: "real",
        methodologyPromptId: P.tpl.pinnedPromptId,
        passes: [
          { pass: "filter", model: "qwen3:1.7b", inputTokens: 100, outputTokens: 20, latencyMs: expect.any(Number), attempts: 1 },
          { pass: "extract", model: "qwen3:8b", inputTokens: 100, outputTokens: 20, latencyMs: expect.any(Number), attempts: 1 },
          { pass: "generate", model: "qwen3:8b", inputTokens: 100, outputTokens: 20, latencyMs: expect.any(Number), attempts: 1 },
        ],
        flags: [],
        costUsd: 0,
      });
      expect((await reportRow(r.reportId)).status).toBe("generated");
      // The other sections are untouched.
      for (const other of r.sections.slice(1)) expect(await versionRows(other.id)).toHaveLength(0);

      // The report read shows the text, the edit type, and (empty) flags.
      const shown = (await get(P.owner, r.reportId)).json.data as { sections: { id: string; text: string; editType: string | null; flags: string[] }[] };
      expect(shown.sections.find((x) => x.id === s.id)).toMatchObject({ text: MODEL_TEXT, editType: "ai_generated", flags: [] });
    });

    it("the audit rows hold ids, role, mode, model tag, counts, latency and flag names only, and the stored metadata holds no text", async () => {
      const r = await mkReport(P);
      script(...happy());
      expect((await gen(P.assoc, r.reportId, r.sections[1].id)).status).toBe(200);
      const [started] = await rowsFor(P.orgId, "report.generation_started", r.reportId);
      expect(started).toMatchObject({ actorUserId: P.assoc.userId, resourceType: "report_generation", outcome: "success", metadata: { role: "associate", mode: "real" } });
      const [version] = await versionRows(r.sections[1].id);
      const [done] = (await auditRows(P.orgId, "report.generated")).filter((a) => a.resourceId === version.id);
      expect(done).toMatchObject({
        actorUserId: P.assoc.userId,
        resourceType: "report_version",
        metadata: { role: "associate", mode: "real", model: "qwen3:8b", input_tokens: 300, output_tokens: 60, latency_ms: expect.any(Number) },
      });
      expect(Object.keys(done.metadata as object).sort()).toEqual(["input_tokens", "latency_ms", "mode", "model", "output_tokens", "role"]);
      expectClean("audit log", JSON.stringify(await allAudit(P.orgId)));
      expectClean("llm_metadata", JSON.stringify(version.llmMetadata));
      expectClean("console", consoleOut.join("\n"));
    });

    it("sends to the practice's own address only, three calls with the right model per pass, nothing about the client or the person", async () => {
      const r = await mkReport(P);
      script(...happy());
      expect((await gen(P.owner, r.reportId, r.sections[2].id)).status).toBe(200);
      expect(outbound).toHaveLength(3);
      expect(outbound.map((c) => c.url)).toEqual(Array(3).fill(`${ENDPOINT}/v1/chat/completions`));
      expect(elsewhere).toEqual([]);
      expect(outbound.map((c) => c.model)).toEqual(["qwen3:1.7b", "qwen3:8b", "qwen3:8b"]);

      // The notes go to the filter and extract passes; the pinned methodology goes to generate only.
      const text = (c: Outbound) => c.body.messages.map((m) => m.content).join("\n");
      expect(text(outbound[0])).toContain(NOTES_MARK);
      expect(text(outbound[1])).toContain(NOTES_MARK);
      expect(text(outbound[2])).not.toContain(NOTES_MARK);
      expect(text(outbound[2])).toContain("SYNTHMETH-TWO");
      expect(text(outbound[0])).not.toContain("SYNTHMETH");
      expect(text(outbound[1])).not.toContain("SYNTHMETH");
      // The optional sensitive-category list reaches the filter pass and nowhere else.
      expect(text(outbound[0])).toContain(SENSITIVE_CATEGORY);
      expect(text(outbound[1])).not.toContain(SENSITIVE_CATEGORY);
      expect(text(outbound[2])).not.toContain(SENSITIVE_CATEGORY);

      const [c1] = await h.owner.select().from(schema.clients).where(eq(schema.clients.id, P.c1.id));
      const needles = [c1.displayName, c1.dateOfBirth!, c1.externalId!, r.reportId, r.sections[2].id, P.orgId, P.c1.id, P.owner.userId, P.owner.email, P.tpl.pinnedPromptId, P.tpl.templateId];
      for (const call of outbound) {
        const sent = JSON.stringify([call.body, [...call.headers.entries()]]);
        for (const needle of needles) expect(sent, needle).not.toContain(needle);
        expect(call.headers.get("cookie")).toBeNull();
        expect(call.headers.get("authorization")).toBeNull();
      }
    });

    it("uses the methodology version the REPORT pinned, not whatever the template has active now", async () => {
      const r = await mkReport(P); // pinned = v2, the template's active = v3
      script(...happy());
      expect((await gen(P.owner, r.reportId, r.sections[0].id)).status).toBe(200);
      const generateCall = outbound[2].body.messages.map((m) => m.content).join("\n");
      expect(generateCall).toContain("SYNTHMETH-TWO");
      expect(generateCall).not.toContain("SYNTHMETH-THREE");
      expect((await versionRows(r.sections[0].id))[0].llmMetadata).toMatchObject({ methodologyPromptId: P.tpl.pinnedPromptId });
      expect((await versionRows(r.sections[0].id))[0].llmMetadata).not.toMatchObject({ methodologyPromptId: P.tpl.activePromptId });
    });

    it("the practice's filter and worker model tags are used, checked and recorded; heavy is never read", async () => {
      await h.owner.update(schema.organizations).set({ modelConfig: { filter: "custom-filter:1b", worker: "custom-worker:8b", heavy: "custom-heavy:30b" } }).where(eq(schema.organizations.id, P.orgId));
      try {
        const r = await mkReport(P);
        script(...happy());
        expect((await gen(P.owner, r.reportId, r.sections[0].id)).status).toBe(200);
        expect(outbound.map((c) => c.model)).toEqual(["custom-filter:1b", "custom-worker:8b", "custom-worker:8b"]);
        const passes = ((await versionRows(r.sections[0].id))[0].llmMetadata as { passes: { model: string }[] }).passes;
        expect(passes.map((p) => p.model)).toEqual(["custom-filter:1b", "custom-worker:8b", "custom-worker:8b"]);
      } finally {
        await h.owner.update(schema.organizations).set({ modelConfig: {} }).where(eq(schema.organizations.id, P.orgId));
      }
    });

    it("flags are a review prompt, never a block: stored, shown on the report read, cleared by a person's own save", async () => {
      const r = await mkReport(P);
      const s = r.sections[0];
      script(filterPlan({ sensitive_content_detected: true }), answer(EXTRACT_OK), generatePlan({ flags: ["low_confidence_interpretation"] }));
      const res = await gen(P.owner, r.reportId, s.id);
      expect(res.status).toBe(200);
      expect(res.json.data).toMatchObject({ outcome: "generated", flags: ["sensitive_content_detected", "low_confidence_interpretation"], section: { text: MODEL_TEXT } });
      const [v1] = await versionRows(s.id);
      expect(v1.llmMetadata).toMatchObject({ flags: ["sensitive_content_detected", "low_confidence_interpretation"] });
      const [done] = (await auditRows(P.orgId, "report.generated")).filter((a) => a.resourceId === v1.id);
      expect(done.metadata).toMatchObject({ flags: "sensitive_content_detected,low_confidence_interpretation" });

      const read = async () => ((await get(P.owner, r.reportId)).json.data as { sections: { id: string; flags: string[]; text: string }[] }).sections.find((x) => x.id === s.id)!;
      expect(await read()).toMatchObject({ flags: ["sensitive_content_detected", "low_confidence_interpretation"], text: MODEL_TEXT });

      // A person's save is a new version without flags: saving is the review.
      await h.owner.insert(schema.reportVersions).values({ organizationId: P.orgId, reportId: r.reportId, sectionId: s.id, versionNumber: 2, editType: "human_edit", content: { text: "Edited by a person" }, createdByUserId: P.owner.userId });
      expect(await read()).toMatchObject({ flags: [], text: "Edited by a person" });
    });

    it("a malformed answer is retried once, with the same pass, and the run goes on", async () => {
      const r = await mkReport(P);
      script(reply("this is not json"), filterPlan(), answer(EXTRACT_OK), generatePlan());
      const res = await gen(P.owner, r.reportId, r.sections[3].id);
      expect(res.status).toBe(200);
      expect(outbound).toHaveLength(4);
      const passes = ((await versionRows(r.sections[3].id))[0].llmMetadata as { passes: { pass: string; attempts: number }[] }).passes;
      expect(passes.map((p) => [p.pass, p.attempts])).toEqual([["filter", 2], ["extract", 1], ["generate", 1]]);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("thin notes: warn first, generate only when the person confirms", () => {
    let P: Practice;
    beforeAll(async () => {
      P = await makePractice("thin", { lean: true });
    });
    const THIN = { sufficient: false, missing_fields: ["observations", "quotes"], sensitive_content_detected: true };

    it("the first call warns: a closed list of what is missing, nothing generated, nothing stored, the report untouched, no claim", async () => {
      const r = await mkReport(P);
      const before = await reportRow(r.reportId);
      script(filterPlan(THIN));
      const res = await gen(P.owner, r.reportId, r.sections[0].id);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ data: { outcome: "needs_confirmation", reportStatus: "draft", missing: ["observations", "quotes"], sensitive: true } });
      expect(outbound).toHaveLength(1);
      expect(outbound[0].model).toBe("qwen3:1.7b");
      for (const section of r.sections) expect(await versionRows(section.id)).toHaveLength(0);
      const after = await reportRow(r.reportId);
      expect(after.status).toBe("draft");
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());

      // Audit: the start (it used the model) and the warning; no generated or failed row.
      expect(await rowsFor(P.orgId, "report.generation_started", r.reportId)).toHaveLength(1);
      const warned = await rowsFor(P.orgId, "report.generation_warned", r.reportId);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatchObject({
        actorUserId: P.owner.userId,
        resourceType: "report_generation",
        outcome: "success",
        metadata: { role: "owner", mode: "real", model: "qwen3:1.7b", latency_ms: expect.any(Number), missing: "observations,quotes", flags: "sensitive_content_detected" },
      });
      expect(await rowsFor(P.orgId, "report.generation_failed", r.reportId)).toHaveLength(0);

      // The warning carries no notes and no model words, anywhere.
      expectClean("response", res.text);
      expectClean("audit log", JSON.stringify(await allAudit(P.orgId)));
      expectClean("console", consoleOut.join("\n"));
    });

    it("the warning can be repeated freely (the report is still draft), and counts as a start each time", async () => {
      const r = await mkReport(P);
      const startsBefore = (await rowsFor(P.orgId, "report.generation_started", r.reportId)).length;
      script(filterPlan(THIN), filterPlan(THIN));
      expect((await gen(P.owner, r.reportId, r.sections[0].id)).json.data).toMatchObject({ outcome: "needs_confirmation" });
      expect((await gen(P.owner, r.reportId, r.sections[0].id)).json.data).toMatchObject({ outcome: "needs_confirmation" });
      expect((await rowsFor(P.orgId, "report.generation_started", r.reportId)).length - startsBefore).toBe(2);
      expect((await reportRow(r.reportId)).status).toBe("draft");
    });

    it("a report in error says so (its status is left as it was)", async () => {
      const r = await mkReport(P, { status: "error" });
      script(filterPlan({ sufficient: false, missing_fields: [], sensitive_content_detected: false }));
      const res = await gen(P.owner, r.reportId, r.sections[0].id);
      expect(res.json).toEqual({ data: { outcome: "needs_confirmation", reportStatus: "error", missing: [], sensitive: false } });
      expect((await reportRow(r.reportId)).status).toBe("error");
    });

    it("confirm: true goes ahead: the model's text is kept with [Please provide] where the notes fall short, and insufficient_input stays flagged", async () => {
      const r = await mkReport(P);
      const s = r.sections[0];
      const written = "Zed partial text [Please provide] the rest";
      script(filterPlan(THIN), answer(EXTRACT_OK), generatePlan({ content: written, flags: [] }));
      const res = await gen(P.owner, r.reportId, s.id, { notes: NOTES, confirm: true });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ data: { outcome: "generated", reportStatus: "generated", section: { id: s.id, version: 1, editType: "ai_generated", text: written }, flags: ["insufficient_input", "sensitive_content_detected"] } });
      expect(outbound).toHaveLength(3);
      const [v] = await versionRows(s.id);
      expect(v).toMatchObject({ editType: "ai_generated", content: { text: written }, createdByUserId: null });
      expect(v.llmMetadata).toMatchObject({ mode: "real", flags: ["insufficient_input", "sensitive_content_detected"] });
      expect((await reportRow(r.reportId)).status).toBe("generated");
      const read = ((await get(P.owner, r.reportId)).json.data as { sections: { id: string; flags: string[] }[] }).sections.find((x) => x.id === s.id)!;
      expect(read.flags).toEqual(["insufficient_input", "sensitive_content_detected"]);
    });

    it("the whole two-step flow on one report: warn, then confirm; the report is draft in between and generated at the end", async () => {
      const r = await mkReport(P);
      script(filterPlan(THIN), filterPlan(THIN), answer(EXTRACT_OK), generatePlan({ content: "Zed gap-aware text [Please provide]" }));
      expect((await gen(P.owner, r.reportId, r.sections[1].id)).json.data).toMatchObject({ outcome: "needs_confirmation" });
      expect((await reportRow(r.reportId)).status).toBe("draft");
      expect((await gen(P.owner, r.reportId, r.sections[1].id, { notes: NOTES, confirm: true })).json.data).toMatchObject({ outcome: "generated" });
      expect((await reportRow(r.reportId)).status).toBe("generated");
      expect(await versionRows(r.sections[1].id)).toHaveLength(1);
    });

    it("confirm: true with notes the filter finds sufficient just runs: no insufficient_input flag is added", async () => {
      const r = await mkReport(P);
      script(...happy());
      const res = await gen(P.owner, r.reportId, r.sections[2].id, { notes: NOTES, confirm: true });
      expect(res.json.data).toMatchObject({ outcome: "generated", flags: [], section: { text: MODEL_TEXT } });
    });

    it("notes the filter calls enough, but whose writer reports too little input: stored as [Please provide] with the flag, never invented text", async () => {
      const r = await mkReport(P);
      script(filterPlan(), answer(EXTRACT_OK), generatePlan({ content: "Zed invented text that must be dropped", flags: ["insufficient_input"] }));
      const res = await gen(P.owner, r.reportId, r.sections[3].id);
      expect(res.status).toBe(200);
      expect(res.json.data).toMatchObject({ outcome: "generated", section: { text: "[Please provide]" }, flags: ["insufficient_input"] });
      expect((await versionRows(r.sections[3].id))[0]).toMatchObject({ content: { text: "[Please provide]" } });
      expect(JSON.stringify(await versionRows(r.sections[3].id))).not.toContain("invented");
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("when a pass does not deliver, the report is never left generating", () => {
    let P: Practice;
    beforeAll(async () => {
      P = await makePractice("fail", { lean: true });
    });

    it("a malformed answer twice in generate (after the claim): error, nothing stored, one failure row with a code; and the report can try again", async () => {
      const r = await mkReport(P);
      script(filterPlan(), answer(EXTRACT_OK), reply("not json Zed-secret-1"), reply("{\"content\": 5}"));
      const res = await gen(P.owner, r.reportId, r.sections[0].id);
      expect(res.status).toBe(502);
      expect(res.json.error?.code).toBe("inference_failed");
      expectClean("response", res.text);
      expect(res.text).not.toContain("Zed-secret-1");
      expect(outbound).toHaveLength(4);
      expect((await reportRow(r.reportId)).status).toBe("error");
      expect(await versionRows(r.sections[0].id)).toHaveLength(0);
      const failed = await rowsFor(P.orgId, "report.generation_failed", r.reportId);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ outcome: "failure", actorUserId: P.owner.userId, metadata: { reason: "invalid_output", role: "owner", mode: "real" } });

      // error -> generating -> generated
      outbound.length = 0;
      script(...happy());
      expect((await gen(P.owner, r.reportId, r.sections[0].id)).status).toBe(200);
      expect((await reportRow(r.reportId)).status).toBe("generated");
    });

    it("a malformed answer twice in the filter (before the claim): 502, the report was never touched, one failure row, nothing stored", async () => {
      const r = await mkReport(P);
      const before = await reportRow(r.reportId);
      script(reply("nope"), reply("still nope"));
      const res = await gen(P.owner, r.reportId, r.sections[0].id);
      expect(res.status).toBe(502);
      expect(outbound).toHaveLength(2);
      const after = await reportRow(r.reportId);
      expect(after.status).toBe("draft");
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(await versionRows(r.sections[0].id)).toHaveLength(0);
      const failed = await rowsFor(P.orgId, "report.generation_failed", r.reportId);
      expect(failed).toHaveLength(1);
      expect(failed[0].metadata).toMatchObject({ reason: "invalid_output", role: "owner", mode: "real" });
    });

    it.each([
      ["the endpoint is unreachable in extract", () => Promise.reject(new TypeError("fetch failed")), 502, "unreachable"],
      ["the call times out in extract", () => Promise.reject(new DOMException("The operation timed out", "TimeoutError")), 504, "timeout"],
      ["the endpoint answers 500 in extract", () => new Response("internal secret detail Zed-secret-2", { status: 500 }), 502, "bad_response"],
    ] as [string, Plan, number, string][])("%s: error status, a fixed code, no detail in the response or the log", async (_label, failing, status, reason) => {
      const r = await mkReport(P);
      script(filterPlan(), failing);
      const res = await gen(P.assoc, r.reportId, r.sections[0].id);
      expect(res.status).toBe(status);
      expect(res.json.error?.code).toBe("inference_failed");
      expect(res.text).not.toMatch(/secret detail|Zed-secret|fetch failed|fake-box|qwen/i);
      expect(outbound).toHaveLength(2); // never retried: one endpoint, no fallback
      expect(elsewhere).toEqual([]);
      expect((await reportRow(r.reportId)).status).toBe("error");
      expect(await versionRows(r.sections[0].id)).toHaveLength(0);
      const failed = await rowsFor(P.orgId, "report.generation_failed", r.reportId);
      expect(failed).toHaveLength(1);
      expect(failed[0].metadata).toMatchObject({ reason, mode: "real" });
      expect(consoleOut.join("\n")).not.toMatch(/secret detail|Zed-secret/);
    });

    it("a pinned methodology that is only a placeholder is a 409 before any model is asked, and the report is not touched", async () => {
      const r = await mkReport(P, { promptId: P.tpl.placeholderPromptId });
      const before = await reportRow(r.reportId);
      script(...happy());
      const res = await gen(P.assoc, r.reportId, r.sections[0].id);
      expect(res.status).toBe(409);
      expect(res.json.error?.code).toBe("inference_not_configured");
      expect(outbound).toHaveLength(0);
      const after = await reportRow(r.reportId);
      expect(after.status).toBe("draft");
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(await versionRows(r.sections[0].id)).toHaveLength(0);
      expect((await rowsFor(P.orgId, "report.generation_failed", r.reportId))[0]?.metadata).toMatchObject({ reason: "invalid_config", mode: "real" });
    });

    it("a report left generating past the lease is reclaimed (to error, with its failure row) and then proceeds", async () => {
      const r = await mkReport(P, { status: "generating", updatedAt: new Date(Date.now() - (GENERATION_LEASE_SECONDS + 30) * 1000) });
      script(...happy());
      const res = await gen(P.assoc, r.reportId, r.sections[0].id);
      expect(res.status).toBe(200);
      expect((await reportRow(r.reportId)).status).toBe("generated");
      expect((await rowsFor(P.orgId, "report.generation_failed", r.reportId))[0]?.metadata).toMatchObject({ reason: "stale" });
    });

    it("the claim re-checks after the filter: a report another request took meanwhile is a 409, and no further model call is made", async () => {
      const r = await mkReport(P);
      script(async () => {
        // While the filter "works", another request starts generating this very report.
        await h.owner.update(schema.reports).set({ status: "generating" }).where(eq(schema.reports.id, r.reportId));
        return filterPlan()(undefined as never);
      });
      const res = await gen(P.assoc, r.reportId, r.sections[0].id);
      expect(res.status).toBe(409);
      expect(res.json.error?.code).toBe("conflict");
      expect(outbound).toHaveLength(1);
      expect(await versionRows(r.sections[0].id)).toHaveLength(0);
      // Not ours to undo: the other request owns the generating status.
      expect((await reportRow(r.reportId)).status).toBe("generating");
      await h.owner.update(schema.reports).set({ status: "error" }).where(eq(schema.reports.id, r.reportId)); // leave nothing live behind
    });

    it("the concurrency cap is enforced at the claim too: filled up while the filter ran, the run stops with 429 and the report is untouched", async () => {
      const r = await mkReport(P);
      const others: string[] = [];
      script(async () => {
        for (let i = 0; i < MAX_CONCURRENT_GENERATIONS; i++) others.push((await mkReport(P, { status: "generating" })).reportId);
        return filterPlan()(undefined as never);
      });
      const res = await gen(P.assoc, r.reportId, r.sections[0].id);
      expect(res.status).toBe(429);
      expect(res.json.error?.code).toBe("rate_limited");
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(outbound).toHaveLength(1);
      expect((await reportRow(r.reportId)).status).toBe("draft");
      expect(await versionRows(r.sections[0].id)).toHaveLength(0);
      for (const id of others) await h.owner.update(schema.reports).set({ status: "error" }).where(eq(schema.reports.id, id));
    });

    it("nothing from the notes or the model reached the audit log or the console across all of the failures above", async () => {
      expectClean("audit log", JSON.stringify(await allAudit(P.orgId)));
      expectClean("console", consoleOut.join("\n"));
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("who may call, and what is refused before any model is asked", () => {
    let A: Practice;
    let B: Practice;
    let N: Practice; // no inference endpoint
    beforeAll(async () => {
      A = await makePractice("acc-a");
      B = await makePractice("acc-b", { lean: true });
      N = await makePractice("acc-n", { lean: true, endpoint: null });
    });
    const starts = async (orgId: string) => (await auditRows(orgId, "report.generation_started")).length;
    const nothing = async (p: Practice, r: Awaited<ReturnType<typeof mkReport>>, before: number, status = "draft") => {
      expect(outbound).toHaveLength(0);
      expect((await reportRow(r.reportId)).status).toBe(status);
      for (const s of r.sections) expect(await versionRows(s.id)).toHaveLength(0);
      expect(await starts(p.orgId)).toBe(before);
    };

    it("no session is 401, and a foreign origin is 403: nothing happens", async () => {
      const r = await mkReport(A);
      const before = await starts(A.orgId);
      script(...happy());
      expect((await gen({ label: "nobody", orgId: "none" } as Person, r.reportId, r.sections[0].id)).status).toBe(401);
      const res = await gen(A.owner, r.reportId, r.sections[0].id, { notes: NOTES }, { origin: "https://evil.example" });
      expect(res.status).toBe(403);
      await nothing(A, r, before);
    });

    it("an admin is 403 and audited, even with a grant on the client; no call, no change, no quota used", async () => {
      const r = await mkReport(A);
      const before = await starts(A.orgId);
      const denied0 = (await auditRows(A.orgId, "authz.denied")).filter((a) => a.actorUserId === A.admin.userId).length;
      script(...happy());
      const res = await gen(A.admin, r.reportId, r.sections[0].id);
      expect(res.status).toBe(403);
      expect(res.json.error?.code).toBe("forbidden");
      await nothing(A, r, before);
      expect((await auditRows(A.orgId, "authz.denied")).filter((a) => a.actorUserId === A.admin.userId).length - denied0).toBe(1);
    });

    it("an associate NOT assigned to the client gets the same 404 as a made-up id: no call, no change, no quota used", async () => {
      const r = await mkReport(A);
      const before = await starts(A.orgId);
      script(...happy());
      const stranger = await gen(A.assoc2, r.reportId, r.sections[0].id);
      const madeUp = await gen(A.assoc2, crypto.randomUUID(), crypto.randomUUID());
      expect(stranger.status).toBe(404);
      expect(stranger.json).toEqual(madeUp.json);
      await nothing(A, r, before);
    });

    it("the other practice's owner (with an endpoint of their own) gets the same 404; nothing is sent, nothing changes", async () => {
      const r = await mkReport(A);
      const before = await starts(A.orgId);
      const beforeB = await starts(B.orgId);
      script(...happy());
      const res = await gen(B.owner, r.reportId, r.sections[0].id);
      expect(res.status).toBe(404);
      expect(res.json).toEqual((await gen(B.owner, crypto.randomUUID(), crypto.randomUUID())).json);
      await nothing(A, r, before);
      expect(await starts(B.orgId)).toBe(beforeB);
    });

    it("a section id from another report is 404 and changes nothing", async () => {
      const r1 = await mkReport(A);
      const r2 = await mkReport(A);
      const before = await starts(A.orgId);
      script(...happy());
      expect((await gen(A.owner, r1.reportId, r2.sections[0].id)).status).toBe(404);
      await nothing(A, r1, before);
    });

    it("a practice with no inference endpoint is a 409 and NOTHING happens: no call, no start row, no status change, no default endpoint", async () => {
      const r = await mkReport(N);
      script(...happy());
      const res = await gen(N.owner, r.reportId, r.sections[0].id);
      expect(res.status).toBe(409);
      expect(res.json.error?.code).toBe("inference_not_configured");
      expect(elsewhere).toEqual([]);
      await nothing(N, r, 0);
      expect((await allAudit(N.orgId)).filter((a) => a.action.startsWith("report.gen"))).toHaveLength(0);
    });

    it("a model_config that is not usable is the same 409 before any call", async () => {
      await h.owner.update(schema.organizations).set({ modelConfig: { worker: 5 } }).where(eq(schema.organizations.id, B.orgId));
      try {
        const r = await mkReport(B);
        script(...happy());
        const before = await starts(B.orgId);
        const res = await gen(B.owner, r.reportId, r.sections[0].id);
        expect(res.status).toBe(409);
        expect(res.json.error?.code).toBe("inference_not_configured");
        await nothing(B, r, before);
      } finally {
        await h.owner.update(schema.organizations).set({ modelConfig: {} }).where(eq(schema.organizations.id, B.orgId));
      }
    });

    it("a model tag that is not a tag is refused by the library: nothing sent", async () => {
      await h.owner.update(schema.organizations).set({ modelConfig: { worker: "bad model; drop table" } }).where(eq(schema.organizations.id, B.orgId));
      try {
        const r = await mkReport(B);
        script(...happy());
        const res = await gen(B.owner, r.reportId, r.sections[0].id);
        expect(res.status).toBe(502);
        expect(outbound).toHaveLength(0);
        expect((await reportRow(r.reportId)).status).toBe("draft");
      } finally {
        await h.owner.update(schema.organizations).set({ modelConfig: {} }).where(eq(schema.organizations.id, B.orgId));
      }
    });

    it("only an empty prose section of a draft or error report: a section with text, a structured section, a generated, a generating and a finalized report are all 409 with no call", async () => {
      const withText = await mkReport(A);
      await h.owner.insert(schema.reportVersions).values({ organizationId: A.orgId, reportId: withText.reportId, sectionId: withText.sections[0].id, versionNumber: 1, editType: "human_edit", content: { text: "A person wrote this" }, createdByUserId: A.owner.userId });
      const cases: [string, Awaited<ReturnType<typeof mkReport>>, string][] = [
        ["a section that already has text", withText, "draft"],
        ["a structured section", await mkReport(A, { sectionType: "structured" }), "draft"],
        ["a generated report (a second section cannot be generated until regenerate-section exists)", await mkReport(A, { status: "generated" }), "generated"],
        ["a report that is generating", await mkReport(A, { status: "generating" }), "generating"],
        ["a finalized report", await mkReport(A, { status: "finalized" }), "finalized"],
      ];
      for (const [label, r, status] of cases) {
        const before = await starts(A.orgId);
        script(...happy());
        const res = await gen(A.owner, r.reportId, r.sections[0].id);
        expect(res.status, label).toBe(409);
        expect(res.json.error?.code, label).toBe("conflict");
        expect(outbound, label).toHaveLength(0);
        expect((await reportRow(r.reportId)).status, label).toBe(status);
        expect(await starts(A.orgId), label).toBe(before);
      }
      expect((await versionRows(withText.sections[0].id))[0]).toMatchObject({ content: { text: "A person wrote this" } });
    });

    it("a soft-deleted client takes its reports with it (404)", async () => {
      const [c] = await h.owner.insert(schema.clients).values({ organizationId: A.orgId, displayName: `Synthetic Client ${tag()}`, deletedAt: new Date() }).returning();
      const r = await mkReport(A, { clientId: c.id });
      const before = await starts(A.orgId);
      script(...happy());
      expect((await gen(A.owner, r.reportId, r.sections[0].id)).status).toBe(404);
      await nothing(A, r, before);
    });

    describe("the body (real mode takes {notes, confirm?} and nothing else)", () => {
      const cases: [string, Body | string | null][] = [
        ["no body", null],
        ["an empty object", {}],
        ["empty notes", { notes: "" }],
        ["whitespace-only notes", { notes: "  \n\t " }],
        ["notes that are not a string", { notes: 5 }],
        ["notes longer than the limit", { notes: "x".repeat(MAX_NOTES_CHARS + 1) }],
        ["an extra key", { notes: NOTES, extra: 1 }],
        ["a client-supplied endpoint", { notes: NOTES, endpoint: "https://evil.example" }],
        ["a client-supplied model", { notes: NOTES, model: "qwen3:8b" }],
        ["a confirm that is not a boolean", { notes: NOTES, confirm: "yes" }],
        ["a body that is not JSON", "this is not json"],
        ["a JSON array", "[1,2]"],
        ["a body far over the size cap", JSON.stringify({ notes: "y".repeat(MAX_NOTES_CHARS * 7) })],
      ];
      it.each(cases)("%s is a 400 that echoes nothing; no call, no start row, no change", async (_label, body) => {
        const r = await mkReport(A);
        const before = await starts(A.orgId);
        script(...happy());
        const res = await gen(A.owner, r.reportId, r.sections[0].id, body);
        expect(res.status).toBe(400);
        expect(res.json.error?.code).toBe("validation_failed");
        expect(res.text).not.toContain("evil.example");
        expect(res.text).not.toContain("xxxx");
        await nothing(A, r, before);
      });

      it("notes of exactly the limit are accepted", async () => {
        const r = await mkReport(A);
        const before = await starts(A.orgId);
        script(filterPlan({ sufficient: false, missing_fields: [] }));
        const res = await gen(A.owner, r.reportId, r.sections[0].id, { notes: "n".repeat(MAX_NOTES_CHARS) });
        expect(res.status).toBe(200);
        expect(await starts(A.orgId)).toBe(before + 1);
      });
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("limits still hold", () => {
    let P: Practice;
    beforeAll(async () => {
      P = await makePractice("lim", { lean: true });
    });

    it("2 running per practice: refused up front with 429, Retry-After, and no model call", async () => {
      const live = await Promise.all(Array.from({ length: MAX_CONCURRENT_GENERATIONS }, () => mkReport(P, { status: "generating" })));
      try {
        const r = await mkReport(P);
        script(...happy());
        const res = await gen(P.owner, r.reportId, r.sections[0].id);
        expect(res.status).toBe(429);
        expect(res.json.error?.code).toBe("rate_limited");
        expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
        expect(outbound).toHaveLength(0);
        expect((await reportRow(r.reportId)).status).toBe("draft");
      } finally {
        for (const l of live) await h.owner.update(schema.reports).set({ status: "error" }).where(eq(schema.reports.id, l.reportId));
      }
    });

    it(`${MAX_STARTS_PER_USER} starts per person per 10 minutes: the next is 429 with Retry-After, and a colleague is not affected`, async () => {
      await seedStarts(P.orgId, MAX_STARTS_PER_USER, { actor: P.owner.userId });
      const r = await mkReport(P);
      script(...happy());
      const res = await gen(P.owner, r.reportId, r.sections[0].id);
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(outbound).toHaveLength(0);
      expect((await reportRow(r.reportId)).status).toBe("draft");

      const other = await mkReport(P);
      script(...happy());
      expect((await gen(P.assoc, other.reportId, other.sections[0].id)).status).toBe(200);
    });

    it(`${MAX_STARTS_PER_ORGANIZATION} starts per practice per 10 minutes: everyone in the practice is refused after that`, async () => {
      const have = (await auditRows(P.orgId, "report.generation_started")).length;
      await seedStarts(P.orgId, MAX_STARTS_PER_ORGANIZATION - have);
      const r = await mkReport(P);
      script(...happy());
      const res = await gen(P.assoc, r.reportId, r.sections[0].id);
      expect(res.status).toBe(429);
      expect(outbound).toHaveLength(0);
      expect((await reportRow(r.reportId)).status).toBe("draft");
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("the stub path is not this route's real mode", () => {
    it("with INFERENCE_MODE=stub the route is the stub route again (no body needed), so real mode changes nothing for it", async () => {
      const env = getEnv();
      const P = await makePractice("stubback", { lean: true });
      env.INFERENCE_MODE = "stub";
      try {
        const r = await mkReport(P);
        script(reply("Zed stub answer 4821"));
        const res = await gen(P.owner, r.reportId, r.sections[0].id, null);
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ data: { reportStatus: "generated", section: { id: r.sections[0].id, version: 1, editType: "ai_generated", text: "Zed stub answer 4821" } } });
        expect(outbound).toHaveLength(1);
        expect((await versionRows(r.sections[0].id))[0].llmMetadata).toMatchObject({ mode: "stub" });
      } finally {
        env.INFERENCE_MODE = "real";
      }
    });
  });
});
