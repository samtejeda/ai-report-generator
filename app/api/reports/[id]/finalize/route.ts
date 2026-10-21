import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/api/respond";
import { audit } from "@/lib/audit";
import { guardedRoute } from "@/lib/auth/guard";
import { finalizeReport } from "@/lib/db/report-write";

const params = z.object({ id: z.uuid() });

// Closes a report: generated -> finalized, and only from generated. Any other status is a 409. A
// finalized report accepts no further edits (the database refuses them as well). Owner or
// associate; the report must belong to a client the caller may see (else the same 404).
export const POST = guardedRoute<{ id: string }>({
  roles: ["owner", "associate"], // REPORT_WRITE_ROLES
  resource: "report",
  handler: async ({ session, params: rawParams }) => {
    const parsed = params.safeParse(rawParams);
    if (!parsed.success) return jsonError("validation_failed");
    const result = await finalizeReport(session, parsed.data.id);
    if (!result.ok) return jsonError(result.reason === "not_found" ? "not_found" : "conflict");
    await audit(
      { organizationId: session.organizationId, actorUserId: session.userId },
      { action: "report.finalized", resourceType: "report", resourceId: result.report.id, metadata: { role: session.role } },
    );
    return jsonOk({ data: result.report });
  },
});
