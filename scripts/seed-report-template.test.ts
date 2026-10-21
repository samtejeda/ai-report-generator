import { describe, expect, it } from "vitest";
import { templateSlug, templateStructureSchema } from "@/lib/reports/structure";
import { PLACEHOLDER_CONTENT, PLACEHOLDER_NOTES, seedReportTemplate, TEMPLATE_SLUG, TEMPLATE_STRUCTURE } from "./seed-report-template.mjs";

describe("what the script would create", () => {
  it("the structure is valid layout and the slug passes the request validator", () => {
    expect(templateStructureSchema.safeParse(TEMPLATE_STRUCTURE).success).toBe(true);
    expect(templateSlug.safeParse(TEMPLATE_SLUG).success).toBe(true);
    expect(TEMPLATE_STRUCTURE.sections.map((s) => s.key)).toEqual([
      "reason_for_referral",
      "background_information",
      "behavioral_observations",
      "assessment_results",
      "summary_and_impressions",
      "recommendations",
    ]);
  });

  it("the prompt is a placeholder that carries no methodology text", () => {
    expect(PLACEHOLDER_CONTENT).toEqual({ placeholder: true });
    expect(Object.keys(PLACEHOLDER_CONTENT)).toEqual(["placeholder"]);
    expect(PLACEHOLDER_NOTES).toMatch(/placeholder/i);
    expect(PLACEHOLDER_NOTES.length).toBeLessThan(200);
  });
});

// A scripted pool: answers each statement by what it starts with and records the order.
function fakePool(answers: { orgs?: { id: string }[]; owner?: { id: string }[]; dup?: unknown[]; failOn?: string }) {
  const log: string[] = [];
  const client = {
    query: async (sql: string) => {
      const head = sql.trim().split(/\s+/).slice(0, 3).join(" ").toLowerCase();
      log.push(head);
      if (answers.failOn && sql.includes(answers.failOn)) throw Object.assign(new Error("boom"), { code: "XX000" });
      if (sql.includes("from organizations")) return { rows: answers.orgs ?? [{ id: "org-1" }] };
      if (sql.includes("from users")) return { rows: answers.owner ?? [{ id: "user-1" }] };
      if (sql.includes("from report_templates")) return { rows: answers.dup ?? [] };
      if (sql.includes("insert into report_templates")) return { rows: [{ id: "tpl-1" }] };
      if (sql.includes("insert into methodology_prompts")) return { rows: [{ id: "prm-1" }] };
      return { rows: [] };
    },
    release: () => log.push("release"),
  };
  return { pool: { connect: async () => client }, log };
}

describe("seedReportTemplate", () => {
  it("refuses a missing or oversize practice name before touching the database", async () => {
    const untouched = { connect: () => Promise.reject(new Error("the database must not be contacted")) };
    for (const org of [undefined, "", "   ", "x".repeat(201)]) for (const apply of [false, true]) expect(await seedReportTemplate(untouched, { org }, { apply })).toEqual({ status: "invalid_org" });
  });

  it("a dry run changes nothing: it rolls back and inserts nothing", async () => {
    const { pool, log } = fakePool({});
    const r = await seedReportTemplate(pool, { org: "Synthetic Practice" }, { apply: false });
    expect(r.status).toBe("dry_run");
    expect(log.some((l) => l.startsWith("insert"))).toBe(false);
    expect(log).toContain("rollback");
    expect(log).not.toContain("commit");
  });

  it("apply inserts the template, the prompt, moves the pointer, writes the audit rows and commits once", async () => {
    const { pool, log } = fakePool({});
    const r = await seedReportTemplate(pool, { org: "Synthetic Practice" }, { apply: true });
    expect(r).toEqual({ status: "created", organizationId: "org-1", templateId: "tpl-1", promptId: "prm-1" });
    const writes = log.filter((l) => /^(insert|update)/.test(l));
    expect(writes).toEqual(["insert into report_templates", "insert into methodology_prompts", "update report_templates set", "insert into audit_log"]);
    expect(log.filter((l) => l === "commit")).toHaveLength(1);
    expect(log).not.toContain("rollback");
  });

  it.each([
    ["no such practice", { orgs: [] }, "org_not_found"],
    ["two practices of that name", { orgs: [{ id: "a" }, { id: "b" }] }, "org_ambiguous"],
    ["no active owner", { owner: [] }, "owner_not_found"],
    ["the template already exists", { dup: [{}] }, "template_exists"],
  ])("refuses when %s, for dry run and apply, changing nothing", async (_label, answers, status) => {
    for (const apply of [false, true]) {
      const { pool, log } = fakePool(answers);
      expect(await seedReportTemplate(pool, { org: "Synthetic Practice" }, { apply })).toEqual({ status });
      expect(log.some((l) => l.startsWith("insert"))).toBe(false);
      expect(log).not.toContain("commit");
    }
  });

  it("a failure part-way rolls back and is rethrown", async () => {
    const { pool, log } = fakePool({ failOn: "insert into methodology_prompts" });
    await expect(seedReportTemplate(pool, { org: "Synthetic Practice" }, { apply: true })).rejects.toThrow("boom");
    expect(log).toContain("rollback");
    expect(log).not.toContain("commit");
  });
});
