import { readdirSync, readFileSync } from "node:fs";
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

  it("a generated report may generate again, and exactly that step was added to the 0013 table", () => {
    expect(canTransition("generated", "generating")).toBe(true);
    expect(canTransition("draft", "generated")).toBe(false);
    expect(canTransition("finalized", "generating")).toBe(false);
    const was = new Set(inTrigger("drizzle/0013_report_status_integrity.sql"));
    const now = new Set(inTrigger(latestStatusMigration()));
    expect([...now].filter((x) => !was.has(x))).toEqual(["generated>generating"]);
    expect([...was].filter((x) => !now.has(x))).toEqual([]);
  });

  it("the table equals the one in the current database trigger (the latest migration that defines it)", () => {
    expect(latestStatusMigration()).toBe("drizzle/0017_report_status_regenerate.sql");
    expect(inTrigger(latestStatusMigration())).toEqual(REPORT_TRANSITIONS.map(([a, b]) => `${a}>${b}`).sort());
  });
});

/** The migration with the last definition of reports_enforce_status(): migration files sort by number. */
function latestStatusMigration(): string {
  const files = readdirSync("drizzle")
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => `drizzle/${f}`)
    .filter((f) => readFileSync(f, "utf8").includes("FUNCTION reports_enforce_status()"));
  return files[files.length - 1];
}

/** The (from, to) pairs in the function's IN (...) list, as "from>to", sorted. */
function inTrigger(file: string): string[] {
  const sql = readFileSync(file, "utf8");
  const block = /IN \(([^)]*(?:\([^)]*\)[^)]*)*)\) THEN/.exec(sql)![1];
  return [...block.matchAll(/\('(\w+)',\s*'(\w+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
}
