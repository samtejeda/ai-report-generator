import { z } from "zod";
import { readJsonBody } from "@/lib/api/body";
import { jsonError, jsonOk } from "@/lib/api/respond";
import { audit } from "@/lib/audit";
import { guardedRoute } from "@/lib/auth/guard";
import { saveSection } from "@/lib/db/report-write";
import { MAX_SECTION_BODY, sectionEditBody } from "@/lib/reports/content";

const params = z.object({ id: z.uuid(), sectionId: z.uuid() });

// Saves new text for one section: inserts the next report_versions row (human_edit), never
// overwrites. Body `{text, baseVersion}`: baseVersion is the version the editor was looking at (0 for
// a section nobody has written), and a different current version is a 409 so nobody silently
// overwrites a colleague. Allowed while the report is draft, generated or error; generating and
// finalized are 409. A section that is not part of that report is the same 404 as any other
// missing thing. Nothing from the body is echoed or audited.
export const PUT = guardedRoute<{ id: string; sectionId: string }>({
  roles: ["owner", "associate"], // REPORT_WRITE_ROLES
  resource: "report",
  handler: async ({ request, session, params: rawParams }) => {
    const ids = params.safeParse(rawParams);
    if (!ids.success) return jsonError("validation_failed");
    const raw = await readJsonBody(request, MAX_SECTION_BODY);
    if (!raw.ok) return jsonError("validation_failed");
    const body = sectionEditBody.safeParse(raw.value);
    if (!body.success) return jsonError("validation_failed");

    const result = await saveSection(session, { reportId: ids.data.id, sectionId: ids.data.sectionId, ...body.data });
    if (!result.ok) return jsonError(result.reason === "not_found" ? "not_found" : "conflict");

    await audit(
      { organizationId: session.organizationId, actorUserId: session.userId },
      { action: "report.section_edited", resourceType: "report_version", resourceId: result.versionId, metadata: { role: session.role } },
    );
    return jsonOk({ data: { versionId: result.versionId, version: result.version } });
  },
});
