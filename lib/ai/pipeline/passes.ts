import type { z } from "zod";
import { InferenceError, PipelineError, type PassName } from "../errors";
import type { ModelRole } from "../models";
import { parseModelAnswer } from "./parse";
import { RETRY_NOTE, type PassPrompt } from "./prompts";

/**
 * One narrow pass: one prompt, one model role, one schema for the answer. The model is reached only
 * through the injected `ModelCall`; this file imports no SDK and no transport, so tests give it
 * scripted answers and the real wiring lives in lib/ai/inference.ts.
 *
 * Retry policy, the only one: if the model's answer does not fit the schema, ask once more with a
 * fixed note that does not repeat the model's words. A second miss is `invalid_output`. Transport
 * trouble (unreachable, timeout, bad response) is never retried: one endpoint, no fallback, a
 * clear error.
 */

/** Which model role each pass uses. Roles, never model IDs: those live in lib/ai/models.ts. */
export const PASS_ROLES = { filter: "filter", extract: "worker", generate: "worker" } as const satisfies Record<PassName, ModelRole>;

export const PASS_MAX_OUTPUT_TOKENS: Record<PassName, number> = { filter: 256, extract: 2048, generate: 2048 };

export type ModelCallRequest = { role: ModelRole; system: string; prompt: string; maxOutputTokens: number; timeoutMs: number };
export type ModelCallResult = {
  text: string;
  model: string;
  latencyMs: number;
  usage: { inputTokens: number | undefined; outputTokens: number | undefined };
};
export type ModelCall = (request: ModelCallRequest) => Promise<ModelCallResult>;

/** What is kept about one pass: ids and numbers only, shaped for the audit metadata. Never text. */
export type PassMetadata = {
  pass: PassName;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  attempts: 1 | 2;
};

/** The time left for the whole pipeline, so a run cannot outlast the route that started it. */
export type Budget = { remainingMs(): number };

export function createBudget(totalMs: number, now: () => number = Date.now): Budget {
  const end = now() + totalMs;
  return { remainingMs: () => end - now() };
}

function toPipelineError(error: unknown, pass: PassName): PipelineError {
  if (error instanceof PipelineError) return error;
  if (error instanceof InferenceError) return new PipelineError(error.code, pass);
  return new PipelineError("internal", pass);
}

function sum(a: number | undefined, b: number | null): number | null {
  return a === undefined ? b : (b ?? 0) + a;
}

export async function runPass<S extends z.ZodType>(args: {
  pass: PassName;
  schema: S;
  prompt: PassPrompt;
  /** Extra rule the answer must meet beyond its schema (for example, a value from a given list). */
  check?: (data: z.infer<S>) => boolean;
  callModel: ModelCall;
  callTimeoutMs: number;
  budget: Budget;
}): Promise<{ data: z.infer<S>; meta: PassMetadata }> {
  const { pass, schema, prompt, check, callModel, callTimeoutMs, budget } = args;
  let model = "";
  let latencyMs = 0;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  for (const attempt of [1, 2] as const) {
    const remaining = budget.remainingMs();
    if (remaining <= 0) throw new PipelineError("timeout", pass);
    let result: ModelCallResult;
    try {
      result = await callModel({
        role: PASS_ROLES[pass],
        system: prompt.system,
        prompt: attempt === 1 ? prompt.prompt : prompt.prompt + RETRY_NOTE,
        maxOutputTokens: PASS_MAX_OUTPUT_TOKENS[pass],
        timeoutMs: Math.max(1, Math.min(callTimeoutMs, Math.floor(remaining))),
      });
    } catch (error) {
      throw toPipelineError(error, pass);
    }
    model = result.model;
    latencyMs += result.latencyMs;
    inputTokens = sum(result.usage.inputTokens, inputTokens);
    outputTokens = sum(result.usage.outputTokens, outputTokens);

    const parsed = parseModelAnswer(result.text, schema);
    if (parsed.ok && (check === undefined || check(parsed.data))) {
      return { data: parsed.data, meta: { pass, model, inputTokens, outputTokens, latencyMs, attempts: attempt } };
    }
  }
  throw new PipelineError("invalid_output", pass);
}
