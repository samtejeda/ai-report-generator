import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/api/respond";
import { audit } from "@/lib/audit";
import { guardedRoute } from "@/lib/auth/guard";
import { MAX_OFFSET, MAX_PAGE_SIZE } from "@/lib/db/client-access";
import { listSectionVersions } from "@/lib/db/report-access";

const params = z.object({ id: z.uuid(), sectionId: z.uuid() });
const query = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
    offset: z.coerce.number().int().min(0).max(MAX_OFFSET).optional(),
  })
  .strict();

// The history of one section, newest first (version number, edit type, text, time). Same
// visibility as the report; a section that is not part of that report is the same 404.
export const GET = guardedRoute<{ id: string; sectionId: string }>({
  roles: ["owner", "associate", "admin"],
  resource: "report",
  handler: async ({ request, session, params: rawParams }) => {
    const ids = params.safeParse(rawParams);
    if (!ids.success) return jsonError("validation_failed");
    const q = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!q.success) return jsonError("validation_failed");
    const data = await listSectionVersions(session, ids.data.id, ids.data.sectionId, q.data);
    if (!data) return jsonError("not_found");
    await audit(
      { organizationId: session.organizationId, actorUserId: session.userId },
      { action: "report.viewed", resourceType: "report_section", resourceId: ids.data.sectionId, metadata: { role: session.role } },
    );
    return jsonOk({ data, limit: q.data.limit ?? 50, offset: q.data.offset ?? 0 });
  },
});
