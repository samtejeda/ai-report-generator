import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/api/respond";
import { guardedRoute } from "@/lib/auth/guard";
import { failureStatus } from "@/lib/reports/generation";
import { GENERATION_ROUTE_MAX_SECONDS } from "@/lib/reports/generation-limits";
import { generateSection } from "@/lib/reports/generate-section";

// The model call can take a while; the call itself gives up after 30 s (lib/reports/generation-limits.ts).
export const maxDuration = GENERATION_ROUTE_MAX_SECONDS;

const params = z.object({ id: z.uuid(), sectionId: z.uuid() });
const noBody = z.strictObject({});

// Fills one empty prose section with the dev-stub model's answer (stub mode only: the request to the
// model is one fixed neutral prompt, nothing about the client or the report). Sync: the finished,
// checked result comes back in this response. Stored as the section's first version (`ai_generated`),
// and the report moves draft or error -> generating -> generated (or -> error if the model fails).
// Needs the practice's own inference endpoint (set by the owner); without one it is a 409 and nothing
// changes. No body. Limits: 2 running at once per practice, 10 starts per person and 30 per practice
// per 10 minutes (429 with Retry-After). Nothing from the model or the transport is echoed in an error.
export const POST = guardedRoute<{ id: string; sectionId: string }>({
  roles: ["owner", "associate"], // REPORT_WRITE_ROLES
  resource: "report",
  handler: async ({ request, session, params: rawParams }) => {
    const ids = params.safeParse(rawParams);
    if (!ids.success) return jsonError("validation_failed");
    // Nothing in a body is used; an empty one or `{}` is fine, anything else is refused.
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
      case "failed": {
        const status = failureStatus(result.reason);
        return status === 500 ? jsonError("internal_error") : jsonError("inference_failed", { status });
      }
    }
  },
});
