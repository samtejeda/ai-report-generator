import type { UnsavedEntry } from "@/lib/ui/unsaved-store";

/**
 * The words and small rules of the unsaved-changes feature, kept out of the components so they can
 * be tested. Fixed text; a section's own text is never repeated in any of it (only its title).
 * None of this is clinical wording.
 */

export const UNSAVED_LABEL = "Unsaved changes";
export const LEAVE_DIALOG_HEADING = "You have unsaved changes";
export const LEAVE_DIALOG_WARNING = "If you leave now, these changes may be lost.";
export const STAY_BUTTON = "Stay and save";
export const LEAVE_BUTTON = "Leave without saving";

/** The id of a section's text box, the target of the summary's links. */
export const sectionBoxId = (sectionId: string): string => `section-box-${sectionId}`;

/** The one-line heading of the red summary at the top of the report page. */
export function summaryHeading(count: number): string {
  return count === 1 ? "You have unsaved changes in 1 section:" : `You have unsaved changes in ${count} sections:`;
}

/** The sentence at the top of the leave dialog, before the list of sections. */
export function leaveDialogIntro(count: number): string {
  return count === 1 ? "This section has changes that are not saved:" : "These sections have changes that are not saved:";
}

/** The titles to list, in page order, each once (two sections may share a title; both are listed). */
export function unsavedTitles(entries: readonly UnsavedEntry[]): string[] {
  return [...entries].sort((a, b) => a.position - b.position).map((e) => e.title);
}
