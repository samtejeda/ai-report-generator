import { z } from "zod";
import { SECTION_TYPES } from "@/lib/db/schema/reports";

/**
 * The shape of `report_templates.structure`: which sections a report has, in order. It is layout
 * only (keys, titles, prose or structured); methodology guidance lives in `methodology_prompts`
 * and is never here. The column is jsonb, so it is parsed on the way out as well as in.
 */
export const MAX_SECTIONS = 20;

export const sectionKey = z.string().regex(/^[a-z][a-z0-9_]{0,49}$/);

export const templateStructureSchema = z
  .strictObject({
    sections: z
      .array(z.strictObject({ key: sectionKey, title: z.string().trim().min(1).max(100), type: z.enum(SECTION_TYPES) }))
      .min(1)
      .max(MAX_SECTIONS),
  })
  .refine((v) => new Set(v.sections.map((s) => s.key)).size === v.sections.length, { message: "duplicate section key" });

export type TemplateStructure = z.infer<typeof templateStructureSchema>;
export type TemplateSection = TemplateStructure["sections"][number];

export function parseTemplateStructure(value: unknown): TemplateStructure | null {
  const r = templateStructureSchema.safeParse(value);
  return r.success ? r.data : null;
}

/** Template slugs in requests: lower-case words and hyphens only. */
export const templateSlug = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
