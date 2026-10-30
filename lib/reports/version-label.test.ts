import { describe, expect, it } from "vitest";
import { AUTHOR_UNKNOWN_LABEL, MODEL_TEXT_LABEL, OTHER_EDIT_LABEL, versionAttribution } from "./version-label";

describe("versionAttribution", () => {
  it("a person's edit names the person", () => {
    expect(versionAttribution({ editType: "human_edit", authorName: "Dana Reyes" })).toBe("Edited by Dana Reyes");
  });
  it("trims the name", () => {
    expect(versionAttribution({ editType: "human_edit", authorName: "  Dana  " })).toBe("Edited by Dana");
  });
  it("a person's edit without a usable name says so instead of showing nothing", () => {
    expect(versionAttribution({ editType: "human_edit", authorName: null })).toBe(AUTHOR_UNKNOWN_LABEL);
    expect(versionAttribution({ editType: "human_edit", authorName: "   " })).toBe(AUTHOR_UNKNOWN_LABEL);
  });
  it.each(["ai_generated", "ai_regenerated_section"])("%s is test model text, with or without a name", (editType) => {
    expect(versionAttribution({ editType, authorName: null })).toBe(MODEL_TEXT_LABEL);
    expect(versionAttribution({ editType, authorName: "Someone" })).toBe(MODEL_TEXT_LABEL);
  });
  it("an unknown type is a neutral word, never the raw type", () => {
    expect(versionAttribution({ editType: "something_new", authorName: "X" })).toBe(OTHER_EDIT_LABEL);
    expect(versionAttribution({ editType: null, authorName: null })).toBe(OTHER_EDIT_LABEL);
  });
  it("the raw edit types never appear in any label", () => {
    for (const editType of ["human_edit", "ai_generated", "ai_regenerated_section", "other", null]) {
      expect(versionAttribution({ editType, authorName: null })).not.toMatch(/human_edit|ai_generated|ai_regenerated|_/);
    }
  });
});
