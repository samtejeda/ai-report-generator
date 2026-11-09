import { describe, expect, it } from "vitest";
import { checkBeforeFinalize, FINALIZE_BLOCKED_HEADING, FINALIZE_BLOCKED_NEXT, finalizeBlockedIntro, GO_BACK_BUTTON } from "./finalize-check";

const entry = (key: string, position: number, title = `Section ${key}`) => ({ key, title, position });

describe("checkBeforeFinalize", () => {
  it("nothing unsaved: the existing confirmation applies", () => {
    expect(checkBeforeFinalize([])).toEqual({ action: "confirm" });
  });

  it("anything unsaved: blocked, with the titles in page order and the first box to go back to", () => {
    const r = checkBeforeFinalize([entry("c", 3, "Summary"), entry("a", 1, "Reason for Referral")]);
    expect(r).toEqual({ action: "blocked", titles: ["Reason for Referral", "Summary"], firstKey: "a" });
  });

  it("one unsaved section is enough to block", () => {
    expect(checkBeforeFinalize([entry("x", 4)]).action).toBe("blocked");
  });

  it("two sections with the same title are both listed", () => {
    const r = checkBeforeFinalize([entry("a", 1, "Notes"), entry("b", 2, "Notes")]);
    expect(r.action === "blocked" && r.titles).toEqual(["Notes", "Notes"]);
  });

  it("never both: a blocked answer carries no way to go ahead", () => {
    const r = checkBeforeFinalize([entry("a", 1)]);
    expect(Object.keys(r).sort()).toEqual(["action", "firstKey", "titles"]);
  });

  it("does not change its input", () => {
    const input = [entry("b", 2), entry("a", 1)];
    checkBeforeFinalize(input);
    expect(input.map((e) => e.key)).toEqual(["b", "a"]);
  });

  it("carries titles only, never anything a section holds", () => {
    expect(JSON.stringify(checkBeforeFinalize([entry("a", 1, "Reason for Referral")]))).not.toMatch(/text|draft/i);
  });
});

describe("wording", () => {
  it("has the one button Sam asked for and no way to finalize", () => {
    expect(GO_BACK_BUTTON).toBe("Go back and save");
    for (const s of [FINALIZE_BLOCKED_HEADING, FINALIZE_BLOCKED_NEXT, finalizeBlockedIntro(1), finalizeBlockedIntro(2), GO_BACK_BUTTON]) {
      expect(s).not.toMatch(/anyway|without saving/i);
    }
  });
  it("the intro agrees in number and says only saved text is included", () => {
    expect(finalizeBlockedIntro(1)).toBe("Finalizing only includes saved text. This section has changes that are not saved:");
    expect(finalizeBlockedIntro(3)).toBe("Finalizing only includes saved text. These sections have changes that are not saved:");
  });
});
