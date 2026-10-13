import { APICallError, generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getEnv } from "@/lib/env";
import { resolveModel, type ModelOverrides, type ModelRole } from "./models";

/**
 * The single entry point for inference (CLAUDE.md, "LLM call architecture").
 * Route handlers call this and nothing else in lib/ai.
 *
 * There is deliberately no fallback: one endpoint is contacted per call, and
 * any failure surfaces as an InferenceError. No cloud provider is imported.
 */

export type InferenceMode = "stub" | "real";

export type InferenceErrorCode =
  | "unreachable"
  | "timeout"
  | "bad_response"
  | "not_implemented"
  | "invalid_config";

/**
 * Messages are fixed strings. They never include prompts, model output, or the
 * endpoint URL, so an error can be logged or returned without leaking PHI or
 * connection details.
 */
const MESSAGES: Record<InferenceErrorCode, string> = {
  unreachable: "The inference endpoint could not be reached.",
  timeout: "The inference endpoint did not respond in time.",
  bad_response: "The inference endpoint returned an unusable response.",
  not_implemented: "Real inference mode is not implemented yet.",
  invalid_config: "The inference configuration is invalid.",
};

export class InferenceError extends Error {
  readonly code: InferenceErrorCode;
  constructor(code: InferenceErrorCode) {
    super(MESSAGES[code]);
    this.name = "InferenceError";
    this.code = code;
  }
}

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

  const provider = createOpenAICompatible({
    name: PROVIDER_NAME,
    baseURL: endpoint,
    includeUsage: true,
    fetch: options.fetch,
  });

  const started = performance.now();
  try {
    const result = await generateText({
      model: provider.chatModel(model),
      prompt: STUB_PROMPT,
      temperature: 0,
      maxOutputTokens: 64,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      // Ollama's OpenAI-compatible equivalent of `--think=false`.
      providerOptions: { [PROVIDER_NAME]: { reasoningEffort: "none" } },
    });

    const text = stripReasoning(result.text);
    if (!text) throw new InferenceError("bad_response");

    return {
      text,
      model,
      mode,
      latencyMs: Math.round(performance.now() - started),
      usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    };
  } catch (error) {
    throw classify(error);
  }
}
