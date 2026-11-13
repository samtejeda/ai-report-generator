import { z } from "zod";

/**
 * The shape of `methodology_prompts.content` and how it becomes the stable block of the generate
 * prompt. The TEXT is the practice owner's and lives in the database only; nothing in this file
 * (or anywhere in the repo) contains any of it. Only the section names, from CLAUDE.md
 * ("Methodology prompt structure"), are fixed here.
 */

export const METHODOLOGY_SECTIONS = ["role", "methodology", "structure", "constraints", "output", "examples"] as const;
export type MethodologySection = (typeof METHODOLOGY_SECTIONS)[number];

const block = z.string().trim().min(1).max(20_000);

/**
 * One sensitive-content category name, for example a short phrase the practice chose. It goes into
 * the filter prompt as a data line, so it is kept short and cannot hold a line break, any other
 * control character, or an angle bracket (which would let it imitate a prompt fence).
 */
const category = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\u0000-\u001F\u007F<>]+$/);

export const methodologyContentSchema = z
  .strictObject({
    role: block.optional(),
    methodology: block.optional(),
    structure: block.optional(),
    constraints: block.optional(),
    output: block.optional(),
    examples: z.array(z.strictObject({ input: block, output: block })).min(1).max(5).optional(),
    /**
     * Optional, per practice and per version, in the database with the rest of the methodology and
     * never in TS: the categories the filter pass is told to watch for (Sam, 2026-11-09, row 17).
     * Only the filter pass receives them. They are not a methodology section: a version that holds
     * nothing else is still unusable, and the generate prompt never contains them.
     */
    sensitive_categories: z
      .array(category)
      .min(1)
      .max(20)
      .refine((a) => new Set(a.map((c) => c.toLowerCase())).size === a.length, { message: "duplicate category" })
      .optional(),
  })
  .refine((m) => METHODOLOGY_SECTIONS.some((s) => m[s] !== undefined), { message: "no sections" });

export type Methodology = z.infer<typeof methodologyContentSchema>;

/** An active prompt version as loaded for one template: the id to record with the generation, and its content. */
export type LoadedMethodology = { promptId: string; versionNumber: number; methodology: Methodology };

/**
 * Parses stored prompt content. Returns null for anything unusable, including the seed script's
 * placeholder row (`{"placeholder": true}`), which generation must always refuse.
 */
export function parseMethodologyContent(content: unknown): Methodology | null {
  if (typeof content === "object" && content !== null && (content as { placeholder?: unknown }).placeholder === true) return null;
  const parsed = methodologyContentSchema.safeParse(content);
  return parsed.success ? parsed.data : null;
}

/** The most categories ever sent to the filter pass, across all candidate templates. */
export const MAX_FILTER_CATEGORIES = 50;

/** The categories of several loaded methodologies, merged: first seen first, repeats dropped, bounded. */
export function mergeSensitiveCategories(methodologies: Methodology[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of methodologies) {
    for (const c of m.sensitive_categories ?? []) {
      const key = c.toLowerCase();
      if (seen.has(key) || out.length >= MAX_FILTER_CATEGORIES) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

/** The stable part of the generate prompt: the same text for every call that uses this prompt version. */
export function renderMethodologyBlock(m: Methodology): string {
  const parts: string[] = [];
  for (const name of METHODOLOGY_SECTIONS) {
    const value = m[name];
    if (value === undefined) continue;
    if (name === "examples") {
      const examples = m.examples ?? [];
      parts.push(`## examples\n${examples.map((e, i) => `Example ${i + 1}\nInput:\n${e.input}\nOutput:\n${e.output}`).join("\n\n")}`);
    } else {
      parts.push(`## ${name}\n${value}`);
    }
  }
  return parts.join("\n\n");
}
