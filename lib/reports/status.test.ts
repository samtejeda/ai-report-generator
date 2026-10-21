import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPORT_STATUSES } from "@/lib/db/schema/reports";
import { canTransition, EDITABLE_STATUSES, isEditable, REPORT_TRANSITIONS } from "./status";

describe("report status transitions", () => {
  it("finalized is reachable only from generated, and nothing leaves it", () => {
    for (const from of REPORT_STATUSES) {
      expect(canTransition(from, "finalized"), from).toBe(from === "generated");
      if (from === "finalized") for (const to of REPORT_STATUSES) expect(canTransition(from, to), to).toBe(false);
    }
  });

  it("a status never 'transitions' to itself through this table", () => {
    for (const s of REPORT_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it("people edit in draft, generated and error only", () => {
    expect([...EDITABLE_STATUSES].sort()).toEqual(["draft", "error", "generated"]);
    expect(isEditable("generating")).toBe(false);
    expect(isEditable("finalized")).toBe(false);
  });

  it("the table equals the one in the database trigger (migration 0013)", () => {
    const sql = readFileSync("drizzle/0013_report_status_integrity.sql", "utf8");
    const block = /IN \(([^)]*(?:\([^)]*\)[^)]*)*)\) THEN/.exec(sql)![1];
    const inSql = [...block.matchAll(/\('(\w+)',\s*'(\w+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    expect(inSql).toEqual(REPORT_TRANSITIONS.map(([a, b]) => `${a}>${b}`).sort());
  });
});
