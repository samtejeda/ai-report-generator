import { and, eq } from "drizzle-orm";
import type { SessionContext } from "@/lib/auth/session";
import { REPORT_WRITE_ROLES } from "@/lib/auth/permissions";
import { pgCode, RESTRICT_VIOLATION, UNIQUE_VIOLATION } from "./pg-error";
import { reportVisibilityFilter } from "./report-access";
import { reportNotes, reports, REPORT_NOTES_EXTRACTED_MAX_CHARS, REPORT_NOTES_MAX_CHARS } from "./schema";
import { tenantDb } from "./tenant";

/**
 * The psychologist's session notes for one report, and the extraction derived from exactly those notes
 * (Sam, 2026-11-25: the notes are kept so they are never retyped). Raw clinical content: it lives in
 * `report_notes` and nowhere else.
 *
 * Who: owner and an associate who may see the report (the report's own visibility rule runs inside the
 * statement, so another practice's report, or one the caller may not see, is "not found"). An admin is
 * refused for reads and writes alike, even with a client grant: notes are more sensitive than the
 * finished report, and export already refuses an admin. The backstop is a thrown error because a route
 * must already have refused the role.
 *
 * Never, anywhere: the text or the extraction in audit_log, llm_metadata, a log line or an error message.
 * Audit rows (ids and length only) are written by the routes, not here. A database error from these
 * functions would carry the text (Drizzle puts the query parameters in its message, and a Postgres CHECK
 * failure puts the failing row in its detail), so every database error is replaced by one that carries
 * the Postgres error code only (`ReportNotesStoreError`, no `cause`).
 *
 * The database backs the rules (migration 0019): a text change clears the extraction, a finalized or
 * deleted report keeps no notes (finalizing or deleting a report deletes the row in the same
 * transaction), the cap, and one row per report.
 */

type Db = Parameters<typeof tenantDb>[1];

/** A database error with everything that could hold notes text removed: the Postgres code and nothing else. */
export class ReportNotesStoreError extends Error {
  readonly code: string | undefined;
  constructor(code: string | undefined) {
    super(code ? `report notes store failed (${code})` : "report notes store failed");
    this.name = "ReportNotesStoreError";
    this.code = code;
  }
}

/** Runs `fn`; any error other than our own leaves as a ReportNotesStoreError (code only, no cause, no message text). */
export async function scrubbed<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ReportNotesStoreError) throw error;
    throw new ReportNotesStoreError(pgCode(error));
  }
}

function assertNotesRole(session: SessionContext) {
  if (!(REPORT_WRITE_ROLES as readonly string[]).includes(session.role)) throw new Error("session notes are not available to this role");
}

/** Characters as Postgres counts them (code points), so a text that passes here can never fail the table's CHECK. */
const charCount = (text: string) => Array.from(text).length;

export type NotesTextProblem = "blank" | "too_long" | "invalid_text";
/** Validates notes text before the database sees it; the reason never contains the text. */
export function notesTextProblem(text: unknown): NotesTextProblem | null {
  if (typeof text !== "string" || text.trim() === "") return "blank";
  if (text.includes("\u0000")) return "invalid_text";
  if (charCount(text) > REPORT_NOTES_MAX_CHARS) return "too_long";
  return null;
}

/** What a read gives back: the text, and the cached extraction only if there is one for exactly this text. */
export type NotesView = { content: string; extraction: { extracted: unknown; key: string } | null; updatedAt: string };
/** What a write gives back: no text. */
export type NotesMeta = { length: number; hasExtraction: boolean; updatedAt: string };

type Row = typeof reportNotes.$inferSelect;
const meta = (r: Row): NotesMeta => ({ length: charCount(r.content), hasExtraction: r.extracted !== null && r.extractedKey !== null, updatedAt: r.updatedAt.toISOString() });

export type ReadNotesResult = { ok: true; notes: NotesView | null } | { ok: false; reason: "not_found" };

export async function readReportNotes(session: SessionContext, reportId: string, db?: Db): Promise<ReadNotesResult> {
  assertNotesRole(session);
  const visible = reportVisibilityFilter(session);
  if (visible === null) return { ok: false, reason: "not_found" };
  return scrubbed(() =>
    tenantDb({ organizationId: session.organizationId }, db).transaction(async (t): Promise<ReadNotesResult> => {
      const [report] = await t.find(reports, { where: and(eq(reports.id, reportId), visible), limit: 1 });
      if (!report) return { ok: false, reason: "not_found" };
      const [row] = await t.find(reportNotes, { where: eq(reportNotes.reportId, report.id), limit: 1 });
      if (!row) return { ok: true, notes: null };
      return {
        ok: true,
        notes: {
          content: row.content,
          extraction: row.extracted !== null && row.extractedKey !== null ? { extracted: row.extracted, key: row.extractedKey } : null,
          updatedAt: row.updatedAt.toISOString(),
        },
      };
    }),
  );
}

export type SaveNotesResult = { ok: true; notes: NotesMeta } | { ok: false; reason: "not_found" | "closed" | NotesTextProblem };

/**
 * Creates or replaces the report's notes. A different text clears the cached extraction (the database
 * does it); saving the same text again changes nothing and keeps the cache. A finalized report keeps no notes.
 */
export async function saveReportNotes(session: SessionContext, input: { reportId: string; content: string }, db?: Db): Promise<SaveNotesResult> {
  assertNotesRole(session);
  const problem = notesTextProblem(input.content);
  if (problem) return { ok: false, reason: problem };
  const visible = reportVisibilityFilter(session);
  if (visible === null) return { ok: false, reason: "not_found" };
  const once = (): Promise<SaveNotesResult> =>
    scrubbed(() =>
      tenantDb({ organizationId: session.organizationId }, db).transaction(async (t): Promise<SaveNotesResult> => {
        const [report] = await t.find(reports, { where: and(eq(reports.id, input.reportId), visible), limit: 1 });
        if (!report) return { ok: false, reason: "not_found" };
        if (report.status === "finalized") return { ok: false, reason: "closed" };
        const [existing] = await t.find(reportNotes, { where: eq(reportNotes.reportId, report.id), limit: 1 });
        if (existing) {
          if (existing.content === input.content) return { ok: true, notes: meta(existing) };
          const rows = await t.update(reportNotes, existing.id, { content: input.content });
          return rows[0] ? { ok: true, notes: meta(rows[0]) } : { ok: false, reason: "not_found" };
        }
        const [created] = await t.insert(reportNotes, { reportId: report.id, content: input.content, createdByUserId: session.userId });
        return { ok: true, notes: meta(created) };
      }),
    );
  const codeOf = (error: unknown) => (error instanceof ReportNotesStoreError ? error.code : undefined);
  try {
    return await once();
  } catch (error) {
    if (codeOf(error) === RESTRICT_VIOLATION) return { ok: false, reason: "closed" }; // finalized between the check and the write
    if (codeOf(error) !== UNIQUE_VIOLATION) throw error;
  }
  // Two first saves at once: the second now finds the row and replaces it.
  try {
    return await once();
  } catch (error) {
    if (codeOf(error) === RESTRICT_VIOLATION) return { ok: false, reason: "closed" };
    throw error;
  }
}

export type DeleteNotesResult = { ok: true; deleted: boolean } | { ok: false; reason: "not_found" };

/** Deletes the report's notes (and with them the cached extraction). Deleting nothing is not an error. */
export async function deleteReportNotes(session: SessionContext, reportId: string, db?: Db): Promise<DeleteNotesResult> {
  assertNotesRole(session);
  const visible = reportVisibilityFilter(session);
  if (visible === null) return { ok: false, reason: "not_found" };
  return scrubbed(() =>
    tenantDb({ organizationId: session.organizationId }, db).transaction(async (t): Promise<DeleteNotesResult> => {
      const [report] = await t.find(reports, { where: and(eq(reports.id, reportId), visible), limit: 1 });
      if (!report) return { ok: false, reason: "not_found" };
      const rows = await t.deleteDerived(reportNotes, eq(reportNotes.reportId, report.id));
      return { ok: true, deleted: rows.length > 0 };
    }),
  );
}

// JSON.stringify is shorter than Postgres's jsonb text (which adds a space after every ':' and ','), so
// the application limit is half the column's: a value that passes here can never fail the table's CHECK.
const EXTRACTED_APP_MAX_CHARS = Math.floor(REPORT_NOTES_EXTRACTED_MAX_CHARS / 2);
const KEY_PATTERN = /^[0-9a-f]{64}$/;

export type SetExtractionResult = { ok: true; notes: NotesMeta } | { ok: false; reason: "not_found" | "closed" | "stale" | "invalid" };

/**
 * Stores the extraction made from `notes`, keyed by `key` (a SHA-256 hex of notes + extract prompt
 * version + model, computed by the caller). Compare-and-set on the text: if the person changed or
 * deleted the notes while the model was working, nothing is stored and the answer is "stale", so an
 * extraction is never attached to text it was not made from.
 */
export async function setNotesExtraction(
  session: SessionContext,
  input: { reportId: string; notes: string; extracted: unknown; key: string },
  db?: Db,
): Promise<SetExtractionResult> {
  assertNotesRole(session);
  if (notesTextProblem(input.notes) || !KEY_PATTERN.test(input.key)) return { ok: false, reason: "invalid" };
  const x = input.extracted;
  if (typeof x !== "object" || x === null || Array.isArray(x)) return { ok: false, reason: "invalid" };
  let json: string;
  try {
    json = JSON.stringify(x);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (json.length > EXTRACTED_APP_MAX_CHARS || json.includes("\\u0000")) return { ok: false, reason: "invalid" };
  const visible = reportVisibilityFilter(session);
  if (visible === null) return { ok: false, reason: "not_found" };
  return scrubbed(async () => {
    try {
      return await tenantDb({ organizationId: session.organizationId }, db).transaction(async (t): Promise<SetExtractionResult> => {
        const [report] = await t.find(reports, { where: and(eq(reports.id, input.reportId), visible), limit: 1 });
        if (!report) return { ok: false, reason: "not_found" };
        if (report.status === "finalized") return { ok: false, reason: "closed" };
        const [existing] = await t.find(reportNotes, { where: eq(reportNotes.reportId, report.id), limit: 1 });
        if (!existing) return { ok: false, reason: "stale" };
        const rows = await t.update(reportNotes, existing.id, { extracted: x, extractedKey: input.key }, eq(reportNotes.content, input.notes));
        return rows[0] ? { ok: true, notes: meta(rows[0]) } : { ok: false, reason: "stale" };
      });
    } catch (error) {
      if (pgCode(error) === RESTRICT_VIOLATION) return { ok: false, reason: "closed" };
      throw error;
    }
  });
}
