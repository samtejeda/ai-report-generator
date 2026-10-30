import { and, asc, eq } from "drizzle-orm";
import type { SessionContext } from "@/lib/auth/session";
import { STATE_READS_PER_MINUTE } from "@/lib/reports/state-limits";
import { authorNames, isCurrentVersion, reportVisibilityFilter, type ReportView } from "./report-access";
import { reports, reportSections, reportVersions } from "./schema";
import { tenantDb } from "./tenant";

/**
 * The metadata-only read behind GET /api/reports/{id}/state: the report's status and, per
 * section, the current version number, its kind, when it was written and by whom (a display name,
 * as in report-access.ts). No text, no titles, no ids of people.
 *
 * NO AUDIT ROW, BY DECISION (Sam, 2026-10-30, PROGRESS.md decision 14): opening a report and
 * every edit are already audited, and this carries no client text. Do not add an `audit()` call
 * here or in the route; lib/reports/state.test.ts fails if one appears. The abuse control is the
 * per-person limit below, not a log.
 *
 * One transaction, a fixed number of statements however many sections there are: the counter, the
 * report (visibility rule), the sections, the current versions (one query for all, without their
 * text column), and the author names (one query, skipped when nobody has an author). Easy to remove with its route and test if
 * the check proves a burden (PROGRESS.md decision 15).
 */

type Db = Parameters<typeof tenantDb>[1];

export type SectionState = {
  id: string;
  version: number;
  editType: (typeof reportVersions.$inferSelect)["editType"] | null;
  editedAt: string | null;
  authorName: string | null;
};
export type ReportStateView = { status: ReportView["status"]; sections: SectionState[] };

export type StateResult =
  | { ok: true; state: ReportStateView }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "rate_limited"; retryAfterSeconds: number };

export async function getReportState(session: SessionContext, reportId: string, db?: Db): Promise<StateResult> {
  const visible = reportVisibilityFilter(session);
  if (visible === null) return { ok: false, reason: "not_found" };
  return tenantDb({ organizationId: session.organizationId }, db).transaction(async (t): Promise<StateResult> => {
    // Counted before anything about the report is looked up, and per person (not per report), so a
    // 429 is the same for a visible, a foreign and a missing report and says nothing about any of them.
    const used = await t.countRead(session.userId, "report_state", STATE_READS_PER_MINUTE);
    if (used.count > STATE_READS_PER_MINUTE) return { ok: false, reason: "rate_limited", retryAfterSeconds: used.secondsLeft };

    const [report] = await t.find(reports, { where: and(eq(reports.id, reportId), visible), limit: 1 });
    if (!report) return { ok: false, reason: "not_found" };
    const sections = await t.find(reportSections, { where: eq(reportSections.reportId, report.id), orderBy: asc(reportSections.position), limit: 200 });
    // Not the text: only the columns this answer needs, so the section text is never read from the database.
    const current = await t.find(reportVersions, {
      columns: ["sectionId", "versionNumber", "editType", "createdAt", "createdByUserId"],
      where: and(eq(reportVersions.reportId, report.id), isCurrentVersion),
      limit: 200,
    });
    const names = await authorNames(t, current);
    const bySection = new Map(current.map((v) => [v.sectionId, v]));
    return {
      ok: true,
      state: {
        status: report.status,
        sections: sections.map((s): SectionState => {
          const v = bySection.get(s.id);
          return {
            id: s.id,
            version: v?.versionNumber ?? 0,
            editType: v?.editType ?? null,
            editedAt: v ? v.createdAt.toISOString() : null,
            authorName: (v?.createdByUserId && names.get(v.createdByUserId)) || null,
          };
        }),
      },
    };
  });
}
