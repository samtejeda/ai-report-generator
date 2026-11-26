import { describe, expect, it } from "vitest";
import { notesTextProblem, ReportNotesStoreError, scrubbed } from "./report-notes";

// No database: the parts of the notes data layer that must hold whatever the database does.
describe("notes text validation", () => {
  it("accepts text up to 20000 characters as Postgres counts them (code points), refuses the rest", () => {
    expect(notesTextProblem("Synthetic notes.")).toBeNull();
    expect(notesTextProblem("x".repeat(20000))).toBeNull();
    expect(notesTextProblem("\u{1F642}".repeat(20000))).toBeNull(); // 40000 UTF-16 units, 20000 characters
    expect(notesTextProblem("x".repeat(20001))).toBe("too_long");
    expect(notesTextProblem("\u{1F642}".repeat(20001))).toBe("too_long");
  });

  it("refuses blank text, a NUL and anything that is not a string, and the reason never holds the text", () => {
    for (const bad of ["", "  \n\t ", undefined, null, 5, {}]) expect(notesTextProblem(bad), String(bad)).toBe("blank");
    expect(notesTextProblem("a\u0000b")).toBe("invalid_text");
  });
});

describe("errors from the notes store carry no notes text", () => {
  it("replaces any error by one with the Postgres code only: no message, no cause, no query parameters", async () => {
    const marker = "ZedMarkerNotesText";
    const original = Object.assign(new Error(`Failed query: insert into report_notes ... params: ${marker}`), {
      cause: { code: "23514", detail: `Failing row contains (${marker})` },
    });
    const error = await scrubbed(async () => {
      throw original;
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ReportNotesStoreError);
    const e = error as ReportNotesStoreError;
    expect(e.code).toBe("23514");
    expect(e.message).toBe("report notes store failed (23514)");
    expect(e.cause).toBeUndefined();
    expect(JSON.stringify(e, Object.getOwnPropertyNames(e))).not.toContain(marker);
  });

  it("a failure with no database code still loses its message, and our own error passes through unchanged", async () => {
    const e = await scrubbed(async () => {
      throw new Error("params: ZedMarkerNotesText");
    }).catch((x: unknown) => x as ReportNotesStoreError);
    expect(e.code).toBeUndefined();
    expect(e.message).toBe("report notes store failed");
    const mine = new ReportNotesStoreError("23505");
    await expect(scrubbed(async () => { throw mine; })).rejects.toBe(mine);
    await expect(scrubbed(async () => 7)).resolves.toBe(7);
  });
});
