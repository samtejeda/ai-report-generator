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
