import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { STUB_PROMPT } from "@/lib/ai/inference";
import { getEnv } from "@/lib/env";
import { GENERATION_LEASE_SECONDS, MAX_CONCURRENT_GENERATIONS, MAX_STARTS_PER_ORGANIZATION, MAX_STARTS_PER_USER, RATE_WINDOW_SECONDS } from "@/lib/reports/generation-limits";
import { seedReportTemplate, TEMPLATE_STRUCTURE } from "@/scripts/seed-report-template.mjs";
import { BASE, ENABLED, startHarness, type Handler, type Person } from "./integration-harness";

// Section generation (the dev-stub inference loop) end to end: the REAL route modules, REAL Better
// Auth sessions, the REAL app_runtime / auth_runtime roles with row-level security and the
// migration 0013 triggers, on the scratch database. The ONLY thing replaced is the network: the
// outbound request to the practice's *.ts.net address is answered by a stub of global fetch, which
// also records every request so the tests can say exactly what left the app. Synthetic data only.
//
// Needs the TEST_* variables (see lib/auth/integration-harness.ts); skipped when absent.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ENDPOINT = "https://stub-box.synthtail.ts.net";
const ANSWER = "Zed stub answer 4821";

type Outbound = { url: string; headers: Headers; body: Record<string, unknown> };
type Plan = (call: Outbound) => Response | Promise<Response>;

function completion(content: string, usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage,
  };
}
const okPlan =
  (content = ANSWER): Plan =>
  () =>
    new Response(JSON.stringify(completion(content)), { status: 200, headers: { "content-type": "application/json" } });

describe.skipIf(!ENABLED)("section generation through the real stack", () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let generate: { POST: Handler };
  let finalize: { POST: Handler };
  let detail: { GET: Handler };

  type Practice = { orgId: string; owner: Person; assoc: Person; assoc2: Person; admin: Person; tpl: { templateId: string; promptId: string }; c1: { id: string; displayName: string }; c2: { id: string } };
  let A: Practice;
  let B: Practice;

  const tag = () => crypto.randomUUID().slice(0, 8);

  // ---- the stubbed network ---------------------------------------------------------------
  const outbound: Outbound[] = [];
  const elsewhere: string[] = [];
  let plan: Plan = okPlan();
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).hostname.endsWith(".ts.net")) {
        const call = { url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
        outbound.push(call);
        return plan(call);
      }
      elsewhere.push(new URL(url).hostname);
      return realFetch(input, init);
    });
  });
  beforeEach(() => {
    outbound.length = 0;
    elsewhere.length = 0;
    plan = okPlan();
  });
  afterEach(() => {
    plan = okPlan();
  });

  // ---- helpers ---------------------------------------------------------------------------
  const gen = (who: Person, reportId: string, sectionId: string, o: { origin?: string | null; rawBody?: string; body?: unknown } = {}) =>
    h.call(who, generate.POST, { method: "POST", path: `/api/reports/${reportId}/sections/${sectionId}/generate`, params: { id: reportId, sectionId }, ...o });
  const fin = (who: Person, id: string) => h.call(who, finalize.POST, { method: "POST", path: `/api/reports/${id}/finalize`, params: { id } });
  const get = (who: Person, id: string) => h.call(who, detail.GET, { path: `/api/reports/${id}`, params: { id } });

  const assign = (orgId: string, clientId: string, user: Person, by: Person) =>
    h.owner.insert(schema.clientAssignments).values({ organizationId: orgId, clientId, userId: user.userId, assignedByUserId: by.userId });

  async function mkReport(
    p: Practice,
    clientId: string,
    status: typeof schema.reports.$inferSelect.status = "draft",
    o: { updatedAt?: Date; sectionType?: "prose" | "structured" } = {},
  ) {
    const [r] = await h.owner
      .insert(schema.reports)
      .values({
        organizationId: p.orgId,
        clientId,
        templateId: p.tpl.templateId,
        methodologyPromptId: p.tpl.promptId,
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
  const startRows = (orgId: string) => auditRows(orgId, "report.generation_started");

  // Each person may start 10 generations per 10 minutes and a practice 30 (that is the point), so a
  // test that generates gets a practice of its own. `lean` makes only the owner and one associate.
  async function makePractice(label: string, o: { endpoint?: string | null; lean?: boolean } = {}): Promise<Practice> {
    const name = `gen-${label}-${tag()}`;
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
    const endpoint = o.endpoint === undefined ? ENDPOINT : o.endpoint;
    if (endpoint) await h.owner.update(schema.organizations).set({ inferenceEndpoint: endpoint }).where(eq(schema.organizations.id, orgId));
    const [c1] = await h.owner
      .insert(schema.clients)
      .values({ organizationId: orgId, displayName: `Synthetic Client ${tag()}`, dateOfBirth: "2016-04-02", gradeLevel: "3", externalId: `EXT-${tag()}` })
      .returning();
    const [c2] = await h.owner.insert(schema.clients).values({ organizationId: orgId, displayName: `Synthetic Client ${tag()}` }).returning();
    await assign(orgId, c1.id, assoc, owner);
    if (!o.lean) {
      await assign(orgId, c1.id, admin, owner);
      await assign(orgId, c2.id, assoc2, owner);
    }
    return { orgId, owner, assoc, assoc2, admin, tpl: { templateId: t.id, promptId: t.activeMethodologyPromptId! }, c1, c2 };
  }

  /** Writes ledger rows the way a real start does (the owner connection may insert, never change, audit rows). */
  async function seedStarts(orgId: string, n: number, o: { actor?: string; ageSeconds?: number } = {}) {
    const when = new Date(Date.now() - (o.ageSeconds ?? 0) * 1000);
    await h.owner.insert(schema.auditLog).values(
      Array.from({ length: n }, () => ({
        organizationId: orgId,
        actorUserId: o.actor ?? crypto.randomUUID(),
        action: "report.generation_started",
        resourceType: "report_generation",
        resourceId: crypto.randomUUID(),
        metadata: { role: "owner" },
        createdAt: when,
      })),
    );
  }

  beforeAll(async () => {
    h = await startHarness({ appRole: "app_runtime_generation", authRole: "auth_runtime_generation", secret: "generation-test-secret-".padEnd(48, "x") });
    generate = (await import("@/app/api/reports/[id]/sections/[sectionId]/generate/route")) as unknown as typeof generate;
    finalize = (await import("@/app/api/reports/[id]/finalize/route")) as unknown as typeof finalize;
    detail = (await import("@/app/api/reports/[id]/route")) as unknown as typeof detail;
    expect(getEnv().INFERENCE_MODE).toBe("stub");
    A = await makePractice("a");
    B = await makePractice("b");
  }, 600_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await h?.stop();
  });

  // ---------------------------------------------------------------------------------------
  describe("a successful generation", () => {
    let S: Practice;
    beforeEach(async () => {
      S = await makePractice("s", { lean: true });
    });

    it("owner: 200, stores one ai_generated version 1 with closed metadata, report becomes generated, finalize is now reachable", async () => {
      const r = await mkReport(S, S.c1.id);
      const s = r.sections[0];
      const res = await gen(S.owner, r.reportId, s.id);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.json).toEqual({ data: { reportStatus: "generated", section: { id: s.id, version: 1, editType: "ai_generated", text: ANSWER } } });

      const rows = await versionRows(s.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ versionNumber: 1, editType: "ai_generated", content: { text: ANSWER }, createdByUserId: null, reportId: r.reportId, organizationId: S.orgId });
      expect(rows[0].llmMetadata).toEqual({ mode: "stub", model: "qwen3:1.7b", inputTokens: 12, outputTokens: 3, latencyMs: expect.any(Number), costUsd: 0 });
      expect((await reportRow(r.reportId)).status).toBe("generated");
      // The other five sections are untouched.
      for (const other of r.sections.slice(1)) expect(await versionRows(other.id)).toHaveLength(0);

      const detailRes = await get(S.owner, r.reportId);
      const shown = (detailRes.json.data as { sections: { id: string; text: string; editType: string | null; version: number }[] }).sections.find((x) => x.id === s.id)!;
      expect(shown).toMatchObject({ text: ANSWER, editType: "ai_generated", version: 1 });

      // Before this change nothing could reach `generated`; now finalize works on the result.
      expect((await fin(S.owner, r.reportId)).status).toBe(200);
      expect((await reportRow(r.reportId)).status).toBe("finalized");
    });

    it("an associate assigned to the client may generate; the audit rows hold ids, role, model, counts and latency only", async () => {
      const r = await mkReport(S, S.c1.id);
      const res = await gen(S.assoc, r.reportId, r.sections[1].id);
      expect(res.status).toBe(200);
      const [started] = (await startRows(S.orgId)).filter((a) => a.resourceId === r.reportId);
      expect(started).toMatchObject({ actorUserId: S.assoc.userId, resourceType: "report_generation", outcome: "success", metadata: { role: "associate" } });
      const [version] = await versionRows(r.sections[1].id);
      const [done] = (await auditRows(S.orgId, "report.generated")).filter((a) => a.resourceId === version.id);
      expect(done).toMatchObject({ actorUserId: S.assoc.userId, resourceType: "report_version", metadata: { role: "associate", mode: "stub", model: "qwen3:1.7b", input_tokens: 12, output_tokens: 3, latency_ms: expect.any(Number) } });
    });

    it("sends the one fixed neutral prompt to the practice's own address and nothing else, anywhere", async () => {
      const r = await mkReport(S, S.c1.id);
      const res = await gen(S.owner, r.reportId, r.sections[2].id);
      expect(res.status).toBe(200);
      expect(outbound).toHaveLength(1);
      const [call] = outbound;
      expect(call.url).toBe(`${ENDPOINT}/v1/chat/completions`);
      expect(elsewhere).toEqual([]);
      expect(call.body.messages).toEqual([{ role: "user", content: STUB_PROMPT }]);
      expect(Object.keys(call.body).sort()).toEqual(["max_tokens", "messages", "model", "reasoning_effort", "temperature"]);
      expect(call.body.model).toBe("qwen3:1.7b");

      // Nothing about the client, the report or the person is in what was sent (body or headers).
      const sent = JSON.stringify([call.body, [...call.headers.entries()]]);
      const [c1] = await h.owner.select().from(schema.clients).where(eq(schema.clients.id, S.c1.id));
      const needles = [c1.displayName, c1.dateOfBirth!, c1.externalId!, r.reportId, r.sections[2].id, r.sections[2].sectionKey, "Reason for Referral", "Assessment Results", S.orgId, S.c1.id, S.owner.userId, S.owner.email, S.tpl.promptId, "placeholder"];
      for (const needle of needles) expect(sent, needle).not.toContain(needle);
      expect(call.headers.get("cookie")).toBeNull();
      expect(call.headers.get("authorization")).toBeNull();
    });

    it("the practice's model_config chooses the stub model tag; the tag is checked, not trusted", async () => {
      await h.owner.update(schema.organizations).set({ modelConfig: { stub: "custom-stub:1b" } }).where(eq(schema.organizations.id, S.orgId));
      try {
        const r = await mkReport(S, S.c1.id);
        expect((await gen(S.owner, r.reportId, r.sections[0].id)).status).toBe(200);
        expect(outbound[0].body.model).toBe("custom-stub:1b");
        expect((await versionRows(r.sections[0].id))[0].llmMetadata).toMatchObject({ model: "custom-stub:1b" });

        // A tag that is not a tag reaches the library, which refuses it: nothing is sent and the report ends in error.
        await h.owner.update(schema.organizations).set({ modelConfig: { stub: "bad model; drop table" } }).where(eq(schema.organizations.id, S.orgId));
        outbound.length = 0;
        const r2 = await mkReport(S, S.c1.id);
        const res = await gen(S.owner, r2.reportId, r2.sections[0].id);
        expect(res.status).toBe(502);
        expect(outbound).toHaveLength(0);
        expect((await reportRow(r2.reportId)).status).toBe("error");
        expect((await auditRows(S.orgId, "report.generation_failed")).find((a) => a.resourceId === r2.reportId)?.metadata).toMatchObject({ reason: "invalid_config" });
      } finally {
        await h.owner.update(schema.organizations).set({ modelConfig: {} }).where(eq(schema.organizations.id, S.orgId));
      }
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("who may call", () => {
    it("no session is 401 and nothing happens", async () => {
      const r = await mkReport(A, A.c1.id);
      const res = await gen({ label: "nobody", orgId: "none" } as Person, r.reportId, r.sections[0].id);
      expect(res.status).toBe(401);
      expect(outbound).toHaveLength(0);
      expect((await reportRow(r.reportId)).status).toBe("draft");
    });

    it("an admin is 403 and audited, even with a grant on the client; no call, no change, no quota used", async () => {
      const r = await mkReport(A, A.c1.id);
      const before = (await startRows(A.orgId)).length;
      const denied0 = (await auditRows(A.orgId, "authz.denied")).filter((a) => a.actorUserId === A.admin.userId).length;
      const res = await gen(A.admin, r.reportId, r.sections[0].id);
      expect(res.status).toBe(403);
      expect(res.json.error?.code).toBe("forbidden");
      expect(outbound).toHaveLength(0);
      expect((await reportRow(r.reportId)).status).toBe("draft");
      expect((await startRows(A.orgId)).length).toBe(before);
      expect((await auditRows(A.orgId, "authz.denied")).filter((a) => a.actorUserId === A.admin.userId).length - denied0).toBe(1);
    });

    it("an associate NOT assigned to the client gets the same 404 as a made-up id: no call, no change, no quota used", async () => {
      const r = await mkReport(A, A.c1.id); // c1 is assigned to assoc, not to assoc2
      const before = (await startRows(A.orgId)).length;
      const stranger = await gen(A.assoc2, r.reportId, r.sections[0].id);
      const madeUp = await gen(A.assoc2, crypto.randomUUID(), crypto.randomUUID());
      expect(stranger.status).toBe(404);
      expect(stranger.json).toEqual(madeUp.json);
      expect(outbound).toHaveLength(0);
      expect((await reportRow(r.reportId)).status).toBe("draft");
      expect(await versionRows(r.sections[0].id)).toHaveLength(0);
      expect((await startRows(A.orgId)).length).toBe(before);
    });

    it("an associate whose assignment has ended loses the report on the next request", async () => {
      const r = await mkReport(A, A.c2.id);
      expect((await gen(A.assoc2, r.reportId, r.sections[0].id)).status).toBe(200);
      const r2 = await mkReport(A, A.c2.id);
      await h.owner.update(schema.clientAssignments).set({ deletedAt: new Date() }).where(and(eq(schema.clientAssignments.clientId, A.c2.id), eq(schema.clientAssignments.userId, A.assoc2.userId)));
      try {
        outbound.length = 0;
        expect((await gen(A.assoc2, r2.reportId, r2.sections[0].id)).status).toBe(404);
        expect(outbound).toHaveLength(0);
      } finally {
        await h.owner.update(schema.clientAssignments).set({ deletedAt: null }).where(and(eq(schema.clientAssignments.clientId, A.c2.id), eq(schema.clientAssignments.userId, A.assoc2.userId)));
      }
    });

    it("the other practice's owner, who has its own endpoint, gets the same 404 for this practice's ids; nothing is sent", async () => {
      const r = await mkReport(A, A.c1.id);
      const res = await gen(B.owner, r.reportId, r.sections[0].id);
      expect(res.status).toBe(404);
      expect(res.json).toEqual((await gen(B.owner, crypto.randomUUID(), crypto.randomUUID())).json);
      expect(outbound).toHaveLength(0);
      expect((await reportRow(r.reportId)).status).toBe("draft");
      expect(await versionRows(r.sections[0].id)).toHaveLength(0);
    });

    it("a section id from another report (same practice) is 404 and changes nothing", async () => {
      const r1 = await mkReport(A, A.c1.id);
      const r2 = await mkReport(A, A.c1.id);
      const res = await gen(A.owner, r1.reportId, r2.sections[0].id);
      expect(res.status).toBe(404);
      expect(outbound).toHaveLength(0);
      for (const id of [r1.reportId, r2.reportId]) expect((await reportRow(id)).status).toBe("draft");
      expect(await versionRows(r2.sections[0].id)).toHaveLength(0);
    });

    it("malformed ids and any body but empty or {} are 400; a deleted client takes its reports with it", async () => {
      const r = await mkReport(A, A.c1.id);
      const s = r.sections[0].id;
      expect((await gen(A.owner, "not-a-uuid", s)).status).toBe(400);
      expect((await gen(A.owner, r.reportId, "nope")).status).toBe(400);
      for (const rawBody of ['{"text":"x"}', "[]", "null", "x".repeat(40), "not json"]) expect((await gen(A.owner, r.reportId, s, { rawBody })).status, rawBody).toBe(400);
      expect(outbound).toHaveLength(0);
      expect((await gen(A.owner, r.reportId, s, { rawBody: "{}" })).status).toBe(200);

      const [gone] = await h.owner.insert(schema.clients).values({ organizationId: A.orgId, displayName: `Synthetic Gone ${tag()}`, deletedAt: new Date() }).returning();
      const r3 = await mkReport(A, gone.id);
      outbound.length = 0;
      expect((await gen(A.owner, r3.reportId, r3.sections[0].id)).status).toBe(404);
      expect(outbound).toHaveLength(0);
    });

    it.each([
      ["a cross-site origin", "https://evil.example"],
      ["a look-alike origin", `${BASE}.evil.example`],
      ["the string null", "null"],
      ["no origin at all", null],
    ])("is 403 with %s, even for a valid owner, and changes nothing", async (_label, origin) => {
      const r = await mkReport(A, A.c1.id);
      const res = await gen(A.owner, r.reportId, r.sections[0].id, { origin });
      expect(res.status).toBe(403);
      for (const name of res.headers.keys()) expect(name.toLowerCase()).not.toMatch(/^access-control-/);
      expect(outbound).toHaveLength(0);
      expect((await reportRow(r.reportId)).status).toBe("draft");
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("no endpoint, no call", () => {
    it("a practice with no inference endpoint: 409 inference_not_configured, nothing sent, status unchanged, no start row", async () => {
      const P = await makePractice("noendpoint", { endpoint: null, lean: true });
      const r = await mkReport(P, P.c1.id);
      const res = await gen(P.owner, r.reportId, r.sections[0].id);
      expect(res.status).toBe(409);
      expect(res.json.error?.code).toBe("inference_not_configured");
      expect(outbound).toHaveLength(0);
      expect(elsewhere).toEqual([]);
      expect((await reportRow(r.reportId)).status).toBe("draft");
      expect(await versionRows(r.sections[0].id)).toHaveLength(0);
      expect(await startRows(P.orgId)).toHaveLength(0);
      expect(await auditRows(P.orgId, "report.generation_failed")).toHaveLength(0);
    });

    it("a model_config that is not usable is the same refusal", async () => {
      const P = await makePractice("badconfig", { lean: true });
      await h.owner.update(schema.organizations).set({ modelConfig: { stub: 5 } }).where(eq(schema.organizations.id, P.orgId));
      const r = await mkReport(P, P.c1.id);
      const res = await gen(P.owner, r.reportId, r.sections[0].id);
      expect(res.status).toBe(409);
      expect(res.json.error?.code).toBe("inference_not_configured");
      expect(outbound).toHaveLength(0);
      expect((await reportRow(r.reportId)).status).toBe("draft");
    });

    it("INFERENCE_MODE other than stub: the same refusal before the database is touched", async () => {
      const env = getEnv() as { INFERENCE_MODE: string };
      env.INFERENCE_MODE = "real";
      try {
        const r = await mkReport(A, A.c1.id);
        const before = (await startRows(A.orgId)).length;
        const res = await gen(A.owner, r.reportId, r.sections[0].id);
        expect(res.status).toBe(409);
        expect(res.json.error?.code).toBe("inference_not_configured");
        expect(outbound).toHaveLength(0);
        expect((await reportRow(r.reportId)).status).toBe("draft");
        expect((await startRows(A.orgId)).length).toBe(before);
      } finally {
        env.INFERENCE_MODE = "stub";
      }
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("when the model does not deliver, the report is never left generating", () => {
    let S: Practice;
    beforeEach(async () => {
      S = await makePractice("s", { lean: true });
    });

    const cases: [string, Plan, number, string][] = [
      ["the endpoint is unreachable", () => Promise.reject(new TypeError("fetch failed")), 502, "unreachable"],
      ["the call times out", () => Promise.reject(new DOMException("The operation timed out", "TimeoutError")), 504, "timeout"],
      ["the endpoint answers 500", () => new Response("internal secret detail", { status: 500 }), 502, "bad_response"],
      ["the endpoint answers 404", () => new Response("no such model", { status: 404 }), 502, "bad_response"],
      ["the answer is not JSON", () => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } }), 502, "bad_response"],
      ["the model returns empty content", okPlan(""), 502, "bad_response"],
      ["the model returns only whitespace", okPlan("  \n\t "), 502, "bad_response"],
      ["the model returns only reasoning", okPlan("<think>only thoughts</think>"), 502, "bad_response"],
      ["the model returns control characters", okPlan("fine\u0007text"), 502, "invalid_output"],
      ["the model returns more than a section may hold", okPlan("x".repeat(20_001)), 502, "invalid_output"],
    ];

    it.each(cases)("%s: report ends in error, nothing stored, one failure row with a code only, no detail in the response", async (_label, p, status, reason) => {
      const r = await mkReport(S, S.c1.id);
      plan = p;
      const res = await gen(S.owner, r.reportId, r.sections[0].id);
      expect(res.status).toBe(status);
      expect(res.json.error?.code).toBe("inference_failed");
      expect(res.text).not.toMatch(/secret detail|no such model|gateway|ts\.net|fetch failed|stub-box|qwen/i);
      expect((await reportRow(r.reportId)).status).toBe("error");
      expect(await versionRows(r.sections[0].id)).toHaveLength(0);
      const failed = (await auditRows(S.orgId, "report.generation_failed")).filter((a) => a.resourceId === r.reportId);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ outcome: "failure", actorUserId: S.owner.userId, metadata: expect.objectContaining({ reason, role: "owner", mode: "stub" }) });
      expect(JSON.stringify(failed[0].metadata)).not.toMatch(/ts\.net|secret detail|http/);

      // And it recovers: error -> generating -> generated.
      plan = okPlan();
      const again = await gen(S.owner, r.reportId, r.sections[0].id);
      expect(again.status).toBe(200);
      expect((await reportRow(r.reportId)).status).toBe("generated");
      expect(await versionRows(r.sections[0].id)).toHaveLength(1);
    });

    it("a transport that throws something odd is a 500 with no detail, and still not stuck", async () => {
      const r = await mkReport(S, S.c1.id);
      plan = () => {
        throw Object.assign(new Error("secret internal detail"), { code: "EWHATEVER" });
      };
      const res = await gen(S.owner, r.reportId, r.sections[0].id);
      expect([500, 502]).toContain(res.status);
      expect(res.text).not.toContain("secret internal detail");
      expect((await reportRow(r.reportId)).status).toBe("error");
    });

    it("nothing from the model leaks into the audit log", async () => {
      const r = await mkReport(S, S.c1.id);
      plan = okPlan("Zed leak canary 9917");
      expect((await gen(S.owner, r.reportId, r.sections[3].id)).status).toBe(200);
      const rows = await h.owner.select().from(schema.auditLog).where(eq(schema.auditLog.organizationId, S.orgId));
      const text = JSON.stringify(rows);
      for (const needle of ["Zed leak canary", ANSWER, "ts.net", "stub-box", STUB_PROMPT, "Synthetic Client", "Reason for Referral"]) expect(text, needle).not.toContain(needle);
      for (const row of rows.filter((x) => x.action.startsWith("report.generat"))) {
        expect(Object.keys(row.metadata as object).every((k) => ["role", "mode", "model", "input_tokens", "output_tokens", "latency_ms", "reason"].includes(k)), row.action).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("state rules", () => {
    let S: Practice;
    beforeEach(async () => {
      S = await makePractice("s", { lean: true });
    });

    it.each(["generated", "finalized"] as const)("a %s report: 409, nothing sent, nothing changes", async (status) => {
      const r = await mkReport(S, S.c1.id, status);
      const res = await gen(S.owner, r.reportId, r.sections[0].id);
      expect(res.status).toBe(409);
      expect(res.json.error?.code).toBe("conflict");
      expect(outbound).toHaveLength(0);
      expect((await reportRow(r.reportId)).status).toBe(status);
      expect(await versionRows(r.sections[0].id)).toHaveLength(0);
    });

    it("a second section of a report that already generated one is refused until the status rules allow it (generated -> generating does not exist)", async () => {
      const r = await mkReport(S, S.c1.id);
      expect((await gen(S.owner, r.reportId, r.sections[0].id)).status).toBe(200);
      outbound.length = 0;
      expect((await gen(S.owner, r.reportId, r.sections[1].id)).status).toBe(409);
      expect(outbound).toHaveLength(0);
    });

    it("a section that already has text is never replaced", async () => {
      const r = await mkReport(S, S.c1.id);
      await h.owner.insert(schema.reportVersions).values({ organizationId: S.orgId, reportId: r.reportId, sectionId: r.sections[0].id, versionNumber: 1, editType: "human_edit", content: { text: "A person wrote this." }, createdByUserId: S.owner.userId });
      const res = await gen(S.owner, r.reportId, r.sections[0].id);
      expect(res.status).toBe(409);
      expect(outbound).toHaveLength(0);
      expect((await reportRow(r.reportId)).status).toBe("draft");
      expect((await versionRows(r.sections[0].id)).map((v) => v.content)).toEqual([{ text: "A person wrote this." }]);
    });

    it("a structured section is refused (this loop writes prose only)", async () => {
      const r = await mkReport(S, S.c1.id, "draft", { sectionType: "structured" });
      expect((await gen(S.owner, r.reportId, r.sections[0].id)).status).toBe(409);
      expect(outbound).toHaveLength(0);
      expect((await reportRow(r.reportId)).status).toBe("draft");
    });

    it("while a run is in flight the report is generating, a person cannot edit it, a second request is 409 and sends nothing more", async () => {
      const r = await mkReport(S, S.c1.id);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      plan = async () => {
        await held;
        return okPlan()({} as Outbound);
      };
      const first = gen(S.owner, r.reportId, r.sections[0].id);
      await vi.waitFor(() => expect(outbound).toHaveLength(1), { timeout: 20_000 });
      expect((await reportRow(r.reportId)).status).toBe("generating");

      const second = await gen(S.owner, r.reportId, r.sections[1].id);
      expect(second.status).toBe(409);
      const section = (await import("@/app/api/reports/[id]/sections/[sectionId]/route")) as unknown as { PUT: Handler };
      const edit = await h.call(S.owner, section.PUT, { method: "PUT", path: "/x", body: { text: "x", baseVersion: 0 }, params: { id: r.reportId, sectionId: r.sections[1].id } });
      expect(edit.status).toBe(409);
      expect(outbound).toHaveLength(1);

      release();
      expect((await first).status).toBe(200);
      expect((await reportRow(r.reportId)).status).toBe("generated");
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("abandoned runs (the function that started them died)", () => {
    const old = () => new Date(Date.now() - (GENERATION_LEASE_SECONDS + 60) * 1000);

    it("a report generating past the lease is reclaimed by the next request, which then succeeds; the reclaim is recorded", async () => {
      const S = await makePractice("s", { lean: true });
      const r = await mkReport(S, S.c1.id, "generating", { updatedAt: old() });
      const res = await gen(S.owner, r.reportId, r.sections[0].id);
      expect(res.status).toBe(200);
      expect((await reportRow(r.reportId)).status).toBe("generated");
      const stale = (await auditRows(S.orgId, "report.generation_failed")).filter((a) => a.resourceId === r.reportId);
      expect(stale.map((a) => a.metadata)).toEqual([{ reason: "stale", role: "owner" }]);
    });

    it("a report generating inside the lease is not touched", async () => {
      const S = await makePractice("s", { lean: true });
      const r = await mkReport(S, S.c1.id, "generating");
      const res = await gen(S.owner, r.reportId, r.sections[0].id);
      expect(res.status).toBe(409);
      expect(outbound).toHaveLength(0);
      expect((await reportRow(r.reportId)).status).toBe("generating");
    });

    it("an abandoned run does not count toward the concurrency cap, a live one does", async () => {
      const P = await makePractice("lease", { lean: true });
      for (let i = 0; i < MAX_CONCURRENT_GENERATIONS; i++) await mkReport(P, P.c1.id, "generating", { updatedAt: old() });
      const r = await mkReport(P, P.c1.id);
      expect((await gen(P.owner, r.reportId, r.sections[0].id)).status).toBe(200);

      const Q = await makePractice("live", { lean: true });
      for (let i = 0; i < MAX_CONCURRENT_GENERATIONS; i++) await mkReport(Q, Q.c1.id, "generating");
      const r2 = await mkReport(Q, Q.c1.id);
      const res = await gen(Q.owner, r2.reportId, r2.sections[0].id);
      expect(res.status).toBe(429);
      expect(res.json.error?.code).toBe("rate_limited");
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("limits", () => {
    it("concurrency: five simultaneous requests in one practice, a cap of two: exactly two reach the model, three are 429 with Retry-After", async () => {
      const P = await makePractice("conc", { lean: true });
      const reports = await Promise.all(Array.from({ length: 5 }, () => mkReport(P, P.c1.id)));
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      plan = async () => {
        await held;
        return okPlan()({} as Outbound);
      };
      const calls = reports.map((r) => gen(P.owner, r.reportId, r.sections[0].id));
      const settled: Awaited<ReturnType<typeof gen>>[] = [];
      calls.forEach((c) => void c.then((res) => settled.push(res)));
      await vi.waitFor(() => expect(outbound).toHaveLength(MAX_CONCURRENT_GENERATIONS), { timeout: 30_000 });
      // The refused ones answer while the two are still running.
      await vi.waitFor(() => expect(settled).toHaveLength(5 - MAX_CONCURRENT_GENERATIONS), { timeout: 30_000 });
      expect(settled.every((x) => x.status === 429)).toBe(true);
      expect(outbound).toHaveLength(MAX_CONCURRENT_GENERATIONS);
      for (const res of settled) {
        expect(res.json.error?.code).toBe("rate_limited");
        expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      }
      release();
      const done = await Promise.all(calls);
      expect(done.filter((x) => x.status === 200)).toHaveLength(MAX_CONCURRENT_GENERATIONS);
      expect(outbound).toHaveLength(MAX_CONCURRENT_GENERATIONS);
      // The refused reports are untouched and the practice's other cap is not used up by them.
      const statuses = await Promise.all(reports.map(async (r) => (await reportRow(r.reportId)).status));
      expect(statuses.filter((s) => s === "generated")).toHaveLength(MAX_CONCURRENT_GENERATIONS);
      expect(statuses.filter((s) => s === "draft")).toHaveLength(5 - MAX_CONCURRENT_GENERATIONS);
      expect(await startRows(P.orgId)).toHaveLength(MAX_CONCURRENT_GENERATIONS);
    });

    it("another practice is not affected by this practice's running generations", async () => {
      const P = await makePractice("busy-a", { lean: true });
      const Q = await makePractice("busy-b", { lean: true });
      for (let i = 0; i < MAX_CONCURRENT_GENERATIONS; i++) await mkReport(P, P.c1.id, "generating");
      const rP = await mkReport(P, P.c1.id);
      expect((await gen(P.owner, rP.reportId, rP.sections[0].id)).status).toBe(429);
      const rQ = await mkReport(Q, Q.c1.id);
      expect((await gen(Q.owner, rQ.reportId, rQ.sections[0].id)).status).toBe(200);
    });

    it(`per person: after ${MAX_STARTS_PER_USER} starts in the window the next is 429 with Retry-After, before any report is touched; starts outside the window and other people's do not count`, async () => {
      const P = await makePractice("rate-user", { lean: true });
      await seedStarts(P.orgId, MAX_STARTS_PER_USER - 1, { actor: P.owner.userId });
      await seedStarts(P.orgId, 5, { actor: P.owner.userId, ageSeconds: RATE_WINDOW_SECONDS + 60 }); // too old to count
      await seedStarts(P.orgId, 5, { actor: P.assoc.userId }); // someone else's
      const r1 = await mkReport(P, P.c1.id);
      expect((await gen(P.owner, r1.reportId, r1.sections[0].id)).status).toBe(200); // the 10th

      const r2 = await mkReport(P, P.c1.id);
      const res = await gen(P.owner, r2.reportId, r2.sections[0].id);
      expect(res.status).toBe(429);
      expect(res.json.error?.code).toBe("rate_limited");
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(RATE_WINDOW_SECONDS);
      expect((await reportRow(r2.reportId)).status).toBe("draft");
      expect(outbound).toHaveLength(1);

      // A different person in the same practice still can.
      const r3 = await mkReport(P, P.c1.id);
      expect((await gen(P.assoc, r3.reportId, r3.sections[0].id)).status).toBe(200);
    });

    it(`per practice: after ${MAX_STARTS_PER_ORGANIZATION} starts in the window by anyone the next is 429, in this practice only`, async () => {
      const P = await makePractice("rate-org", { lean: true });
      const Q = await makePractice("rate-org-other", { lean: true });
      await seedStarts(P.orgId, MAX_STARTS_PER_ORGANIZATION - 1);
      const r1 = await mkReport(P, P.c1.id);
      expect((await gen(P.owner, r1.reportId, r1.sections[0].id)).status).toBe(200); // the 30th
      const r2 = await mkReport(P, P.c1.id);
      const res = await gen(P.assoc, r2.reportId, r2.sections[0].id);
      expect(res.status).toBe(429);
      expect(res.json.error?.code).toBe("rate_limited");
      expect((await reportRow(r2.reportId)).status).toBe("draft");

      const rQ = await mkReport(Q, Q.c1.id);
      expect((await gen(Q.owner, rQ.reportId, rQ.sections[0].id)).status).toBe(200);
    });

    it("a refused request (404, 409, admin 403) does not use up the person's quota", async () => {
      const P = await makePractice("quota");
      const before = (await startRows(P.orgId)).length;
      const r = await mkReport(P, P.c1.id, "generated");
      await gen(P.owner, r.reportId, r.sections[0].id); // 409
      await gen(P.owner, crypto.randomUUID(), crypto.randomUUID()); // 404
      await gen(P.assoc2, r.reportId, r.sections[0].id); // 404 (not assigned)
      await gen(P.admin, r.reportId, r.sections[0].id); // 403
      expect((await startRows(P.orgId)).length).toBe(before);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("what leaks", () => {
    it("responses carry only the documented fields, never metadata, ids of the organization or the endpoint", async () => {
      const S = await makePractice("leak", { lean: true });
      const r = await mkReport(S, S.c1.id);
      const res = await gen(S.owner, r.reportId, r.sections[4].id);
      expect(Object.keys(res.json)).toEqual(["data"]);
      expect(Object.keys(res.json.data as object).sort()).toEqual(["reportStatus", "section"]);
      expect(Object.keys((res.json.data as { section: object }).section).sort()).toEqual(["editType", "id", "text", "version"]);
      for (const needle of [S.orgId, "ts.net", "qwen", "llm", "latency", "tokens"]) expect(res.text, needle).not.toContain(needle);
    });


    it("nothing a practice-B caller received contains a practice-A report, section or client id", async () => {
      const reportsA = await h.owner.select().from(schema.reports).where(eq(schema.reports.organizationId, A.orgId));
      const sectionsA = await h.owner.select().from(schema.reportSections).where(inArray(schema.reportSections.reportId, reportsA.map((r) => r.id)));
      expect(reportsA.length).toBeGreaterThan(5);
      const idsA = [...reportsA.map((r) => r.id), ...sectionsA.map((s) => s.id), A.c1.id, A.c2.id];
      for (const seen of h.seen) {
        if (seen.orgId === B.orgId) for (const id of idsA) expect(seen.text, `${seen.caller} saw ${id}`).not.toContain(id);
      }
    });
  });
});
