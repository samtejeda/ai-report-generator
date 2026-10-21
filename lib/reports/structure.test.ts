import { describe, expect, it } from "vitest";
import { MAX_SECTION_BODY, MAX_SECTION_TEXT, parseProseContent, sectionEditBody } from "./content";
import { MAX_SECTIONS, parseTemplateStructure, templateSlug } from "./structure";

const s = (key: string, title = "Title", type = "prose") => ({ key, title, type });

describe("template structure", () => {
  it("accepts ordered unique sections", () => {
    expect(parseTemplateStructure({ sections: [s("a"), s("b_2")] })?.sections).toHaveLength(2);
  });
  it.each([
    ["empty list", { sections: [] }],
    ["duplicate keys", { sections: [s("a"), s("a")] }],
    ["bad key (upper case)", { sections: [s("Bad")] }],
    ["bad key (leading digit)", { sections: [s("1a")] }],
    ["empty title", { sections: [s("a", "  ")] }],
    ["unknown type", { sections: [s("a", "T", "markdown")] }],
    ["unknown property", { sections: [{ ...s("a"), guidance: "write something" }] }],
    ["extra top-level key", { sections: [s("a")], prompt: "x" }],
    ["too many", { sections: Array.from({ length: MAX_SECTIONS + 1 }, (_, i) => s(`k${i}`)) }],
    ["not an object", "x"],
    ["null", null],
  ])("refuses %s", (_label, value) => {
    expect(parseTemplateStructure(value)).toBeNull();
  });
  it("slugs are lower-case words and hyphens", () => {
    expect(templateSlug.safeParse("psychoeducational-evaluation").success).toBe(true);
    for (const bad of ["", "Psych", "a b", "a/b", "-a", "a".repeat(65), "a;b"]) expect(templateSlug.safeParse(bad).success, bad).toBe(false);
  });
});

describe("section text", () => {
  it("prose content is exactly {text}", () => {
    expect(parseProseContent({ text: "hello" })).toEqual({ text: "hello" });
    expect(parseProseContent({ text: "hello", flags: [] })).toBeNull();
    expect(parseProseContent({ text: 5 })).toBeNull();
    expect(parseProseContent("hello")).toBeNull();
  });
  it("an edit body needs text and a base version, and nothing else", () => {
    expect(sectionEditBody.safeParse({ text: "x", baseVersion: 0 }).success).toBe(true);
    expect(sectionEditBody.safeParse({ text: "", baseVersion: 3 }).success).toBe(true);
    expect(sectionEditBody.safeParse({ text: "line one\nline two\ttab", baseVersion: 1 }).success).toBe(true);
    for (const bad of [
      {},
      { text: "x" },
      { baseVersion: 0 },
      { text: "x", baseVersion: -1 },
      { text: "x", baseVersion: 1.5 },
      { text: "x", baseVersion: "1" },
      { text: "x".repeat(MAX_SECTION_TEXT + 1), baseVersion: 0 },
      { text: "bell\u0007", baseVersion: 0 },
      { text: "nul\u0000", baseVersion: 0 },
      { text: "x", baseVersion: 0, reportId: "11111111-1111-4111-8111-111111111111" },
      { text: "x", baseVersion: 0, editType: "ai_generated" },
    ]) expect(sectionEditBody.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    expect(MAX_SECTION_BODY).toBeGreaterThan(MAX_SECTION_TEXT);
  });
});
