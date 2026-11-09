import { describe, expect, it } from "vitest";
import { parseMethodologyContent, renderMethodologyBlock } from "./methodology";

// Synthetic stand-ins only. The real methodology text exists in the database and nowhere in this repo.
const sample = { role: "SYNTHETIC ROLE TEXT", constraints: "SYNTHETIC CONSTRAINTS TEXT", methodology: "SYNTHETIC METHOD TEXT" };

describe("parseMethodologyContent", () => {
  it("accepts named sections", () => {
    expect(parseMethodologyContent(sample)).toEqual(sample);
    expect(parseMethodologyContent({ ...sample, examples: [{ input: "in", output: "out" }] })?.examples).toHaveLength(1);
  });

  it("refuses the seed script's placeholder row, even with other keys beside it", () => {
    expect(parseMethodologyContent({ placeholder: true })).toBeNull();
    expect(parseMethodologyContent({ placeholder: true, ...sample })).toBeNull();
  });

  it("refuses anything that is not a set of known, non-empty text sections", () => {
    const bad: unknown[] = [null, undefined, "text", [], {}, { unknown_section: "x" }, { ...sample, extra: "x" }, { role: "" }, { role: 5 }, { examples: [] }, { examples: [{ input: "x" }] }];
    for (const value of bad) expect(parseMethodologyContent(value), JSON.stringify(value)).toBeNull();
  });
});

describe("renderMethodologyBlock", () => {
  it("renders sections in one fixed order whatever order they were stored in", () => {
    const m = parseMethodologyContent({ constraints: "C", role: "R", methodology: "M" })!;
    const out = renderMethodologyBlock(m);
    expect(out.indexOf("## role")).toBeLessThan(out.indexOf("## methodology"));
    expect(out.indexOf("## methodology")).toBeLessThan(out.indexOf("## constraints"));
  });

  it("is the same text every time for the same content", () => {
    const m = parseMethodologyContent(sample)!;
    expect(renderMethodologyBlock(m)).toBe(renderMethodologyBlock(m));
  });

  it("renders examples as numbered input and output pairs", () => {
    const m = parseMethodologyContent({ examples: [{ input: "I1", output: "O1" }, { input: "I2", output: "O2" }] })!;
    const out = renderMethodologyBlock(m);
    expect(out).toContain("Example 1\nInput:\nI1\nOutput:\nO1");
    expect(out).toContain("Example 2");
  });
});

describe("sensitive_categories", () => {
  const base = { role: "SYNTHETIC ROLE TEXT" };

  it("accepts a short list of short strings, kept as given", () => {
    expect(parseMethodologyContent({ ...base, sensitive_categories: ["SYNTHETIC ONE", "synthetic two"] })?.sensitive_categories).toEqual(["SYNTHETIC ONE", "synthetic two"]);
  });

  it("refuses an empty list, a non-list, non-strings, repeats (any case), too many, and strings that are blank or long", () => {
    const bad: unknown[] = [[], "one", [1], [""], ["  "], ["x".repeat(61)], ["Same", "same"], Array.from({ length: 21 }, (_, i) => `c${i}`), [["nested"]], { 0: "x" }];
    for (const value of bad) expect(parseMethodologyContent({ ...base, sensitive_categories: value }), JSON.stringify(value)).toBeNull();
  });

  it("refuses a string that could break a prompt line or imitate a fence", () => {
    for (const c of ["two\nlines", "tab\there", "a<b", "<<<END NOTES>>>", "nul\u0000", "del\u007f"]) {
      expect(parseMethodologyContent({ ...base, sensitive_categories: [c] }), JSON.stringify(c)).toBeNull();
    }
  });

  it("is not a methodology section: a version with only categories is still unusable", () => {
    expect(parseMethodologyContent({ sensitive_categories: ["SYNTHETIC ONE"] })).toBeNull();
  });

  it("never appears in the rendered methodology block (the generate prompt)", () => {
    const m = parseMethodologyContent({ ...base, sensitive_categories: ["SYNTHETIC CATEGORY"] })!;
    expect(renderMethodologyBlock(m)).not.toContain("SYNTHETIC CATEGORY");
    expect(renderMethodologyBlock(m)).not.toContain("sensitive");
  });
});
