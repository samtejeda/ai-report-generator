import { z } from "zod";
import { AUDIT_SECTION_FLAGS, MODEL_TAG } from "@/lib/audit";

/**
 * The pure rules around one generation: what the practice's model_config may say, what is
 * written to `report_versions.llm_metadata`, and how a failure is named. No I/O here.
 */

/**
 * `organizations.model_config` is jsonb that no part of the app can write (only a script run with
 * the owner credential), so it is parsed like any other outside input. The roles read are `stub`
 * (dev stub), and `filter` and `worker` (the real pipeline; `heavy` is not wired and is ignored). A
 * value that is not a string makes the whole config unusable. The tag itself is checked again by
 * lib/ai/models.ts when it is resolved.
 */
const tag = z.string().min(1).max(128);
const modelConfigSchema = z.looseObject({ stub: tag.optional(), filter: tag.optional(), worker: tag.optional() });

export type ParsedModels = { stub?: string; filter?: string; worker?: string };
export type ParsedModelConfig = { ok: true; models: ParsedModels } | { ok: false };

export function parseModelConfig(raw: unknown): ParsedModelConfig {
  const parsed = modelConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false };
  const { stub, filter, worker } = parsed.data;
  return { ok: true, models: { ...(stub !== undefined ? { stub } : {}), ...(filter !== undefined ? { filter } : {}), ...(worker !== undefined ? { worker } : {}) } };
}

/**
 * What is kept about a generation on the version row. Closed: a model tag, counts, a latency and a
 * zero cost. Never the prompt, the output, the endpoint or anything about the client.
 *
 * Two variants. `stub`: the dev-stub call. `real`: the three-pass pipeline: the methodology prompt
 * version used (an id, never its text), one entry per pass that ran (name, model tag, counts,
 * latency, attempts) and the section's flags by name from a closed list. The section TEXT is the
 * version's `content`, never here.
 */
const count = z.number().int().min(0).max(1_000_000_000);
export const stubLlmMetadataSchema = z.strictObject({
  mode: z.literal("stub"),
  model: z.string().regex(MODEL_TAG),
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  latencyMs: count,
  costUsd: z.literal(0),
});
const passMetadataSchema = z.strictObject({
  pass: z.enum(["filter", "extract", "generate"]),
  model: z.string().regex(MODEL_TAG),
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  latencyMs: count,
  attempts: z.union([z.literal(1), z.literal(2)]),
});
const realMetadataSchema = z.strictObject({
  mode: z.literal("real"),
  methodologyPromptId: z.uuid(),
  passes: z.array(passMetadataSchema).min(1).max(3),
  flags: z
    .array(z.enum(AUDIT_SECTION_FLAGS))
    .max(AUDIT_SECTION_FLAGS.length)
    .refine((a) => new Set(a).size === a.length),
  costUsd: z.literal(0),
});
export const llmMetadataSchema = z.discriminatedUnion("mode", [stubLlmMetadataSchema, realMetadataSchema]);
export type LlmMetadata = z.infer<typeof llmMetadataSchema>;
export type StubLlmMetadata = z.infer<typeof stubLlmMetadataSchema>;
export type RealLlmMetadata = z.infer<typeof realMetadataSchema>;

/** Why a generation failed, as the code the audit log accepts (lib/audit.ts AUDIT_GENERATION_FAILURES). */
export type GenerationFailure = "unreachable" | "timeout" | "bad_response" | "invalid_output" | "invalid_config" | "not_implemented" | "stale" | "internal";

/** The HTTP answer for a failed generation: a timeout is 504, other upstream trouble 502, our own bug 500. */
export function failureStatus(reason: GenerationFailure): 502 | 504 | 500 {
  if (reason === "timeout") return 504;
  if (reason === "internal") return 500;
  return 502;
}
