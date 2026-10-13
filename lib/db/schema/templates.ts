import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { createdAt, deletedAt, organizationId, pk, updatedAt } from "./_shared";
import { users } from "./users";

// Section layout for a report type (keys, types, order). Not methodology text.
export const reportTemplates = pgTable(
  "report_templates",
  {
    id: pk(),
    organizationId: organizationId(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    structure: jsonb("structure").$type<Record<string, unknown>>().notNull(),
    // Pointer to the single active prompt version (plan decision D1). Moving the pointer
    // is how a prompt is activated, so methodology_prompts rows are never updated.
    // One active prompt per template holds structurally: it is one column. The FK below
    // also guarantees the pointed-to prompt belongs to THIS template and org.
    activeMethodologyPromptId: uuid("active_methodology_prompt_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  // Explicit return type breaks the templates <-> prompts circular type inference.
  (t): PgTableExtraConfigValue[] => [
    unique("report_templates_org_id_uq").on(t.organizationId, t.id),
    uniqueIndex("report_templates_org_slug_active_uq")
      .on(t.organizationId, t.slug)
      .where(sql`${t.deletedAt} is null`),
    foreignKey({
      name: "report_templates_active_prompt_fk",
      columns: [t.organizationId, t.id, t.activeMethodologyPromptId],
      foreignColumns: [methodologyPrompts.organizationId, methodologyPrompts.templateId, methodologyPrompts.id],
    }).onDelete("restrict"),
  ],
);

// IMMUTABLE and versioned: a change is a new row, never an UPDATE or DELETE. Enforced by
// grants and triggers (custom migration) and by the tenant helper's types. The prompt
// text lives in `content` in the database only; it is never committed to the repo.
export const methodologyPrompts = pgTable(
  "methodology_prompts",
  {
    id: pk(),
    organizationId: organizationId(),
    templateId: uuid("template_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    // Named prompt sections (role, methodology, structure, constraints, output, examples).
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    // What changed and why. Required: every prompt change is explained.
    notes: text("notes").notNull(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    // Target of composite FKs from reports and report_templates.
    unique("methodology_prompts_org_template_id_uq").on(t.organizationId, t.templateId, t.id),
    unique("methodology_prompts_template_version_uq").on(t.templateId, t.versionNumber),
    foreignKey({
      name: "methodology_prompts_template_fk",
      columns: [t.organizationId, t.templateId],
      foreignColumns: [reportTemplates.organizationId, reportTemplates.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "methodology_prompts_created_by_fk",
      columns: [t.organizationId, t.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete("restrict"),
    index("methodology_prompts_org_created_by_idx").on(t.organizationId, t.createdByUserId),
  ],
);
