import { z } from "zod";
import { readJsonBody } from "@/lib/api/body";
import { jsonError, jsonOk } from "@/lib/api/respond";
import { guardedRoute } from "@/lib/auth/guard";
import { getEnv } from "@/lib/env";
import { failureStatus, type GenerationFailure } from "@/lib/reports/generation";
import { generateSection } from "@/lib/reports/generate-section";
import { generateSectionWithPipeline } from "@/lib/reports/generate-pipeline";
import { MAX_NOTES_CHARS } from "@/lib/reports/generation-limits";

// The stub call gives up after 30 s; a real-mode run (three passes) is allowed up to 270 s inside this 300 s (lib/reports/generation-limits.ts).
// Next.js reads this at build time, so it must be a literal number, not an imported constant;
// lib/reports/generation.test.ts keeps it equal to GENERATION_ROUTE_MAX_SECONDS.
export const maxDuration = 300;

const params = z.object({ id: z.uuid(), sectionId: z.uuid() });
const noBody = z.strictObject({});
// Real mode: the psychologist's session notes travel in the request (never stored) and, when the first call
// answered `needs_confirmation`, the same call is made again with `confirm: true`. Nothing else is accepted.
const realBody = z.strictObject({
  notes: z.string().max(MAX_NOTES_CHARS).refine((n) => n.trim().length > 0),
  confirm: z.boolean().optional(),
});
// Notes may hold multi-byte characters and JSON escapes; this bounds the raw body before it is parsed.
const MAX_REAL_BODY_CHARS = MAX_NOTES_CHARS * 6 + 256;

function failed(reason: GenerationFailure): Response {
  const status = failureStatus(reason);
  return status === 500 ? jsonError("internal_error") : jsonError("inference_failed", { status });
}

// Fills one empty prose section with the dev-stub model's answer (stub mode only: the request to the
// model is one fixed neutral prompt, nothing about the client or the report). Sync: the finished,
// checked result comes back in this response. Stored as the section's first version (`ai_generated`),
// and the report moves draft or error -> generating -> generated (or -> error if the model fails).
// Needs the practice's own inference endpoint (set by the owner); without one it is a 409 and nothing
// changes. No body. Limits: 2 running at once per practice, 10 starts per person and 30 per practice
// per 10 minutes (429 with Retry-After). Nothing from the model or the transport is echoed in an error.
//
// INFERENCE_MODE=real runs the three-pass pipeline instead (lib/reports/generate-pipeline.ts), from the
// notes in the body: `{ notes, confirm? }`. Thin notes answer `needs_confirmation` first, with nothing generated
// and the report untouched; the same call again with `confirm: true` goes ahead. API.md has the whole contract.
export const POST = guardedRoute<{ id: string; sectionId: string }>({
  roles: ["owner", "associate"], // REPORT_WRITE_ROLES
  resource: "report",
  handler: async ({ request, session, params: rawParams }) => {
    const ids = params.safeParse(rawParams);
    if (!ids.success) return jsonError("validation_failed");
    if (getEnv().INFERENCE_MODE === "real") {
      const body = await readJsonBody(request, MAX_REAL_BODY_CHARS);
      const parsed = body.ok ? realBody.safeParse(body.value) : null;
      if (!parsed?.success) return jsonError("validation_failed");
      const outcome = await generateSectionWithPipeline(session, { reportId: ids.data.id, sectionId: ids.data.sectionId }, { notes: parsed.data.notes, confirm: parsed.data.confirm === true });
      if (outcome.ok) {
        if (outcome.outcome === "needs_confirmation") {
          return jsonOk({ data: { outcome: "needs_confirmation", reportStatus: outcome.reportStatus, missing: outcome.missing, sensitive: outcome.sensitive } });
        }
        return jsonOk({ data: { outcome: "generated", reportStatus: "generated", section: outcome.section, flags: outcome.flags } });
      }
      switch (outcome.kind) {
        case "not_found":
          return jsonError("not_found");
        case "conflict":
          return jsonError("conflict");
        case "not_configured":
          return jsonError("inference_not_configured");
        case "rate_limited":
          return jsonError("rate_limited", { retryAfterSeconds: outcome.retryAfterSeconds });
        case "failed":
          return failed(outcome.reason);
      }
    }

    // Stub mode: nothing in a body is used; an empty one or `{}` is fine, anything else is refused.
    const text = await request.text();
    if (text.length > 0) {
      let value: unknown;
      try {
        value = text.length <= 16 ? JSON.parse(text) : null;
      } catch {
        value = null;
      }
      if (!noBody.safeParse(value).success) return jsonError("validation_failed");
    }

    const result = await generateSection(session, { reportId: ids.data.id, sectionId: ids.data.sectionId });
    if (result.ok) return jsonOk({ data: { reportStatus: "generated", section: result.section } });
    switch (result.kind) {
      case "not_found":
        return jsonError("not_found");
      case "conflict":
        return jsonError("conflict");
      case "not_configured":
        return jsonError("inference_not_configured");
      case "rate_limited":
        return jsonError("rate_limited", { retryAfterSeconds: result.retryAfterSeconds });
      case "failed":
        return failed(result.reason);
    }
  },
});
