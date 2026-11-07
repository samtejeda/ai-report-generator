import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { parseModelAnswer } from "./parse";
import { EXTRACT_FIELDS, extractAnswerSchema, filterAnswerSchema, generateAnswerSchema, orderFlags } from "./schemas";

// Synthetic answers only: made-up words, no client data and no methodology wording.
const goodFilter = { template: "synthetic-template", sufficient: true, sensitive_content_detected: false, missing_fields: ["quotes"] };
const goodExtract = {
  observations: ["synthetic observation one"],
  test_scores: [{ instrument: "Synthetic Scale", name: "Subtest A", value: "12" }],
  quotes: ["a synthetic quote"],
  family_context: [],
};
const goodGenerate = { content: "Synthetic section text.", flags: ["low_confidence_interpretation"] };

type Case = { name: string; schema: z.ZodType; good: Record<string, unknown>; wrongType: Record<string, unknown> };
const cases: Case[] = [
  { name: "filter", schema: filterAnswerSchema, good: goodFilter, wrongType: { ...goodFilter, sufficient: "yes" } },
  { name: "extract", schema: extractAnswerSchema, good: goodExtract, wrongType: { ...goodExtract, observations: "not an array" } },
  { name: "generate", schema: generateAnswerSchema, good: goodGenerate, wrongType: { ...goodGenerate, content: 42 } },
];

describe.each(cases)("$name answer schema", ({ schema, good, wrongType }) => {
  const parse = (value: unknown) => parseModelAnswer(typeof value === "string" ? value : JSON.stringify(value), schema);

  it("accepts a good answer", () => {
    expect(parse(good)).toEqual({ ok: true, data: good });
  });

  it.each(Object.keys(good))("refuses an answer missing %s", (key) => {
    const { [key]: _omitted, ...rest } = good;
    void _omitted;
    expect(parse(rest).ok).toBe(false);
  });

  it("refuses an extra key", () => {
    expect(parse({ ...good, extra: "x" }).ok).toBe(false);
  });

  it("refuses a wrong type", () => {
    expect(parse(wrongType).ok).toBe(false);
  });

  it("refuses prose around the JSON", () => {
    const json = JSON.stringify(good);
    expect(parse(`Here is the answer: ${json}`).ok).toBe(false);
    expect(parse(`${json}\nHope that helps!`).ok).toBe(false);
  });

  it("refuses a code fence around the JSON", () => {
    expect(parse("```json\n" + JSON.stringify(good) + "\n```").ok).toBe(false);
  });

  it("refuses two objects, an array, a bare string, null and empty text", () => {
    const json = JSON.stringify(good);
    for (const text of [`${json}${json}`, `[${json}]`, '"text"', "null", "", "   "]) expect(parse(text).ok, text).toBe(false);
  });

  it("refuses a smuggled __proto__ key", () => {
    expect(parse(`{"__proto__":{"x":1},${JSON.stringify(good).slice(1)}`).ok).toBe(false);
  });

  it("reports a failure with no reason and no model text", () => {
    const result = parse("secret model words that are not json");
    expect(result).toEqual({ ok: false });
  });
});

describe("filter answer: closed fields", () => {
  it("accepts only the known field categories, once each", () => {
    expect(parseModelAnswer(JSON.stringify({ ...goodFilter, missing_fields: [...EXTRACT_FIELDS] }), filterAnswerSchema).ok).toBe(true);
    expect(parseModelAnswer(JSON.stringify({ ...goodFilter, missing_fields: ["free text from the model"] }), filterAnswerSchema).ok).toBe(false);
    expect(parseModelAnswer(JSON.stringify({ ...goodFilter, missing_fields: ["quotes", "quotes"] }), filterAnswerSchema).ok).toBe(false);
  });
});

describe("extract answer: bounds", () => {
  it("refuses an item that is blank, too long, or a score missing a key", () => {
    const bad = [
      { ...goodExtract, observations: ["   "] },
      { ...goodExtract, quotes: ["x".repeat(1001)] },
      { ...goodExtract, test_scores: [{ instrument: "Synthetic Scale", name: "Subtest A" }] },
      { ...goodExtract, test_scores: [{ instrument: "Synthetic Scale", name: "Subtest A", value: "12", extra: "x" }] },
    ];
    for (const value of bad) expect(parseModelAnswer(JSON.stringify(value), extractAnswerSchema).ok).toBe(false);
  });
});

describe("generate answer: flags and content", () => {
  const parse = (value: unknown) => parseModelAnswer(JSON.stringify(value), generateAnswerSchema);

  it("accepts only the closed flag list, without repeats", () => {
    expect(parse({ content: "Text.", flags: [] }).ok).toBe(true);
    expect(parse({ content: "Text.", flags: ["made_up_flag"] }).ok).toBe(false);
    expect(parse({ content: "Text.", flags: ["insufficient_input", "insufficient_input"] }).ok).toBe(false);
  });

  it("refuses empty or control-character text unless the section is flagged insufficient", () => {
    expect(parse({ content: "", flags: [] }).ok).toBe(false);
    expect(parse({ content: "   ", flags: ["sensitive_content_detected"] }).ok).toBe(false);
    expect(parse({ content: "bad\u0000text", flags: [] }).ok).toBe(false);
    expect(parse({ content: "", flags: ["insufficient_input"] }).ok).toBe(true);
  });

  it("refuses text over the section length cap", () => {
    expect(parse({ content: "x".repeat(20_001), flags: [] }).ok).toBe(false);
  });
});

describe("orderFlags", () => {
  it("lists flags in one fixed order without repeats", () => {
    expect(orderFlags(["low_confidence_interpretation", "insufficient_input", "low_confidence_interpretation"])).toEqual(["insufficient_input", "low_confidence_interpretation"]);
  });
});
