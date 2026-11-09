import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { SessionContext } from "@/lib/auth/session";
import { REPORT_WRITE_ROLES } from "@/lib/auth/permissions";
import { buildAuditRow } from "@/lib/audit";
import { buildReportDocx, exportFileName } from "@/lib/reports/export-docx";
import { EXPORT_WINDOW_SECONDS, MAX_EXPORTS_PER_USER } from "@/lib/reports/export-limits";
import { readReportDetail, reportVisibilityFilter } from "./report-access";
import { auditLog, reports } from "./schema";
import { tenantDb } from "./tenant";

/**
 * One export of a report to a Word file: the data side of GET /api/reports/{id}/export.
 *
 * Everything happens in ONE transaction, in this order, so that a file cannot leave without its
 * audit row:
 *   1. the report is looked up under the visibility rule (anything else is "not found", and costs no quota);
 *   2. a per-practice lock, then the person's own `report.exported` rows in the window are counted;
 *   3. the report's sections and their current text are read (the same read the report page uses);
 *   4. the document is built in memory (no network, no database);
 *   5. the audit row (`report.exported`: report id, role, format; never content) is inserted.
 * The bytes are returned only after the commit. If the audit row cannot be written the transaction
 * fails and nothing is returned (fail closed: a disclosure with no record of it is the worse outcome).
 *
 * The draft line is decided by the status read in step 1. A report can only move toward
 * `finalized`, and its text is read after its status, so the file can be newer than its status
 * line but never older: at worst it says DRAFT about text that was finalized a moment later.
 */

type Db = Parameters<typeof tenantDb>[1];

export type ExportResult =
  | { ok: true; bytes: Uint8Array; fileName: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "rate_limited"; retryAfterSeconds: number };

const window = sql`make_interval(secs => ${EXPORT_WINDOW_SECONDS})`;

export async function exportReportDocx(session: SessionContext, reportId: string, db?: Db): Promise<ExportResult> {
  if (!(REPORT_WRITE_ROLES as readonly string[]).includes(session.role)) throw new Error("exporting a report is not allowed for this role");
  const visible = reportVisibilityFilter(session);
  if (visible === null) return { ok: false, reason: "not_found" };
  return tenantDb({ organizationId: session.organizationId }, db).transaction(async (t): Promise<ExportResult> => {
    const [report] = await t.find(reports, { where: and(eq(reports.id, reportId), visible), limit: 1 });
    if (!report) return { ok: false, reason: "not_found" };

    // One export decision at a time per practice, so the count and the row that adds to it cannot be raced.
    await t.lock("export");
    const recent = await t.find(auditLog, {
      where: and(eq(auditLog.action, "report.exported"), eq(auditLog.actorUserId, session.userId), gt(auditLog.createdAt, sql`now() - ${window}`)),
      orderBy: desc(auditLog.createdAt),
      limit: MAX_EXPORTS_PER_USER,
    });
    if (recent.length >= MAX_EXPORTS_PER_USER) {
      // The oldest of the newest `MAX` exports is the one that has to age out of the window.
      const oldest = recent[recent.length - 1].createdAt.getTime();
      return { ok: false, reason: "rate_limited", retryAfterSeconds: Math.max(1, Math.ceil(EXPORT_WINDOW_SECONDS - (Date.now() - oldest) / 1000)) };
    }

    const detail = await readReportDetail(t, report, { authors: false });
    const bytes = await buildReportDocx({
      finalized: report.status === "finalized",
      sections: detail.sections.map((s) => ({ title: s.title, type: s.type, text: s.text })),
    });

    await t.insert(auditLog, {
      ...buildAuditRow({ action: "report.exported", resourceType: "report", resourceId: report.id, metadata: { role: session.role, format: "docx" } }),
      actorUserId: session.userId,
      requestId: null,
    });
    return { ok: true, bytes, fileName: exportFileName(report.id) };
  });
}
