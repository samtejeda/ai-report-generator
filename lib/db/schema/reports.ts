import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, deletedAt, organizationId, pk, updatedAt } from "./_shared";
import { clients } from "./clients";
import { methodologyPrompts } from "./templates";
import { users } from "./users";

export const REPORT_STATUSES = ["draft", "generating", "generated", "finalized", "error"] as const;
export const SECTION_TYPES = ["prose", "structured"] as const;
export const EDIT_TYPES = ["ai_generated", "human_edit", "ai_regenerated_section"] as const;

export const reports = pgTable(
  "reports",
  {
    id: pk(),
    organizationId: organizationId(),
    clientId: uuid("client_id").notNull(),
    templateId: uuid("template_id").notNull(),
    // The exact prompt version this report was generated with (never changes).
    methodologyPromptId: uuid("methodology_prompt_id").notNull(),
    status: text("status", { enum: REPORT_STATUSES }).notNull().default("draft"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique("reports_org_id_uq").on(t.organizationId, t.id),
    // Cascades on client purge (hard-deletion propagation).
    foreignKey({
      name: "reports_client_fk",
      columns: [t.organizationId, t.clientId],
      foreignColumns: [clients.organizationId, clients.id],
    }).onDelete("cascade"),
    // Template and prompt must be in the same org, and the prompt must belong to the template.
    foreignKey({
      name: "reports_template_prompt_fk",
      columns: [t.organizationId, t.templateId, t.methodologyPromptId],
      foreignColumns: [methodologyPrompts.organizationId, methodologyPrompts.templateId, methodologyPrompts.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "reports_created_by_fk",
      columns: [t.organizationId, t.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete("restrict"),
    index("reports_org_client_created_idx").on(t.organizationId, t.clientId, t.createdAt.desc()),
    index("reports_org_status_idx").on(t.organizationId, t.status),
    index("reports_org_template_prompt_idx").on(t.organizationId, t.templateId, t.methodologyPromptId),
    index("reports_org_created_by_idx").on(t.organizationId, t.createdByUserId),
    check("reports_status_valid", sql`${t.status} in ('draft','generating','generated','finalized','error')`),
    // Status transitions are validated in the app (finalize only from generated); this
    // keeps the two fields from disagreeing.
    check("reports_finalized_consistent", sql`(${t.status} = 'finalized') = (${t.finalizedAt} is not null)`),
  ],
);

// Stable identity of a section within a report (plan decision D2). Content lives in
// report_versions; the current text is the highest version_number for the section.
export const reportSections = pgTable(
  "report_sections",
  {
    id: pk(),
    organizationId: organizationId(),
    reportId: uuid("report_id").notNull(),
    sectionKey: text("section_key").notNull(),
    // Discriminator for report_versions.content: prose vs structured (scores, norms).
    sectionType: text("section_type", { enum: SECTION_TYPES }).notNull(),
    position: integer("position").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Target of the report_versions composite FK, which pins section to report and org.
    unique("report_sections_org_report_id_uq").on(t.organizationId, t.reportId, t.id),
    unique("report_sections_report_key_uq").on(t.reportId, t.sectionKey),
    foreignKey({
      name: "report_sections_report_fk",
      columns: [t.organizationId, t.reportId],
      foreignColumns: [reports.organizationId, reports.id],
    }).onDelete("cascade"),
    index("report_sections_org_report_position_idx").on(t.organizationId, t.reportId, t.position),
    check("report_sections_type_valid", sql`${t.sectionType} in ('prose','structured')`),
  ],
);

// INSERT-ONLY: every edit is a new row. Never updated or deleted, except by the purge
// function during a hard-deletion request. Enforced by grants and triggers (custom
// migration) and by the tenant helper's types.
export const reportVersions = pgTable(
  "report_versions",
  {
    id: pk(),
    organizationId: organizationId(),
    reportId: uuid("report_id").notNull(),
    sectionId: uuid("section_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    editType: text("edit_type", { enum: EDIT_TYPES }).notNull(),
    // Shape depends on report_sections.section_type; validated with zod in the app.
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    // model / tokens / latency / cost. No prompt text or client content.
    llmMetadata: jsonb("llm_metadata").$type<Record<string, unknown>>(),
    // Null for AI-generated rows.
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("report_versions_section_version_uq").on(t.sectionId, t.versionNumber),
    // Section must belong to this report and org. Cascades from reports via sections.
    foreignKey({
      name: "report_versions_section_fk",
      columns: [t.organizationId, t.reportId, t.sectionId],
      foreignColumns: [reportSections.organizationId, reportSections.reportId, reportSections.id],
    }).onDelete("cascade"),
    // RESTRICT, not SET NULL: SET NULL is an UPDATE, which this table forbids.
    foreignKey({
      name: "report_versions_created_by_fk",
      columns: [t.organizationId, t.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete("restrict"),
    index("report_versions_org_report_created_idx").on(t.organizationId, t.reportId, t.createdAt),
    index("report_versions_org_created_by_idx").on(t.organizationId, t.createdByUserId),
    check("report_versions_edit_type_valid", sql`${t.editType} in ('ai_generated','human_edit','ai_regenerated_section')`),
    check(
      "report_versions_human_edit_has_author",
      sql`${t.editType} <> 'human_edit' or ${t.createdByUserId} is not null`,
    ),
  ],
);
