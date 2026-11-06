import { z } from "zod";
import { jsonError } from "@/lib/api/respond";
import { guardedRoute } from "@/lib/auth/guard";
import { exportReportDocx } from "@/lib/db/report-export";
import { DOCX_CONTENT_TYPE } from "@/lib/reports/export-docx";

const params = z.object({ id: z.uuid() });
// The one format today. A later PDF PR adds its value here and to AUDIT_EXPORT_FORMATS in lib/audit.ts.
const query = z.strictObject({ format: z.literal("docx") });

// Downloads a report as a Word file built from the current text of every section, in order. Same
// visibility as GET /api/reports/{id} (anything not visible is the same 404). Owner and assigned
// associate only; an admin is refused (403, audited). A report may be exported before it is
// finalized: the file then says "DRAFT, not finalized" in its first line and on every page.
//
// The file name is the report id and nothing else (never a client's name). One `report.exported`
// audit row is written inside the same transaction as the read, before any byte is released, so
// an export without its record cannot happen (lib/db/report-export.ts). Limit: 20 per person per
// 10 minutes (429 with Retry-After). Nothing is fetched from anywhere; the file is built in memory.
export const GET = guardedRoute<{ id: string }>({
  roles: ["owner", "associate"], // REPORT_WRITE_ROLES
  resource: "report",
  handler: async ({ request, session, params: rawParams }) => {
    const ids = params.safeParse(rawParams);
    if (!ids.success) return jsonError("validation_failed");
    const q = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!q.success) return jsonError("validation_failed");

    const result = await exportReportDocx(session, ids.data.id);
    if (!result.ok) {
      return result.reason === "rate_limited" ? jsonError("rate_limited", { retryAfterSeconds: result.retryAfterSeconds }) : jsonError("not_found");
    }
    // A copy backed by a plain ArrayBuffer, so the body is exactly the file's bytes.
    const body = new Uint8Array(result.bytes);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": DOCX_CONTENT_TYPE,
        // Built from the validated report uuid only (exportFileName throws on anything else).
        "Content-Disposition": `attachment; filename="${result.fileName}"`,
        "Content-Length": String(body.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
});
