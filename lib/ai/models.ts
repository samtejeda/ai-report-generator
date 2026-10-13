/**
 * The only place model IDs may appear (CLAUDE.md, "Model config lives in one
 * place"). Feature code asks for a role and gets an ID; it never names a model.
 * IDs are Ollama tags. Per-organization overrides come from the organization
 * row's `model_config` and are passed in by the caller.
 */

export const MODELS = {
  /** Phase A dev stub on the 8 GB laptop. Response quality is irrelevant. */
  stub: "qwen3:1.7b",
  /** Filter pass: classify template, input sufficiency, sensitive content. */
  filter: "qwen3:1.7b",
  /** Worker pass: extract fields and generate sections. Handles most cases. */
  worker: "qwen3:8b",
  /** Escalation for edge cases only (MoE). Never replaced by a cloud model. */
  heavy: "qwen3:30b-a3b",
} as const;

export type ModelRole = keyof typeof MODELS;

export const MODEL_ROLES = Object.keys(MODELS) as ModelRole[];

/** Per-organization overrides, shaped like the future `model_config` JSON. */
export type ModelOverrides = Partial<Record<ModelRole, string>>;

// Ollama tags: letters, digits, and . _ - : / only. Rejects whitespace and
// anything that could be misread downstream.
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-:/]{0,127}$/;

export function isValidModelId(id: string): boolean {
  return MODEL_ID_PATTERN.test(id);
}

/**
 * Returns the model ID for a role: the organization's override if one is set,
 * otherwise the default. An invalid override throws rather than silently
 * falling back to a different model.
 */
export function resolveModel(role: ModelRole, overrides?: ModelOverrides): string {
  const override = overrides?.[role];
  if (override === undefined) return MODELS[role];
  if (!isValidModelId(override)) {
    throw new Error(`Invalid model override for role "${role}".`);
  }
  return override;
}
