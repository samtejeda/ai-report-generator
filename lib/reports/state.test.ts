import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import type { SectionState, ReportStateView } from "@/lib/db/report-state";
import { STATE_READS_PER_MINUTE } from "./state-limits";

// The "someone changed this section" check (GET /api/reports/{id}/state): static and SQL-shape
// tests without a database. Behavior against a real one is in lib/auth/state.integration.test.ts.
const ROUTE = "app/api/reports/[id]/state/route.ts";
const DATA = "lib/db/report-state.ts";
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the limit", () => {
  it("is 120 per person per minute, in one constant, and API.md says the same", () => {
    expect(STATE_READS_PER_MINUTE).toBe(120);
    expect(readFileSync("API.md", "utf8")).toContain(`${STATE_READS_PER_MINUTE} per person per minute`);
  });

  it("the other numbers in the route and data module come from that constant only", () => {
    for (const file of [ROUTE, DATA]) expect(code(readFileSync(file, "utf8")), file).not.toMatch(/\b120\b/);
  });
});

describe("no audit row, by decision", () => {
  it.each([ROUTE, DATA])("%s neither imports lib/audit nor calls audit()", (file) => {
    const src = code(readFileSync(file, "utf8"));
    expect(src).not.toMatch(/lib\/audit/);
    expect(src).not.toMatch(/\baudit\s*\(/);
    expect(src).not.toMatch(/auditLog/);
  });
});

describe("the route", () => {
  it("names all three roles, literally, and is a GET only", () => {
    const src = readFileSync(ROUTE, "utf8");
    expect(src).toMatch(/export const GET = guardedRoute/);
    expect(/export const (POST|PUT|PATCH|DELETE)\b/.test(src)).toBe(false);
    expect(JSON.parse(/roles:\s*(\[[^\]]*\])/.exec(src)![1])).toEqual(["owner", "associate", "admin"]);
  });

  it("the response type has exactly the documented fields, and no text, title or id of a person", () => {
    const section: SectionState = { id: "x", version: 0, editType: null, editedAt: null, authorName: null };
    const view: ReportStateView = { status: "draft", sections: [section] };
    expect(Object.keys(section).sort()).toEqual(["authorName", "editType", "editedAt", "id", "version"]);
    expect(Object.keys(view).sort()).toEqual(["sections", "status"]);
  });
});

describe("the counter table", () => {
  it("the table is a counter table: registered, written only by this method (not an updatable table)", async () => {
    const { COUNTER_TABLES, UPDATABLE_TABLES, TENANT_TABLES } = await import("@/lib/db/tenant");
    expect(COUNTER_TABLES).toEqual([schema.readLimitCounters]);
    expect((UPDATABLE_TABLES as readonly unknown[]).includes(schema.readLimitCounters)).toBe(false);
    expect((TENANT_TABLES as readonly unknown[]).includes(schema.readLimitCounters)).toBe(true);
  });

  it("the migration gives app_runtime select, insert and update of the counting columns only, no delete", () => {
    const sql = readFileSync("drizzle/0014_read_limit_counters.sql", "utf8");
    expect(sql).toContain('ALTER TABLE "read_limit_counters" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain("GRANT SELECT, INSERT ON read_limit_counters TO app_runtime");
    expect(sql).toContain("GRANT UPDATE (window_start, count, updated_at) ON read_limit_counters TO app_runtime");
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*read_limit_counters/);
  });
});
