// REMOVABLE (Sam, 2026-10-30, PROGRESS.md decisions row 15): everything in this file exists only so
// that two people editing the same section at once do not overwrite each other. Sam expects that
// to be rare and may delete it. To remove it, delete this file and its test,
// components/reports/use-section-conflict.ts, components/reports/section-conflict-notice.tsx, and
// the three blocks marked REMOVABLE in components/reports/section-editor.tsx; a refused save
// (409) would then show SAVE_FAILED. Nothing is lost by removing it: the server still refuses a
// save made from an old version (lib/db/report-write.ts), so nothing is ever overwritten.
//
// What it does: after the save route answers 409 ("somebody saved first" OR "the report is closed
// or generating"; the route does not say which), read the section again (GET /api/reports/{id}, the
// existing read, audited as report.viewed) and decide which it was.

import { isId } from "@/lib/reports/save-section-call";
import { isEditable, type ReportStatus } from "@/lib/reports/status";

const READ_WAIT_MS = 15_000;

/** One section as the report read returns it: display name only, never an id or an email. */
export type CurrentSection = {
  version: number;
  text: string;
  editType: string | null;
  authorName: string | null;
  editedAt: string | null;
};

export type CurrentRead =
  | { ok: true; status: string; section: CurrentSection | null }
  | { ok: false };

function asCurrentSection(value: unknown): CurrentSection | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== "number" || !Number.isInteger(v.version) || typeof v.text !== "string") return null;
  return {
    version: v.version,
    text: v.text,
    editType: typeof v.editType === "string" ? v.editType : null,
    authorName: typeof v.authorName === "string" ? v.authorName : null,
    editedAt: typeof v.editedAt === "string" ? v.editedAt : null,
  };
}

export async function readCurrentSection(reportId: string, sectionId: string): Promise<CurrentRead> {
  if (!isId(reportId) || !isId(sectionId)) return { ok: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_WAIT_MS);
  try {
    const res = await fetch(`/api/reports/${reportId}`, { signal: controller.signal });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { data?: { status?: unknown; sections?: unknown } };
    const status = body.data?.status;
    const sections = body.data?.sections;
    if (typeof status !== "string" || !Array.isArray(sections)) return { ok: false };
    const found = sections.find((s) => typeof s === "object" && s !== null && (s as { id?: unknown }).id === sectionId);
    return { ok: true, status, section: found === undefined ? null : asCurrentSection(found) };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

export type RefusalOutcome =
  /** The report cannot take edits now (finalized, or a generation is running). */
  | { kind: "closed" }
  /** A newer version exists: show it beside the person's text. */
  | { kind: "newer"; theirs: CurrentSection }
  /** Nothing newer was found: a one-off failure, try again. */
  | { kind: "unchanged" }
  /** The section is not in the report any more. */
  | { kind: "gone" }
  /** The newer text could not be read. */
  | { kind: "unreadable" };

/** What a 409 meant, given the fresh read and the version the person's text was based on. */
export function decideAfterRefusal(read: CurrentRead, baseVersion: number): RefusalOutcome {
  if (!read.ok) return { kind: "unreadable" };
  if (read.section === null) return { kind: "gone" };
  if (!isEditable(read.status as ReportStatus)) return { kind: "closed" };
  if (read.section.version > baseVersion) return { kind: "newer", theirs: read.section };
  return { kind: "unchanged" };
}


// ---- sentences (fixed text; nothing from the server's body is shown) ----
export const SAVE_UNCHANGED = "This could not be saved just now, and nobody else has changed the section. Your text is still in the box. Try again.";
export const SAVE_CLOSED = "This report can no longer be changed (it was finalized, or a test generation is running). Your text is still in the box; copy it if you need it.";
export const SAVE_GONE = "This section is no longer part of the report. Your text is still in the box; copy it if you need it.";
export const SAVE_UNREADABLE = "Someone else saved this section, but their text could not be loaded. Your text is still in the box. Press Save to try again.";
export const CONFLICT_HEADING = "Someone saved this section after you opened it.";
export const CONFLICT_EXPLAIN = "Nothing has been overwritten. Choose what happens to your text.";
export const CONFLICT_AGAIN = "It changed again while you were deciding. This is the newest text now.";
export const CONFLICT_MINE_LABEL = "Your text (not saved)";
export const CONFLICT_THEIRS_LABEL = "The saved text";
export const KEEP_MINE_BUTTON = "Keep mine as the next version";
export const TAKE_THEIRS_BUTTON = "Take theirs and discard mine";
export const CANCEL_BUTTON = "Cancel";
export const TOOK_THEIRS_NOTE = "Showing the saved text. Your earlier text was discarded.";
export const CANCELLED_NOTE = "Not saved. Your text is still in the box; saving it will ask again.";
