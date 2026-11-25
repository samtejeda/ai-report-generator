import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, organizationId, pk, updatedAt } from "./_shared";
import { reports } from "./reports";
import { users } from "./users";

/** The longest session-notes text a report may keep, in characters (also a CHECK on the table). */
export const REPORT_NOTES_MAX_CHARS = 20_000;
/** The longest stored extraction, as JSON text, in characters (also a CHECK on the table). */
export const REPORT_NOTES_EXTRACTED_MAX_CHARS = 100_000;

// The psychologist's session notes for one report, and the extraction derived from exactly those notes,
// so the notes are never retyped (Sam, 2026-11-25; reverses "notes are never stored"). This is raw
// clinical content: it is written to this table and nowhere else (never audit_log, llm_metadata, logs
// or error messages), and it is deleted when the report is finalized or soft-deleted and when the
// client is purged. One row per report. The text is only ever replaced, not versioned.
//
//   extracted      the extraction for these exact notes (null until one is made)
//   extracted_key  SHA-256 hex of notes + extract prompt version + model, computed by the caller, so a
//                  change in any of them makes the cached extraction stale
//
// A trigger clears both whenever `content` changes (migration 0019), so a stale extraction can never
// be stored next to new text. Hand-written parts of 0019: RLS, triggers, grants.
export const reportNotes = pgTable(
  "report_notes",
  {
    id: pk(),
    organizationId: organizationId(),
    reportId: uuid("report_id").notNull(),
    content: text("content").notNull(),
    extracted: jsonb("extracted"),
    extractedKey: text("extracted_key"),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One row per report; also the access path (organization first).
    unique("report_notes_org_report_uq").on(t.organizationId, t.reportId),
    // Cascades when the report goes (a client purge deletes its reports).
    foreignKey({
      name: "report_notes_report_fk",
      columns: [t.organizationId, t.reportId],
      foreignColumns: [reports.organizationId, reports.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "report_notes_created_by_fk",
      columns: [t.organizationId, t.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete("restrict"),
    index("report_notes_org_created_by_idx").on(t.organizationId, t.createdByUserId),
    check("report_notes_content_cap", sql`char_length(${t.content}) <= ${sql.raw(String(REPORT_NOTES_MAX_CHARS))}`),
    check("report_notes_extraction_pair", sql`(${t.extracted} is null) = (${t.extractedKey} is null)`),
    check("report_notes_extracted_key_shape", sql`${t.extractedKey} is null or ${t.extractedKey} ~ '^[0-9a-f]{64}$'`),
    check(
      "report_notes_extracted_shape",
      sql`${t.extracted} is null or (jsonb_typeof(${t.extracted}) = 'object' and char_length(${t.extracted}::text) <= ${sql.raw(String(REPORT_NOTES_EXTRACTED_MAX_CHARS))})`,
    ),
  ],
);
