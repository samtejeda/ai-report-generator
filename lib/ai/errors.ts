/**
 * The error types of lib/ai. They live apart from inference.ts so the pipeline can throw and read
 * them without importing the one file that holds the transport (inference.ts imports the pipeline,
 * not the other way round). inference.ts re-exports InferenceError, so existing imports still work.
 *
 * Messages are fixed strings. They never include a prompt, model output, client text or the
 * endpoint address, so an error can be logged or returned without leaking PHI or connection details.
 */

export type InferenceErrorCode = "unreachable" | "timeout" | "bad_response" | "not_implemented" | "invalid_config";

const INFERENCE_MESSAGES: Record<InferenceErrorCode, string> = {
  unreachable: "The inference endpoint could not be reached.",
  timeout: "The inference endpoint did not respond in time.",
  bad_response: "The inference endpoint returned an unusable response.",
  not_implemented: "Real inference mode is not implemented yet.",
  invalid_config: "The inference configuration is invalid.",
};

export class InferenceError extends Error {
  readonly code: InferenceErrorCode;
  constructor(code: InferenceErrorCode) {
    super(INFERENCE_MESSAGES[code]);
    this.name = "InferenceError";
    this.code = code;
  }
}

export type PassName = "filter" | "extract" | "generate";

/** Everything that can stop the pipeline: transport trouble, or one of the pipeline's own refusals. */
export type PipelineErrorCode =
  | InferenceErrorCode
  /** No usable methodology for the template: no template, no active prompt, a placeholder, or content that does not parse. */
  | "methodology_unavailable"
  /** A pass answered, twice, with something that is not the JSON the pass requires. */
  | "invalid_output"
  /** The caller's input was refused before any model was called. */
  | "invalid_input"
  | "internal";

const PIPELINE_MESSAGES: Record<PipelineErrorCode, string> = {
  ...INFERENCE_MESSAGES,
  methodology_unavailable: "No usable methodology prompt is available for this template.",
  invalid_output: "A model answer did not match the required format.",
  invalid_input: "The pipeline input is invalid.",
  internal: "The pipeline failed unexpectedly.",
};

export class PipelineError extends Error {
  readonly code: PipelineErrorCode;
  /** Which pass failed, when one did. */
  readonly pass: PassName | undefined;
  constructor(code: PipelineErrorCode, pass?: PassName) {
    super(PIPELINE_MESSAGES[code]);
    this.name = "PipelineError";
    this.code = code;
    this.pass = pass;
  }
}

/** The closed list lib/audit.ts accepts for `report.generation_failed` (AUDIT_GENERATION_FAILURES). */
export type GenerationFailureCode = "unreachable" | "timeout" | "bad_response" | "invalid_output" | "invalid_config" | "not_implemented" | "stale" | "internal";

/**
 * Names a pipeline failure with a code the existing audit event already accepts, so no new audit
 * code is needed. A missing methodology is a configuration problem; a refused input is our bug.
 */
export function toGenerationFailure(code: PipelineErrorCode): GenerationFailureCode {
  switch (code) {
    case "methodology_unavailable":
      return "invalid_config";
    case "invalid_input":
      return "internal";
    default:
      return code;
  }
}
