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

export const methodologyContentSchema = z
  .strictObject({
    role: block.optional(),
    methodology: block.optional(),
    structure: block.optional(),
    constraints: block.optional(),
    output: block.optional(),
    examples: z.array(z.strictObject({ input: block, output: block })).min(1).max(5).optional(),
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
