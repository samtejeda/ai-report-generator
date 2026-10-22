import { InferenceError, runInference } from "@/lib/ai/inference";
import { audit } from "@/lib/audit";
import type { SessionContext } from "@/lib/auth/session";
import { claimGeneration, failGeneration, finishGeneration } from "@/lib/db/report-generate";
import { getEnv } from "@/lib/env";
import { generatedTextSchema } from "./content";
import { GENERATION_CALL_TIMEOUT_MS } from "./generation-limits";
import { llmMetadataSchema, type GenerationFailure } from "./generation";

/**
 * One section generation, start to finish (the dev-stub loop). The route calls this and nothing
 * else; this is the only module that reaches inference, and only through lib/ai/inference.ts.
 *
 * What is sent to the model: nothing this code chooses. `runInference` in stub mode sends one
 * fixed neutral prompt (STUB_PROMPT) to the model tag and has no parameter for a prompt, so no
 * client data and no methodology text can leave the app from here. The endpoint is the practice's
 * own allow-listed address, read from its organization row by the claim step; if there is none
 * there is nothing to call and nothing changes.
 *
 * What comes back is untrusted: it is checked (not empty, length, characters) before it is stored,
 * and stored only as `{text}`.
 *
 * The report is never left `generating`: whatever goes wrong after the claim ends in `error` (one
 * guarded transaction that also writes the failure row). If even that cannot be written, the lease
 * in lib/reports/generation-limits.ts lets the next request reclaim the report.
 */

export type GenerateOutcome =
  | { ok: true; section: { id: string; version: 1; editType: "ai_generated"; text: string } }
  | { ok: false; kind: "not_found" | "conflict" | "not_configured" }
  | { ok: false; kind: "rate_limited"; retryAfterSeconds: number }
  | { ok: false; kind: "failed"; reason: GenerationFailure };

export async function generateSection(session: SessionContext, ids: { reportId: string; sectionId: string }): Promise<GenerateOutcome> {
  // This PR is stub only. Any other mode is "not available", decided before the database is touched.
  if (getEnv().INFERENCE_MODE !== "stub") return { ok: false, kind: "not_configured" };

  const claim = await claimGeneration(session, ids);
  if (!claim.ok) {
    if (claim.reason === "rate_limited" || claim.reason === "busy") return { ok: false, kind: "rate_limited", retryAfterSeconds: claim.retryAfterSeconds };
    return { ok: false, kind: claim.reason === "not_generatable" ? "conflict" : claim.reason };
  }

  const actor = { organizationId: session.organizationId, actorUserId: session.userId };
  let known: { model?: string; latencyMs?: number } = {};

  const fail = async (reason: GenerationFailure): Promise<GenerateOutcome> => {
    try {
      await failGeneration(session, { reportId: ids.reportId, reason, mode: "stub", ...known });
    } catch {
      // Nothing more can be done here; the lease frees the report. Code only, no payload.
      console.error(JSON.stringify({ event: "generation_fail_write_failed", reason }));
    }
    return { ok: false, kind: "failed", reason };
  };

  try {
    let result;
    try {
      result = await runInference({ mode: "stub", endpoint: claim.baseUrl, models: claim.models, timeoutMs: GENERATION_CALL_TIMEOUT_MS });
    } catch (error) {
      return await fail(error instanceof InferenceError ? error.code : "internal");
    }
    known = { model: result.model, latencyMs: result.latencyMs };

    const text = generatedTextSchema.safeParse(result.text);
    if (!text.success) return await fail("invalid_output");
    const metadata = llmMetadataSchema.safeParse({
      mode: "stub",
      model: result.model,
      inputTokens: result.usage.inputTokens ?? null,
      outputTokens: result.usage.outputTokens ?? null,
      latencyMs: result.latencyMs,
      costUsd: 0,
    });
    if (!metadata.success) return await fail("invalid_output");

    const finished = await finishGeneration(session, { ...ids, text: text.data, metadata: metadata.data });
    if (!finished.ok) {
      if (finished.reason === "invalid_output") return await fail("invalid_output");
      // The claim was reclaimed (or access ended) while the model worked: nothing of ours was stored.
      // Undo only if the report is still ours (a no-op otherwise) and tell the caller it moved on.
      await fail("stale");
      return { ok: false, kind: "conflict" };
    }

    await audit(actor, {
      action: "report.generated",
      resourceType: "report_version",
      resourceId: finished.versionId,
      metadata: {
        role: session.role,
        mode: "stub",
        model: metadata.data.model,
        latency_ms: metadata.data.latencyMs,
        ...(metadata.data.inputTokens !== null ? { input_tokens: metadata.data.inputTokens } : {}),
        ...(metadata.data.outputTokens !== null ? { output_tokens: metadata.data.outputTokens } : {}),
      },
    });
    return { ok: true, section: { id: ids.sectionId, version: 1, editType: "ai_generated", text: text.data } };
  } catch {
    return await fail("internal");
  }
}
