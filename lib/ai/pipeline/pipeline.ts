import { z } from "zod";
import { PipelineError } from "../errors";
import { boundContext, noContext, type ContextProvider } from "./context";
import type { LoadedMethodology } from "./methodology";
import { createBudget, runPass, type ModelCall, type PassMetadata } from "./passes";
import { buildExtractPrompt, buildFilterPrompt, buildGeneratePrompt } from "./prompts";
import {
  EXTRACT_FIELDS,
  PLEASE_PROVIDE,
  extractAnswerSchema,
  filterAnswerSchema,
  generateAnswerSchema,
  orderFlags,
  type ExtractField,
  type SectionFlag,
  type SectionResult,
} from "./schemas";

/**
 * The three passes in order for ONE section: filter (which template, is there enough, anything
 * sensitive), extract (structured fields from the notes), generate (the section, from the
 * methodology plus the extracted fields plus per-request context). Each pass is its own narrow
 * prompt and its own model role; none does another's job.
 *
 * Not enough input is a normal result, not an error: the section comes back as `[Please provide]`
 * with an `insufficient_input` flag, and the later passes do not run.
 *
 * Everything outside the model is injected (`PipelineDeps`), so the whole thing runs in tests on
 * scripted answers. The real wiring, with the database and the endpoint, is `runPipeline` in
 * lib/ai/inference.ts: this file reaches no network, no database and no logger.
 */

/** Per call and for the whole run. The route's own limit is 60 s (lib/reports/generation-limits.ts). */
export const PIPELINE_CALL_TIMEOUT_MS = 30_000;
export const PIPELINE_BUDGET_MS = 50_000;
/** Long notes degrade a small model; longer input is refused until chunked extraction exists. */
export const MAX_NOTES_CHARS = 20_000;

export const pipelineInputSchema = z.strictObject({
  /** The templates the caller's practice offers for this input (today: the report's own). Filter picks one. */
  templates: z
    .array(z.strictObject({ id: z.uuid(), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) }))
    .min(1)
    .max(10)
    .refine((t) => new Set(t.map((x) => x.slug)).size === t.length),
  /** Which section to write. A closed pattern, so it can go into a prompt as is. */
  sectionKey: z.string().regex(/^[a-z0-9_]{1,64}$/),
  notes: z.string().max(MAX_NOTES_CHARS),
});
export type PipelineInput = z.input<typeof pipelineInputSchema>;

export type PipelineDeps = {
  callModel: ModelCall;
  /** Loads the active methodology for a template, within the caller's practice. Throws PipelineError("methodology_unavailable"). */
  loadMethodology: (templateId: string) => Promise<LoadedMethodology>;
  /** RAG SEAM (see context.ts). Defaults to retrieving nothing. */
  retrieveContext?: ContextProvider;
  now?: () => number;
};

export type PipelineOptions = { budgetMs?: number; callTimeoutMs?: number };

export type PipelineResult = {
  outcome: "generated" | "insufficient_input";
  section: SectionResult & { key: string };
  /** Which of the offered templates filter chose; null when nothing was classified (empty notes). */
  template: { id: string; slug: string } | null;
  /** The prompt version used, to record with the generation; null when no methodology was needed. */
  methodologyPromptId: string | null;
  /** Field categories the notes did not cover, when filter said so. A closed list, no model text. */
  missingFields: ExtractField[];
  /** One entry per pass that ran: model, tokens, latency, attempts. No client text. */
  passes: PassMetadata[];
};

export async function runSectionPipeline(
  deps: PipelineDeps,
  ctx: { organizationId: string },
  rawInput: PipelineInput,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const parsedInput = pipelineInputSchema.safeParse(rawInput);
  if (!parsedInput.success) throw new PipelineError("invalid_input");
  const { templates, sectionKey, notes } = parsedInput.data;
  const section = { key: sectionKey };

  // Nothing written: no model is asked to work from nothing.
  if (notes.trim() === "") {
    return {
      outcome: "insufficient_input",
      section: { key: sectionKey, content: PLEASE_PROVIDE, flags: ["insufficient_input"] },
      template: null,
      methodologyPromptId: null,
      missingFields: [...EXTRACT_FIELDS],
      passes: [],
    };
  }

  const budget = createBudget(options.budgetMs ?? PIPELINE_BUDGET_MS, deps.now);
  const callTimeoutMs = options.callTimeoutMs ?? PIPELINE_CALL_TIMEOUT_MS;
  const passes: PassMetadata[] = [];

  // 1. filter
  const candidates = templates.map((t) => t.slug);
  const filtered = await runPass({
    pass: "filter",
    schema: filterAnswerSchema,
    prompt: buildFilterPrompt({ candidates, section, notes }),
    check: (a) => candidates.includes(a.template),
    callModel: deps.callModel,
    callTimeoutMs,
    budget,
  });
  passes.push(filtered.meta);
  const template = templates.find((t) => t.slug === filtered.data.template);
  if (!template) throw new PipelineError("internal", "filter");
  const sensitive = filtered.data.sensitive_content_detected;

  if (!filtered.data.sufficient) {
    return {
      outcome: "insufficient_input",
      section: { key: sectionKey, content: PLEASE_PROVIDE, flags: orderFlags(["insufficient_input", ...(sensitive ? (["sensitive_content_detected"] as const) : [])]) },
      template,
      methodologyPromptId: null,
      missingFields: filtered.data.missing_fields,
      passes,
    };
  }

  // The practice's methodology for the chosen template, through the tenant data layer.
  let loaded: LoadedMethodology;
  try {
    loaded = await deps.loadMethodology(template.id);
  } catch (error) {
    throw error instanceof PipelineError ? error : new PipelineError("internal");
  }

  // 2. extract
  const extracted = await runPass({
    pass: "extract",
    schema: extractAnswerSchema,
    prompt: buildExtractPrompt({ notes }),
    callModel: deps.callModel,
    callTimeoutMs,
    budget,
  });
  passes.push(extracted.meta);

  // RAG SEAM: per-request context. Empty today.
  let context;
  try {
    context = boundContext(await (deps.retrieveContext ?? noContext)({ organizationId: ctx.organizationId, sectionKey, extracted: extracted.data }));
  } catch {
    throw new PipelineError("internal", "generate");
  }

  // 3. generate
  const generated = await runPass({
    pass: "generate",
    schema: generateAnswerSchema,
    prompt: buildGeneratePrompt({ methodology: loaded.methodology, section, extracted: extracted.data, context }),
    callModel: deps.callModel,
    callTimeoutMs,
    budget,
  });
  passes.push(generated.meta);

  const flags = new Set<SectionFlag>(generated.data.flags);
  if (sensitive) flags.add("sensitive_content_detected");
  const insufficient = flags.has("insufficient_input");
  return {
    outcome: insufficient ? "insufficient_input" : "generated",
    // Flags, not text: whatever the model wrote for an under-supported section is dropped.
    section: { key: sectionKey, content: insufficient ? PLEASE_PROVIDE : generated.data.content.trim(), flags: orderFlags(flags) },
    template,
    methodologyPromptId: loaded.promptId,
    missingFields: [],
    passes,
  };
}
