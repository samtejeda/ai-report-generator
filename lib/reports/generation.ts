import { z } from "zod";
import { MODEL_TAG } from "@/lib/audit";

/**
 * The pure rules around one generation: what the practice's model_config may say, what is
 * written to `report_versions.llm_metadata`, and how a failure is named. No I/O here.
 */

/**
 * `organizations.model_config` is jsonb that no part of the app can write (only a script run with
 * the owner credential), so it is parsed like any other outside input. Today only the `stub`
 * role is read; a value that is not a string makes the whole config unusable. The tag itself is
 * checked again by lib/ai/models.ts when it is resolved.
 */
const modelConfigSchema = z.looseObject({ stub: z.string().min(1).max(128).optional() });

export type ParsedModelConfig = { ok: true; models: { stub?: string } } | { ok: false };

export function parseModelConfig(raw: unknown): ParsedModelConfig {
  const parsed = modelConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false };
  return { ok: true, models: parsed.data.stub === undefined ? {} : { stub: parsed.data.stub } };
}

/**
 * What is kept about a generation on the version row. Closed: a model tag, counts, a latency and a
 * zero cost. Never the prompt, the output, the endpoint or anything about the client.
 */
export const llmMetadataSchema = z.strictObject({
  mode: z.literal("stub"),
  model: z.string().regex(MODEL_TAG),
  inputTokens: z.number().int().min(0).max(1_000_000_000).nullable(),
  outputTokens: z.number().int().min(0).max(1_000_000_000).nullable(),
  latencyMs: z.number().int().min(0).max(1_000_000_000),
  costUsd: z.literal(0),
});
export type LlmMetadata = z.infer<typeof llmMetadataSchema>;

/** Why a generation failed, as the code the audit log accepts (lib/audit.ts AUDIT_GENERATION_FAILURES). */
export type GenerationFailure = "unreachable" | "timeout" | "bad_response" | "invalid_output" | "invalid_config" | "not_implemented" | "stale" | "internal";

/** The HTTP answer for a failed generation: a timeout is 504, other upstream trouble 502, our own bug 500. */
export function failureStatus(reason: GenerationFailure): 502 | 504 | 500 {
  if (reason === "timeout") return 504;
  if (reason === "internal") return 500;
  return 502;
}
