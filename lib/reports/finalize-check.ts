import { unsavedTitles } from "@/lib/reports/unsaved";
import type { UnsavedEntry } from "@/lib/ui/unsaved-store";

/**
 * What the Finalize button does when it is pressed, given the sections that have changes not yet
 * saved (the unsaved store, titles and keys only). Pure, so the rule is tested without a browser.
 *
 *  - Anything unsaved: "blocked". Nothing is asked and nothing is sent; the page shows the red
 *    list and one way forward, "Go back and save". There is deliberately no "finalize anyway":
 *    finalizing closes the report, and a box with unsaved text in it would disappear with it.
 *  - Nothing unsaved: "confirm", the existing "Finalize this report?" question.
 *
 * Only a screen-side guard: the server cannot know what is typed in a box and still decides every
 * finalize itself (status check, role check, visibility).
 */

export const FINALIZE_BLOCKED_HEADING = "Save your changes before finalizing";
export const FINALIZE_BLOCKED_NEXT = "Save them, then press Finalize report again.";
export const GO_BACK_BUTTON = "Go back and save";

/** The sentence before the list. Finalizing includes only what is saved. */
export function finalizeBlockedIntro(count: number): string {
  return count === 1
    ? "Finalizing only includes saved text. This section has changes that are not saved:"
    : "Finalizing only includes saved text. These sections have changes that are not saved:";
}

export type FinalizeCheck =
  | { action: "confirm" }
  | { action: "blocked"; /** In page order, each listed even if two share a title. */ titles: string[]; /** The box to put the cursor in afterwards: the first unsaved one. */ firstKey: string };

export function checkBeforeFinalize(unsaved: readonly UnsavedEntry[]): FinalizeCheck {
  if (unsaved.length === 0) return { action: "confirm" };
  const first = [...unsaved].sort((a, b) => a.position - b.position)[0];
  return { action: "blocked", titles: unsavedTitles(unsaved), firstKey: first.key };
}
