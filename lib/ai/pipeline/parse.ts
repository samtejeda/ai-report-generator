import type { z } from "zod";

/** Far above any answer the token limits allow; a longer one is refused before it is parsed. */
const MAX_ANSWER_CHARS = 200_000;

export type ParsedAnswer<S extends z.ZodType> = { ok: true; data: z.infer<S> } | { ok: false };

/**
 * Turns a model's text into a checked value, or says it could not. The text must be exactly one
 * JSON value that fits the schema: prose around it, a code fence, a second object, an extra key or
 * a wrong type are all refusals. The failure carries no reason and no text on purpose: model
 * output must not travel into errors or logs.
 */
export function parseModelAnswer<S extends z.ZodType>(text: string, schema: S): ParsedAnswer<S> {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_ANSWER_CHARS) return { ok: false };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const result = schema.safeParse(json);
  return result.success ? { ok: true, data: result.data } : { ok: false };
}
