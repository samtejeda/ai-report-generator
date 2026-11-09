import { REPORT_WRITE_ROLES } from "@/lib/auth/permissions";
import { unsavedTitles } from "@/lib/reports/unsaved";
import type { UnsavedEntry } from "@/lib/ui/unsaved-store";

/**
 * The "Download Word file" button's rules and words, kept out of the component so they are tested
 * without a browser. The download itself is a plain link to the export route
 * (GET /api/reports/{id}/export?format=docx): the browser saves the file, nothing is fetched into
 * JavaScript and nothing is stored client-side. The route is the real gate (role, visibility,
 * a limit of 20 per person per 10 minutes); everything here is only what to SHOW.
 *
 * The file holds only SAVED text. With anything unsaved the page asks first (checkBeforeDownload),
 * but unlike Finalize going ahead is allowed: the file is a copy and the report stays open.
 */

export const DOWNLOAD_BUTTON = "Download Word file";
export const GO_BACK_BUTTON = "Go back and save";
export const DOWNLOAD_ANYWAY_BUTTON = "Download anyway";
export const DOWNLOAD_UNSAVED_HEADING = "Some text is not saved";
export const DOWNLOAD_UNSAVED_NEXT = "The unsaved text will not be in the file. Save it first to include it.";

/** Shown under the button on every report (the page never sees the answer to a link, so no wait time). */
export const DOWNLOAD_LIMIT_HINT = "If nothing downloads, you may have reached the limit of 20 downloads in 10 minutes. Wait a few minutes and try again.";

/** Same people as the route: owner and associate. An admin never sees the button (the route refuses an admin anyway). */
export function canOfferExport(role: string): boolean {
  return (REPORT_WRITE_ROLES as readonly string[]).includes(role);
}

/** The route's address for one report. The id comes from the server (a uuid); the format is the only option today. */
export function exportUrl(reportId: string): string {
  return `/api/reports/${encodeURIComponent(reportId)}/export?format=docx`;
}

/** Said near the button while the report is not finalized (the file's first line says so too). Null once finalized. */
export function draftNote(status: string): string | null {
  return status === "finalized" ? null : 'This report is not finalized, so the file starts with a line that says "DRAFT, not finalized".';
}

/** The sentence before the list. The file includes saved text only. */
export function downloadUnsavedIntro(count: number): string {
  return count === 1
    ? "The file only includes saved text. This section has changes that are not saved:"
    : "The file only includes saved text. These sections have changes that are not saved:";
}

export type DownloadCheck =
  | { action: "download" }
  | { action: "warn"; /** In page order, each listed even if two share a title. */ titles: string[]; /** The box to put the cursor in on "Go back and save": the first unsaved one. */ firstKey: string };

export function checkBeforeDownload(unsaved: readonly UnsavedEntry[]): DownloadCheck {
  if (unsaved.length === 0) return { action: "download" };
  const first = [...unsaved].sort((a, b) => a.position - b.position)[0];
  return { action: "warn", titles: unsavedTitles(unsaved), firstKey: first.key };
}
