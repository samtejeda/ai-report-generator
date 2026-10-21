import { z } from "zod";

/**
 * What a section's text may be. A prose section's `report_versions.content` is `{text}` and
 * nothing else; it is validated when written and again when read (the column is jsonb). Text is
 * data: it is rendered as text by React and never used as markup, a query or a key.
 */
export const MAX_SECTION_TEXT = 20_000;
/** Request body cap for a section edit: the text plus a little JSON around it. */
export const MAX_SECTION_BODY = MAX_SECTION_TEXT + 512;

export const proseContentSchema = z.strictObject({ text: z.string().max(MAX_SECTION_TEXT) });
export type ProseContent = z.infer<typeof proseContentSchema>;

// A section may be saved empty (the psychologist clears it); control characters other than line
// breaks and tabs are refused.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const sectionEditBody = z.strictObject({
  text: z
    .string()
    .max(MAX_SECTION_TEXT)
    .refine((t) => !CONTROL.test(t)),
  /** The version the editor was looking at; 0 for a section nobody has written yet. */
  baseVersion: z.number().int().min(0).max(1_000_000),
});

export function parseProseContent(value: unknown): ProseContent | null {
  const r = proseContentSchema.safeParse(value);
  return r.success ? r.data : null;
}
