import { describe, expect, it } from "vitest";
import { LEAVE_BUTTON, LEAVE_DIALOG_HEADING, leaveDialogIntro, sectionBoxId, STAY_BUTTON, summaryHeading, UNSAVED_LABEL, unsavedTitles } from "./unsaved";

describe("unsaved wording", () => {
  it("uses the labels Sam asked for", () => {
    expect(UNSAVED_LABEL).toBe("Unsaved changes");
    expect(STAY_BUTTON).toBe("Stay and save");
    expect(LEAVE_BUTTON).toBe("Leave without saving");
    expect(LEAVE_DIALOG_HEADING).toMatch(/unsaved/i);
  });
  it("the summary heading counts and agrees in number", () => {
    expect(summaryHeading(1)).toBe("You have unsaved changes in 1 section:");
    expect(summaryHeading(2)).toBe("You have unsaved changes in 2 sections:");
    expect(summaryHeading(6)).toBe("You have unsaved changes in 6 sections:");
  });
  it("the dialog intro agrees in number", () => {
    expect(leaveDialogIntro(1)).toBe("This section has changes that are not saved:");
    expect(leaveDialogIntro(3)).toBe("These sections have changes that are not saved:");
  });
  it("the box id is derived from the section id only", () => {
    expect(sectionBoxId("abc-123")).toBe("section-box-abc-123");
  });
});

describe("unsavedTitles", () => {
  it("follows the page order and keeps two sections with one title", () => {
    const entries = [
      { key: "c", title: "Summary", position: 3 },
      { key: "a", title: "Reason for Referral", position: 1 },
      { key: "d", title: "Summary", position: 4 },
    ];
    expect(unsavedTitles(entries)).toEqual(["Reason for Referral", "Summary", "Summary"]);
  });
  it("is empty for nothing, and does not change its input", () => {
    expect(unsavedTitles([])).toEqual([]);
    const input = [
      { key: "b", title: "B", position: 2 },
      { key: "a", title: "A", position: 1 },
    ];
    unsavedTitles(input);
    expect(input.map((e) => e.key)).toEqual(["b", "a"]);
  });
});
