import { z } from "zod";
import { readJsonBody } from "@/lib/api/body";
import { jsonError, jsonOk } from "@/lib/api/respond";
import { audit } from "@/lib/audit";
import { guardedRoute } from "@/lib/auth/guard";
import { MAX_OFFSET, MAX_PAGE_SIZE } from "@/lib/db/client-access";
import { listReports } from "@/lib/db/report-access";
import { createReport } from "@/lib/db/report-write";
import { REPORT_STATUSES } from "@/lib/db/schema/reports";
import { templateSlug } from "@/lib/reports/structure";

const query = z
  .object({
    clientId: z.uuid().optional(),
    status: z.enum(REPORT_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
    offset: z.coerce.number().int().min(0).max(MAX_OFFSET).optional(),
  })
  .strict();

const createBody = z.strictObject({ clientId: z.uuid(), templateSlug });

// Reports the caller may see: those of clients the caller may see (lib/db/report-access.ts). No
// section text in the list. Reading the list is audited (role only).
export const GET = guardedRoute({
  roles: ["owner", "associate", "admin"],
  resource: "report",
  handler: async ({ request, session }) => {
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return jsonError("validation_failed");
    const data = await listReports(session, parsed.data);
    await audit(
      { organizationId: session.organizationId, actorUserId: session.userId },
      { action: "report.listed", resourceType: "report", metadata: { role: session.role } },
    );
    return jsonOk({ data, limit: parsed.data.limit ?? 50, offset: parsed.data.offset ?? 0 });
  },
});

// Starts a report for a client the caller may see, from a template of the practice (by slug). The
// report is a draft with one empty section per template section. A client or template that is
// missing, in another practice, or not visible is the same 404; a template with no active prompt
// version yet is a 409.
export const POST = guardedRoute({
  roles: ["owner", "associate"], // REPORT_WRITE_ROLES: written out so the coverage scan can see them
  resource: "report",
  handler: async ({ request, session }) => {
    const raw = await readJsonBody(request);
    if (!raw.ok) return jsonError("validation_failed");
    const parsed = createBody.safeParse(raw.value);
    if (!parsed.success) return jsonError("validation_failed");

    const result = await createReport(session, parsed.data);
    if (!result.ok) return jsonError(result.reason === "template_not_ready" ? "conflict" : "not_found");

    await audit(
      { organizationId: session.organizationId, actorUserId: session.userId },
      { action: "report.created", resourceType: "report", resourceId: result.report.id, metadata: { role: session.role } },
    );
    return jsonOk({ data: result.report }, 201);
  },
});
