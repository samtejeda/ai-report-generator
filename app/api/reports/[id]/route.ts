import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/api/respond";
import { audit } from "@/lib/audit";
import { guardedRoute } from "@/lib/auth/guard";
import { getReportDetail } from "@/lib/db/report-access";

const params = z.object({ id: z.uuid() });

// One report with its sections and their current text, if the caller may see its client. A report
// in another practice, one the caller may not see, and one that does not exist are the same 404.
// Viewing a report is a sensitive read and is audited (ids and role only).
export const GET = guardedRoute<{ id: string }>({
  roles: ["owner", "associate", "admin"],
  resource: "report",
  handler: async ({ session, params: rawParams }) => {
    const parsed = params.safeParse(rawParams);
    if (!parsed.success) return jsonError("validation_failed");
    const report = await getReportDetail(session, parsed.data.id);
    if (!report) return jsonError("not_found");
    await audit(
      { organizationId: session.organizationId, actorUserId: session.userId },
      { action: "report.viewed", resourceType: "report", resourceId: report.id, metadata: { role: session.role } },
    );
    return jsonOk({ data: report });
  },
});
