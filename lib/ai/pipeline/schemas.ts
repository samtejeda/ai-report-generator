import { z } from "zod";
import { generatedTextSchema, MAX_SECTION_TEXT } from "@/lib/reports/content";

/**
 * What each pass may answer with. A model's answer is untrusted input: it is parsed against one
 * of these strict schemas (unknown key, missing key, wrong type: refused) before anything reads it,
 * and nothing from it goes into a query, a key or markup unchecked. Free text from a model is
 * bounded here; the closed fields (flags, field names) cannot carry any text at all.
 */

/** What a section holds when the input does not support writing it: a flag plus this, never invention. */
export const PLEASE_PROVIDE = "[Please provide]";

/** The structured field categories extract fills (CLAUDE.md, "LLM call architecture", step 2). */
export const EXTRACT_FIELDS = ["observations", "test_scores", "quotes", "family_context"] as const;
export type ExtractField = (typeof EXTRACT_FIELDS)[number];

/** Section flags (CLAUDE.md, "Methodology prompt structure", item 5). Closed on purpose. */
export const SECTION_FLAGS = ["insufficient_input", "sensitive_content_detected", "low_confidence_interpretation"] as const;
export type SectionFlag = (typeof SECTION_FLAGS)[number];

// ---- filter: which template, is there enough, is anything sensitive
export const filterAnswerSchema = z.strictObject({
  template: z.string().min(1).max(100),
  sufficient: z.boolean(),
  sensitive_content_detected: z.boolean(),
  // Closed list, not text: the UI can say "please provide X" without showing model words.
  missing_fields: z
    .array(z.enum(EXTRACT_FIELDS))
    .max(EXTRACT_FIELDS.length)
    .refine((a) => new Set(a).size === a.length),
});
export type FilterAnswer = z.infer<typeof filterAnswerSchema>;

// ---- extract: structured fields from the raw notes
const item = z.string().trim().min(1).max(1000);
const label = z.string().trim().min(1).max(200);

export const extractAnswerSchema = z.strictObject({
  observations: z.array(item).max(50),
  test_scores: z.array(z.strictObject({ instrument: label, name: label, value: label })).max(100),
  quotes: z.array(item).max(50),
  family_context: z.array(item).max(50),
});
export type ExtractAnswer = z.infer<typeof extractAnswerSchema>;

// ---- generate: one section, `{content, flags}`
export const generateAnswerSchema = z
  .strictObject({
    content: z.string().max(MAX_SECTION_TEXT),
    flags: z
      .array(z.enum(SECTION_FLAGS))
      .max(SECTION_FLAGS.length)
      .refine((a) => new Set(a).size === a.length),
  })
  .superRefine((value, ctx) => {
    // A section flagged as having too little input is replaced by PLEASE_PROVIDE whatever the model
    // wrote (see pipeline.ts), so its text is not used. Any other section must carry usable text,
    // under the same rules as text a person may save.
    if (value.flags.includes("insufficient_input")) return;
    if (!generatedTextSchema.safeParse(value.content).success) ctx.addIssue({ code: "custom", path: ["content"], message: "content is not usable section text" });
  });
export type GenerateAnswer = z.infer<typeof generateAnswerSchema>;

/** The per-section result the pipeline hands back: `{content, flags}`. */
export type SectionResult = { content: string; flags: SectionFlag[] };

/** Flags in the one order they are always listed in, without repeats. */
export function orderFlags(flags: Iterable<SectionFlag>): SectionFlag[] {
  const have = new Set(flags);
  return SECTION_FLAGS.filter((f) => have.has(f));
}
