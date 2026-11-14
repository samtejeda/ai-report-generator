import { PipelineError, runPipeline, toGenerationFailure, type PipelineResult } from "@/lib/ai/inference";
import { AUDIT_MISSING_FIELDS, audit } from "@/lib/audit";
import type { SessionContext } from "@/lib/auth/session";
import { failGeneration, finishGeneration, type FromStatus } from "@/lib/db/report-generate";
import { claimAtProceed, precheckGeneration, recordFailure, type ProceedClaim } from "@/lib/db/report-generate-pipeline";
import { generatedTextSchema } from "./content";
import { REAL_BUDGET_MS, REAL_CALL_TIMEOUT_MS } from "./generation-limits";
import { llmMetadataSchema, type GenerationFailure } from "./generation";

/**
 * One REAL-mode section generation, start to finish: filter, extract, generate (lib/ai), then the
 * result stored. The route calls this for `INFERENCE_MODE=real`; the stub keeps lib/reports/
 * generate-section.ts. This is the one file outside lib/ai that calls the pipeline, and it reaches
 * it through lib/ai/inference.ts only (lib/ai/boundary.test.ts keeps that true).
 *
 * The notes are the psychologist's own text, sent with the request, held in memory for this call
 * and never stored, logged, audited or returned. What leaves the app for the model is built inside
 * lib/ai from the notes and from the methodology version the REPORT pinned (read from the database
 * through the tenant layer), to the practice's own allow-listed endpoint and nowhere else. No
 * cloud model, no fallback: any failure ends in an error with a fixed code.
 *
 * Two steps for thin notes (Sam, 2026-11-09, PROGRESS decisions row 17):
 *   1st call: if the filter finds the notes thin, NOTHING is generated, the report is left exactly
 *             as it was, and the answer is `needs_confirmation` with the categories that are missing.
 *   2nd call with `confirm: true`: the run goes on and writes the section with `[Please provide]`
 *             where the notes do not support it, `insufficient_input` flagged, never invented detail.
 *
 * Regenerate (Sam, 2026-11-14): on a `generated` report this also fills another empty section, or adds a NEW
 * version above a section that has text (`baseVersion + 1`, `ai_regenerated_section`; nothing is overwritten).
 * The request names the version the person saw (`baseVersion`), checked at the precheck, at the claim and at
 * the finish. A person's own edit is replaced only with `replaceEdited: true` (asked first, before any model
 * call or quota). The model never sees the old text: a regenerate runs from the notes alone. A failed run
 * returns the report to the status it was claimed from (`generated` stays `generated`, text untouched).
 *
 * The report is claimed (draft|error|generated -> generating) only after the filter, in the pipeline's
 * `onProceed` hook, so a warning never leaves it generating. From the claim on, whatever goes wrong
 * ends in `error` in one guarded transaction; if even that cannot be written, the lease in
 * generation-limits.ts lets the next request reclaim the report. A failure before the claim writes
 * its audit row alone.
 */

export type PipelineGenerateOutcome =
  | { ok: true; outcome: "generated"; section: { id: string; version: number; editType: "ai_generated" | "ai_regenerated_section"; text: string }; flags: PipelineResult["section"]["flags"] }
  | { ok: true; outcome: "needs_confirmation"; reason: "thin_notes"; reportStatus: FromStatus; missing: PipelineResult["missingFields"]; sensitive: boolean }
  | { ok: true; outcome: "needs_confirmation"; reason: "edited_text"; reportStatus: "generated" }
  | { ok: false; kind: "not_found" | "conflict" | "not_configured" }
  | { ok: false; kind: "rate_limited"; retryAfterSeconds: number }
  | { ok: false; kind: "failed"; reason: GenerationFailure };

/** Thrown from the pipeline's hook when the claim is refused; carried out as is (the pipeline does not reword it). */
class ClaimRefused extends Error {
  constructor(readonly claim: Extract<ProceedClaim, { ok: false }>) {
    super("claim refused");
  }
}

const sum = (values: (number | null)[]): number | undefined => (values.some((v) => v !== null) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : undefined);

export async function generateSectionWithPipeline(
  session: SessionContext,
  ids: { reportId: string; sectionId: string },
  input: { notes: string; confirm: boolean; baseVersion: number; replaceEdited: boolean },
): Promise<PipelineGenerateOutcome> {
  const actor = { organizationId: session.organizationId, actorUserId: session.userId };

  const target = { ...ids, baseVersion: input.baseVersion, replaceEdited: input.replaceEdited };
  const pre = await precheckGeneration(session, target);
  if (!pre.ok) {
    if (pre.reason === "edited_text") return { ok: true, outcome: "needs_confirmation", reason: "edited_text", reportStatus: "generated" };
    if (pre.reason === "rate_limited" || pre.reason === "busy") return { ok: false, kind: "rate_limited", retryAfterSeconds: pre.retryAfterSeconds };
    return { ok: false, kind: pre.reason === "not_generatable" ? "conflict" : pre.reason };
  }

  // The status the claim moved the report out of, once it has (what a regenerate or a failure is recorded against).
  let claimedFrom: FromStatus | null = null;

  // Ends a failed run: from the claim on, back to the status it was claimed from (`generated` or `error`) with the failure row; before it, the row alone.
  const fail = async (reason: GenerationFailure): Promise<PipelineGenerateOutcome> => {
    try {
      if (claimedFrom) await failGeneration(session, { reportId: ids.reportId, reason, mode: "real" });
      else await recordFailure(session, { reportId: ids.reportId, reason, fromStatus: pre.status });
    } catch {
      // Nothing more can be done here; the lease frees the report. Code only, no payload.
      console.error(JSON.stringify({ event: "generation_fail_write_failed", reason }));
    }
    return { ok: false, kind: "failed", reason };
  };

  try {
    let result: PipelineResult;
    try {
      result = await runPipeline(
        { organizationId: session.organizationId },
        { templates: [pre.template], sectionKey: pre.sectionKey, notes: input.notes },
        {
          mode: "real",
          endpoint: pre.baseUrl,
          models: pre.models,
          budgetMs: REAL_BUDGET_MS,
          callTimeoutMs: REAL_CALL_TIMEOUT_MS,
          // The report's own methodology version, not whatever the template has active today.
          methodologyPromptId: pre.methodologyPromptId,
          proceedIfInsufficient: input.confirm,
          onProceed: async () => {
            const claim = await claimAtProceed(session, target);
            if (!claim.ok) throw new ClaimRefused(claim);
            claimedFrom = claim.fromStatus;
          },
        },
      );
    } catch (error) {
      if (error instanceof ClaimRefused) {
        const c = error.claim;
        if (c.reason === "busy") return { ok: false, kind: "rate_limited", retryAfterSeconds: c.retryAfterSeconds };
        return { ok: false, kind: c.reason === "not_found" ? "not_found" : "conflict" };
      }
      if (error instanceof PipelineError && error.code === "methodology_unavailable") {
        // No usable methodology for this report: a configuration problem, found before any model was asked.
        await fail("invalid_config");
        return { ok: false, kind: "not_configured" };
      }
      return await fail(error instanceof PipelineError ? toGenerationFailure(error.code) : "internal");
    }

    // The filter found the notes thin and the person has not confirmed: nothing was generated and the
    // report is untouched. Say what is missing (category names from a closed list, never notes or model words).
    if (!claimedFrom) {
      if (result.outcome !== "insufficient_input") return await fail("internal");
      const filter = result.passes.find((p) => p.pass === "filter");
      const sensitive = result.section.flags.includes("sensitive_content_detected");
      const missing = result.missingFields.filter((f) => (AUDIT_MISSING_FIELDS as readonly string[]).includes(f));
      await audit(actor, {
        action: "report.generation_warned",
        resourceType: "report_generation",
        resourceId: ids.reportId,
        metadata: {
          role: session.role,
          mode: "real",
          from_status: pre.status,
          ...(filter ? { model: filter.model, latency_ms: filter.latencyMs } : {}),
          ...(missing.length > 0 ? { missing: missing.join(",") } : {}),
          ...(sensitive ? { flags: "sensitive_content_detected" } : {}),
        },
      });
      return { ok: true, outcome: "needs_confirmation", reason: "thin_notes", reportStatus: pre.status, missing, sensitive };
    }

    // Claimed: store what came back. It is untrusted until it has passed the same checks as text a person may save.
    // (An unconfirmed run whose generate pass itself reports too little input comes back as `[Please provide]`
    // with the flag, and is stored as that: the filter and the writer disagreed, and the person sees the flag.)
    const text = generatedTextSchema.safeParse(result.section.content);
    const metadata = result.methodologyPromptId
      ? llmMetadataSchema.safeParse({ mode: "real", methodologyPromptId: result.methodologyPromptId, passes: result.passes, flags: result.section.flags, costUsd: 0 })
      : null;
    if (!text.success || !metadata?.success) return await fail("invalid_output");

    const finished = await finishGeneration(session, { ...ids, baseVersion: input.baseVersion, text: text.data, metadata: metadata.data });
    if (!finished.ok) {
      if (finished.reason === "invalid_output") return await fail("invalid_output");
      // The claim was reclaimed (or access ended) while the model worked: nothing of ours was stored.
      // Undo only if the report is still ours (a no-op otherwise) and tell the caller it moved on.
      await fail("stale");
      return { ok: false, kind: "conflict" };
    }

    const last = result.passes[result.passes.length - 1];
    const inputTokens = sum(result.passes.map((p) => p.inputTokens));
    const outputTokens = sum(result.passes.map((p) => p.outputTokens));
    await audit(actor, {
      action: finished.editType === "ai_regenerated_section" ? "report.regenerated" : "report.generated",
      resourceType: "report_version",
      resourceId: finished.versionId,
      metadata: {
        role: session.role,
        mode: "real",
        from_status: claimedFrom,
        model: last.model,
        latency_ms: result.passes.reduce((a, p) => a + p.latencyMs, 0),
        ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
        ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
        ...(result.section.flags.length > 0 ? { flags: result.section.flags.join(",") } : {}),
      },
    });
    return { ok: true, outcome: "generated", section: { id: ids.sectionId, version: finished.version, editType: finished.editType, text: text.data }, flags: result.section.flags };
  } catch {
    return await fail("internal");
  }
}
