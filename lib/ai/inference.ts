import { APICallError, generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getEnv } from "@/lib/env";
import type { TenantContext } from "@/lib/db/tenant";
import { InferenceError, PipelineError } from "./errors";
import { resolveModel, type ModelOverrides, type ModelRole } from "./models";
import { loadActivePrompt, loadPromptById } from "./prompt-loader";
import type { ContextProvider } from "./pipeline/context";
import type { LoadedMethodology } from "./pipeline/methodology";
import type { ModelCall } from "./pipeline/passes";
import { PIPELINE_BUDGET_MS, PIPELINE_CALL_TIMEOUT_MS, pipelineInputSchema, runSectionPipeline, type PipelineInput, type PipelineResult } from "./pipeline/pipeline";

/**
 * The single entry point for inference (CLAUDE.md, "LLM call architecture").
 * Route handlers call this and nothing else in lib/ai.
 *
 * Two ways in, by mode:
 *   - `runInference`: stub mode, one fixed neutral prompt (the dev-stub loop).
 *   - `runPipeline`: real mode, the three-pass pipeline (filter, extract, generate) over one section.
 * This is the ONLY file that imports the AI SDK and the only code that sends prompt text to a model.
 *
 * There is deliberately no fallback: one endpoint is contacted per call, and
 * any failure surfaces as an InferenceError (or, from the pipeline, a PipelineError). No cloud
 * provider is imported.
 */

export type InferenceMode = "stub" | "real";

// The error types live in ./errors so the pipeline can use them; re-exported so callers keep importing from here.
export { InferenceError, PipelineError, toGenerationFailure } from "./errors";
export type { InferenceErrorCode, PipelineErrorCode } from "./errors";
export type { PipelineInput, PipelineResult } from "./pipeline/pipeline";

export type InferenceOptions = {
  /** Defaults to INFERENCE_MODE. Mainly for tests. */
  mode?: InferenceMode;
  /** Per-organization endpoint (from `inference_endpoint` once that table exists). */
  endpoint?: string;
  /** Per-organization model overrides (from `model_config`). */
  models?: ModelOverrides;
  /** Defaults to the stub role in stub mode. */
  role?: ModelRole;
  /** Injected transport for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type InferenceResult = {
  text: string;
  model: string;
  mode: InferenceMode;
  latencyMs: number;
  /** Shaped to feed `llm_metadata` later; nothing is persisted here. */
  usage: { inputTokens: number | undefined; outputTokens: number | undefined };
};

/** Stub mode sends exactly this and nothing else. It contains no client data. */
export const STUB_PROMPT = "Reply with the single word: ready";

const DEFAULT_TIMEOUT_MS = 60_000;
const PROVIDER_NAME = "ollama";

function validateEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InferenceError("invalid_config");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new InferenceError("invalid_config");
  }
  return url.toString().replace(/\/+$/, "");
}

/** qwen3 can emit reasoning inline; drop it so only the answer is returned. */
function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function classify(error: unknown): InferenceError {
  if (error instanceof InferenceError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return new InferenceError("timeout");
  if (APICallError.isInstance(error)) {
    return new InferenceError(error.statusCode === undefined ? "unreachable" : "bad_response");
  }
  // Network-level failures (connection refused, DNS) arrive as plain errors.
  return new InferenceError("unreachable");
}

type ProviderCall = {
  endpoint: string;
  model: string;
  system?: string;
  prompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
  fetch?: typeof fetch;
};

/** The one place a request leaves for a model: one endpoint, no retries, errors reduced to fixed codes. */
async function callProvider(call: ProviderCall): Promise<{ text: string; latencyMs: number; usage: InferenceResult["usage"] }> {
  const provider = createOpenAICompatible({
    name: PROVIDER_NAME,
    baseURL: call.endpoint,
    includeUsage: true,
    fetch: call.fetch,
  });

  const started = performance.now();
  try {
    const result = await generateText({
      model: provider.chatModel(call.model),
      ...(call.system !== undefined ? { system: call.system } : {}),
      prompt: call.prompt,
      temperature: 0,
      maxOutputTokens: call.maxOutputTokens,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(call.timeoutMs),
      // Ollama's OpenAI-compatible equivalent of `--think=false`.
      providerOptions: { [PROVIDER_NAME]: { reasoningEffort: "none" } },
    });

    const text = stripReasoning(result.text);
    if (!text) throw new InferenceError("bad_response");

    return {
      text,
      latencyMs: Math.round(performance.now() - started),
      usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    };
  } catch (error) {
    throw classify(error);
  }
}

export async function runInference(options: InferenceOptions = {}): Promise<InferenceResult> {
  const mode = options.mode ?? getEnv().INFERENCE_MODE;

  if (mode === "real") throw new InferenceError("not_implemented");
  if (mode !== "stub") throw new InferenceError("invalid_config");

  const endpoint = validateEndpoint(options.endpoint ?? getEnv().OLLAMA_BASE_URL);

  let model: string;
  try {
    model = resolveModel(options.role ?? "stub", options.models);
  } catch {
    throw new InferenceError("invalid_config");
  }

  const call = await callProvider({
    endpoint,
    model,
    prompt: STUB_PROMPT,
    maxOutputTokens: 64,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetch: options.fetch,
  });
  return { text: call.text, model, mode, latencyMs: call.latencyMs, usage: call.usage };
}

export type PipelineRunOptions = {
  /** Defaults to INFERENCE_MODE. The pipeline runs in real mode only. */
  mode?: InferenceMode;
  /** The practice's own endpoint, read from its organization row by the caller. */
  endpoint?: string;
  /** The practice's model overrides, read from its organization row by the caller. */
  models?: ModelOverrides;
  /** Injected transport for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  budgetMs?: number;
  callTimeoutMs?: number;
  /**
   * Awaited once, after the filter has said go and before extract: where the caller makes its own
   * point of no return (the route claims the report here). Its error propagates as thrown. Not
   * called when the filter stops the run, when a pass fails first, or for empty notes.
   */
  onProceed?: () => Promise<void>;
  /**
   * The person accepted thin notes: a thin filter result no longer stops the run, and generate uses
   * the confirmed rule (keeps the model's text, `[Please provide]` where the notes do not support
   * it, `insufficient_input` flagged). See PipelineOptions.proceedIfInsufficient.
   */
  proceedIfInsufficient?: boolean;
  /**
   * Use this exact methodology prompt version (the one the report pinned) instead of the template's
   * active one. It is read through the tenant data layer and refused unless it belongs to the
   * input's template in the caller's practice. Needs exactly one template in the input.
   */
  methodologyPromptId?: string;
  /** Test seams. Production leaves both unset: the methodology comes from the database, and nothing is retrieved yet. */
  loadMethodology?: (templateId: string, pinnedPromptId?: string) => Promise<LoadedMethodology>;
  retrieveContext?: ContextProvider;
};

/**
 * Runs the three passes for one section and returns `{content, flags}` for it, plus the template
 * chosen, the methodology prompt id used, and per-pass model/token/latency numbers (no text).
 *
 * Real mode only: in stub mode (or any other) it refuses with `invalid_config` before doing
 * anything, so the pipeline can never run as the stub by accident. The endpoint and model
 * overrides are passed in (read from the caller's own organization row, never from a request);
 * with no endpoint it uses OLLAMA_BASE_URL like the stub does. Nothing is stored here and nothing
 * is logged; the caller writes the audit row from `passes`. Failures are PipelineErrors with a
 * code; not enough input is a normal result, not an error.
 */
export async function runPipeline(ctx: TenantContext, input: PipelineInput, options: PipelineRunOptions = {}): Promise<PipelineResult> {
  const mode = options.mode ?? getEnv().INFERENCE_MODE;
  if (mode !== "real") throw new PipelineError("invalid_config");

  let endpoint: string;
  try {
    endpoint = validateEndpoint(options.endpoint ?? getEnv().OLLAMA_BASE_URL);
    // Every role the passes use must resolve before the first call, so a bad override fails early.
    resolveModel("filter", options.models);
    resolveModel("worker", options.models);
  } catch {
    throw new PipelineError("invalid_config");
  }

  // A pinned version belongs to one template, so the input must name exactly one.
  const pinned = options.methodologyPromptId;
  if (pinned !== undefined) {
    const parsed = pipelineInputSchema.safeParse(input);
    if (!parsed.success || parsed.data.templates.length !== 1) throw new PipelineError("invalid_input");
  }

  const callModel: ModelCall = async (request) => {
    const model = resolveModel(request.role, options.models);
    const call = await callProvider({
      endpoint,
      model,
      system: request.system,
      prompt: request.prompt,
      maxOutputTokens: request.maxOutputTokens,
      timeoutMs: request.timeoutMs,
      fetch: options.fetch,
    });
    return { text: call.text, model, latencyMs: call.latencyMs, usage: call.usage };
  };

  return runSectionPipeline(
    {
      callModel,
      loadMethodology: (templateId) =>
        options.loadMethodology
          ? options.loadMethodology(templateId, pinned)
          : pinned !== undefined
            ? loadPromptById(ctx, templateId, pinned)
            : loadActivePrompt(ctx, templateId),
      retrieveContext: options.retrieveContext,
      onProceed: options.onProceed,
    },
    ctx,
    input,
    {
      budgetMs: options.budgetMs ?? PIPELINE_BUDGET_MS,
      callTimeoutMs: options.callTimeoutMs ?? PIPELINE_CALL_TIMEOUT_MS,
      proceedIfInsufficient: options.proceedIfInsufficient === true,
    },
  );
}
