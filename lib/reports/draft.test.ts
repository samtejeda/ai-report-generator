import { describe, expect, it } from "vitest";
import { isUnsaved, reconcileDraft } from "./draft";

describe("reconcileDraft", () => {
  it("an untouched box follows the server (this is how Generate's text and a colleague's save appear)", () => {
    expect(reconcileDraft({ draft: "old", base: { version: 1, text: "old" } }, { version: 2, text: "new" })).toEqual({
      draft: "new",
      base: { version: 2, text: "new" },
      followed: true,
    });
    expect(reconcileDraft({ draft: "", base: { version: 0, text: "" } }, { version: 1, text: "generated" }).draft).toBe("generated");
  });
  it("a box with the person's edits is never replaced and keeps its old base version", () => {
    const r = reconcileDraft({ draft: "my edit", base: { version: 1, text: "old" } }, { version: 2, text: "their text" });
    expect(r).toEqual({ draft: "my edit", base: { version: 1, text: "old" }, followed: false });
  });
  it("following the same values is a no-op (right after the person's own save)", () => {
    const r = reconcileDraft({ draft: "saved", base: { version: 2, text: "saved" } }, { version: 2, text: "saved" });
    expect(r).toEqual({ draft: "saved", base: { version: 2, text: "saved" }, followed: true });
  });
  it("clearing a box is an edit too", () => {
    expect(reconcileDraft({ draft: "", base: { version: 1, text: "old" } }, { version: 2, text: "x" }).draft).toBe("");
  });
});

describe("isUnsaved", () => {
  it("is unsaved exactly when the box differs from the last saved text", () => {
    expect(isUnsaved("same", "same")).toBe(false);
    expect(isUnsaved("changed", "same")).toBe(true);
  });
  it("putting the text back clears it; emptying a saved section is a change; an empty box on an empty section is not", () => {
    expect(isUnsaved("same", "same")).toBe(false);
    expect(isUnsaved("", "something")).toBe(true);
    expect(isUnsaved("", "")).toBe(false);
  });
  it("is exact: a trailing space or a different line ending is a change", () => {
    expect(isUnsaved("a ", "a")).toBe(true);
    expect(isUnsaved("a\r\nb", "a\nb")).toBe(true);
  });
});
