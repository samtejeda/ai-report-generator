import { and, desc, eq } from "drizzle-orm";
import type { SessionContext } from "@/lib/auth/session";
import { REPORT_WRITE_ROLES } from "@/lib/auth/permissions";
import { isEditable } from "@/lib/reports/status";
import { parseTemplateStructure } from "@/lib/reports/structure";
import { visibilityFilter } from "./client-access";
import { pgCode, RESTRICT_VIOLATION, UNIQUE_VIOLATION } from "./pg-error";
import { reportVisibilityFilter, toReportView, type ReportView } from "./report-access";
import { clients, reports, reportSections, reportTemplates, reportVersions } from "./schema";
import { tenantDb } from "./tenant";

/**
 * Creating a report, saving section text, and finalizing (report shell). Everything runs in one
 * tenantDb transaction per operation, with the visibility rule inside the statements, so an
 * associate can only touch reports of clients assigned to them and "not yours" is "not found".
 *
 * Section text is never edited in place: every save inserts the next `report_versions` row
 * (`human_edit`), numbered one above the version the editor was looking at. Two writers that
 * start from the same version cannot both win: the check and the unique index on
 * (section, version number) make the second one a conflict. The other two edit types
 * (`ai_generated`, `ai_regenerated_section`) are for generation and have no caller yet.
 *
 * The database backs the status rules (migration 0013): a finalized report accepts no new
 * version, and status moves only along the allowed transitions.
 */

type Db = Parameters<typeof tenantDb>[1];

function assertWriter(session: SessionContext, what: string) {
  if (!(REPORT_WRITE_ROLES as readonly string[]).includes(session.role)) throw new Error(`${what} is not allowed for this role`);
}

export type CreateReportResult =
  | { ok: true; report: ReportView; sectionCount: number }
  | { ok: false; reason: "client_not_found" | "template_not_found" | "template_not_ready" };

export async function createReport(session: SessionContext, input: { clientId: string; templateSlug: string }, db?: Db): Promise<CreateReportResult> {
  assertWriter(session, "creating a report");
  const clientRule = visibilityFilter(session);
  if (clientRule === null) return { ok: false, reason: "client_not_found" };
  return tenantDb({ organizationId: session.organizationId }, db).transaction(async (t) => {
    const [client] = await t.find(clients, { where: and(eq(clients.id, input.clientId), clientRule), limit: 1 });
    if (!client) return { ok: false as const, reason: "client_not_found" as const };
    const [template] = await t.find(reportTemplates, { where: eq(reportTemplates.slug, input.templateSlug), limit: 1 });
    if (!template) return { ok: false as const, reason: "template_not_found" as const };
    const structure = parseTemplateStructure(template.structure);
    if (!template.activeMethodologyPromptId || !structure) return { ok: false as const, reason: "template_not_ready" as const };

    // The report pins the exact prompt version it was started with; it never changes afterwards.
    const [report] = await t.insert(reports, {
      clientId: client.id,
      templateId: template.id,
      methodologyPromptId: template.activeMethodologyPromptId,
      createdByUserId: session.userId,
    });
    await t.insert(
      reportSections,
      structure.sections.map((s, i) => ({ reportId: report.id, sectionKey: s.key, sectionType: s.type, position: i + 1 })),
    );
    return { ok: true as const, report: toReportView(report), sectionCount: structure.sections.length };
  });
}

export type SaveSectionResult =
  | { ok: true; versionId: string; version: number }
  | { ok: false; reason: "not_found" | "not_editable" | "stale" | "wrong_section_type" };

export async function saveSection(
  session: SessionContext,
  input: { reportId: string; sectionId: string; text: string; baseVersion: number },
  db?: Db,
): Promise<SaveSectionResult> {
  assertWriter(session, "editing a report");
  const visible = reportVisibilityFilter(session);
  if (visible === null) return { ok: false, reason: "not_found" };
  try {
    return await tenantDb({ organizationId: session.organizationId }, db).transaction(async (t) => {
      const [report] = await t.find(reports, { where: and(eq(reports.id, input.reportId), visible), limit: 1 });
      if (!report) return { ok: false as const, reason: "not_found" as const };
      const [section] = await t.find(reportSections, {
        where: and(eq(reportSections.id, input.sectionId), eq(reportSections.reportId, input.reportId)),
        limit: 1,
      });
      if (!section) return { ok: false as const, reason: "not_found" as const };
      if (section.sectionType !== "prose") return { ok: false as const, reason: "wrong_section_type" as const };
      if (!isEditable(report.status)) return { ok: false as const, reason: "not_editable" as const };

      // Compare-and-set on the status AND a row lock on the report: a finalize at the same moment
      // either waits for this transaction or has already committed, in which case this matches nothing.
      const touched = await t.update(reports, report.id, { updatedAt: new Date() }, eq(reports.status, report.status));
      if (!touched[0]) return { ok: false as const, reason: "not_editable" as const };

      const [latest] = await t.find(reportVersions, {
        where: eq(reportVersions.sectionId, section.id),
        orderBy: desc(reportVersions.versionNumber),
        limit: 1,
      });
      if ((latest?.versionNumber ?? 0) !== input.baseVersion) return { ok: false as const, reason: "stale" as const };

      const [row] = await t.insert(reportVersions, {
        reportId: report.id,
        sectionId: section.id,
        versionNumber: input.baseVersion + 1,
        editType: "human_edit",
        content: { text: input.text },
        createdByUserId: session.userId,
      });
      return { ok: true as const, versionId: row.id, version: row.versionNumber };
    });
  } catch (error) {
    const code = pgCode(error);
    // Two writers from the same version: the unique index lets one in. A finalize that won the
    // race trips the trigger (restrict_violation).
    if (code === UNIQUE_VIOLATION) return { ok: false, reason: "stale" };
    if (code === RESTRICT_VIOLATION) return { ok: false, reason: "not_editable" };
    throw error;
  }
}

export type FinalizeResult = { ok: true; report: ReportView } | { ok: false; reason: "not_found" | "not_generated" };

/** generated -> finalized, in one statement that also states the status it expects. */
export async function finalizeReport(session: SessionContext, reportId: string, db?: Db): Promise<FinalizeResult> {
  assertWriter(session, "finalizing a report");
  const visible = reportVisibilityFilter(session);
  if (visible === null) return { ok: false, reason: "not_found" };
  try {
    return await tenantDb({ organizationId: session.organizationId }, db).transaction(async (t) => {
      const [report] = await t.find(reports, { where: and(eq(reports.id, reportId), visible), limit: 1 });
      if (!report) return { ok: false as const, reason: "not_found" as const };
      const rows = await t.update(reports, report.id, { status: "finalized", finalizedAt: new Date() }, eq(reports.status, "generated"));
      if (!rows[0]) return { ok: false as const, reason: "not_generated" as const };
      return { ok: true as const, report: toReportView(rows[0]) };
    });
  } catch (error) {
    if (pgCode(error) === RESTRICT_VIOLATION) return { ok: false, reason: "not_generated" };
    throw error;
  }
}
