import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import type { SessionContext } from "@/lib/auth/session";
import { parseProseContent } from "@/lib/reports/content";
import { parseTemplateStructure } from "@/lib/reports/structure";
import { z } from "zod";
import { visibilityFilter, clampPage } from "./client-access";
import { clients, reports, reportSections, reportTemplates, reportVersions } from "./schema";
import { REPORT_STATUSES } from "./schema/reports";
import { tenantDb } from "./tenant";

/**
 * Who may see which report, and what a report looks like on the way out. A report is visible
 * exactly when its client is visible (lib/db/client-access.ts): owner every live client's reports,
 * associate and admin only reports of clients assigned or granted to them. A soft-deleted client
 * takes its reports with it. The rule is inside the query, so a route that forgets to check still
 * cannot return someone else's report; anything not visible is simply absent (404).
 *
 * Reading is not writing: who may create, edit and finalize is lib/db/report-write.ts.
 */

type Db = Parameters<typeof tenantDb>[1];
type ReportRow = typeof reports.$inferSelect;
type VersionRow = typeof reportVersions.$inferSelect;
const uuid = z.uuid();

/** Report fields that ever leave the server. No organization id, no prompt id, no author id. */
export type ReportView = { id: string; clientId: string; status: ReportRow["status"]; finalizedAt: string | null; createdAt: string; updatedAt: string };

export type SectionView = {
  id: string;
  key: string;
  title: string;
  type: "prose" | "structured";
  position: number;
  /** The current text: the highest version. Empty when nobody has written it. */
  text: string;
  /** The highest version number; 0 when none. Send it back as `baseVersion` when saving. */
  version: number;
  editType: VersionRow["editType"] | null;
  editedAt: string | null;
};

export type ReportDetail = ReportView & { templateSlug: string; sections: SectionView[] };

export type VersionView = { id: string; version: number; editType: VersionRow["editType"]; text: string; createdAt: string };

export const toReportView = (r: ReportRow): ReportView => ({
  id: r.id,
  clientId: r.clientId,
  status: r.status,
  finalizedAt: r.finalizedAt ? r.finalizedAt.toISOString() : null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/**
 * The extra row filter for reports: null means "no reports at all" (role may not reach clinical
 * content). Otherwise an EXISTS on the report's own client that is live and visible to the caller.
 */
export function reportVisibilityFilter(session: SessionContext): SQL | null {
  const clientRule = visibilityFilter(session);
  if (clientRule === null) return null;
  return sql`exists (
    select 1 from ${clients}
    where ${clients.organizationId} = ${reports.organizationId}
      and ${clients.id} = ${reports.clientId}
      and ${clients.deletedAt} is null
      ${clientRule ? sql`and ${clientRule}` : sql``}
  )`;
}

/** "The highest version of its section", for a find on report_versions. One query for all sections. */
const isCurrentVersion = sql`${reportVersions.versionNumber} = (
  select max(v2.version_number) from report_versions v2
  where v2.organization_id = ${reportVersions.organizationId} and v2.section_id = ${reportVersions.sectionId}
)`;

export type ListFilter = { clientId?: string; status?: (typeof REPORT_STATUSES)[number]; limit?: number; offset?: number };

export async function listReports(session: SessionContext, filter: ListFilter = {}, db?: Db): Promise<ReportView[]> {
  const visible = reportVisibilityFilter(session);
  if (visible === null) return [];
  const { limit, offset } = clampPage(filter);
  const where: SQL[] = [visible];
  if (filter.clientId) where.push(eq(reports.clientId, filter.clientId));
  if (filter.status) where.push(eq(reports.status, filter.status));
  const rows = await tenantDb({ organizationId: session.organizationId }, db).find(reports, {
    where: and(...where),
    orderBy: [desc(reports.createdAt), desc(reports.id)],
    limit,
    offset,
  });
  return rows.map(toReportView);
}

/** One visible report with its sections and their current text, or undefined (respond 404). */
export async function getReportDetail(session: SessionContext, id: string, db?: Db): Promise<ReportDetail | undefined> {
  if (!uuid.safeParse(id).success) return undefined;
  const visible = reportVisibilityFilter(session);
  if (visible === null) return undefined;
  return tenantDb({ organizationId: session.organizationId }, db).transaction(async (t) => {
    const [report] = await t.find(reports, { where: and(eq(reports.id, id), visible), limit: 1 });
    if (!report) return undefined;
    // The template may have been deleted since; its layout is still needed to title the sections.
    const [template] = await t.find(reportTemplates, { where: eq(reportTemplates.id, report.templateId), limit: 1, includeDeleted: true });
    const structure = template ? parseTemplateStructure(template.structure) : null;
    const titles = new Map(structure?.sections.map((s) => [s.key, s.title]) ?? []);
    const sections = await t.find(reportSections, { where: eq(reportSections.reportId, id), orderBy: asc(reportSections.position), limit: 200 });
    const current = await t.find(reportVersions, { where: and(eq(reportVersions.reportId, id), isCurrentVersion), limit: 200 });
    const bySection = new Map(current.map((v) => [v.sectionId, v]));
    return {
      ...toReportView(report),
      templateSlug: template?.slug ?? "",
      sections: sections.map((s): SectionView => {
        const v = bySection.get(s.id);
        const content = v ? parseProseContent(v.content) : null;
        return {
          id: s.id,
          key: s.sectionKey,
          title: titles.get(s.sectionKey) ?? s.sectionKey,
          type: s.sectionType,
          position: s.position,
          text: content?.text ?? "",
          version: v?.versionNumber ?? 0,
          editType: v?.editType ?? null,
          editedAt: v ? v.createdAt.toISOString() : null,
        };
      }),
    };
  });
}

/** A section's history, newest first, if the report is visible and the section belongs to it. */
export async function listSectionVersions(
  session: SessionContext,
  reportId: string,
  sectionId: string,
  page: { limit?: number; offset?: number } = {},
  db?: Db,
): Promise<VersionView[] | undefined> {
  if (!uuid.safeParse(reportId).success || !uuid.safeParse(sectionId).success) return undefined;
  const visible = reportVisibilityFilter(session);
  if (visible === null) return undefined;
  const { limit, offset } = clampPage(page);
  return tenantDb({ organizationId: session.organizationId }, db).transaction(async (t) => {
    const [report] = await t.find(reports, { where: and(eq(reports.id, reportId), visible), limit: 1 });
    if (!report) return undefined;
    const [section] = await t.find(reportSections, { where: and(eq(reportSections.id, sectionId), eq(reportSections.reportId, reportId)), limit: 1 });
    if (!section) return undefined;
    const rows = await t.find(reportVersions, {
      where: and(eq(reportVersions.sectionId, sectionId), eq(reportVersions.reportId, reportId)),
      orderBy: desc(reportVersions.versionNumber),
      limit,
      offset,
    });
    return rows.map((v) => ({
      id: v.id,
      version: v.versionNumber,
      editType: v.editType,
      text: parseProseContent(v.content)?.text ?? "",
      createdAt: v.createdAt.toISOString(),
    }));
  });
}
