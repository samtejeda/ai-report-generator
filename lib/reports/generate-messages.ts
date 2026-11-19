import type { ApiFailure } from "@/lib/admin/api-call";
import { GENERATION_LEASE_SECONDS } from "@/lib/reports/generation-limits";

/**
 * Every sentence the Generate control and its page notes show. Fixed text, in the style of
 * lib/admin/messages.ts: nothing from the server's body is shown, and nothing the user typed is
 * repeated. `failure: null` is a request that never arrived; status 0 with code "timeout" is the
 * browser giving up (lib/reports/generate-call.ts).
 *
 * The wording of the three labels below that describe the text (button, note, marker) was approved
 * by Sam on 2026-10-26. They say what the text is NOT; none of them is clinical wording.
 */

export const GENERATE_BUTTON_LABEL = "Generate test text";
export const GENERATE_RUNNING_LABEL = "Generating… (up to 30 seconds)";
export const GENERATE_RUNNING_STATUS = "Asking the test model. Other sections cannot be saved until it finishes.";
export const GENERATE_NOTE = "Placeholder output from a test model. It is not a draft of this report and is not clinical content.";
export const GENERATE_NEEDS_EMPTY_BOX = "Generate fills an empty section. Clear the box first.";
export const TEST_TEXT_MARKER = "Placeholder text from a test model. Replace it; do not use it as clinical content.";

export const REPORT_GENERATING_NOTE = "A test generation is running or was interrupted. Reload in a moment.";
export const REPORT_ERROR_NOTE = "The last test generation did not finish. An empty section can be tried again.";

/** Minutes a run that died is held before the report returns to where it started (the lease). */
const LEASE_MINUTES = Math.round(GENERATION_LEASE_SECONDS / 60);

// ---------------------------------------------------------------------------------------------
// Everything below is the real-mode Generate / Regenerate experience (feat/generate-ui). Every
// sentence the person reads is in this file, so the practice owner can reword it in one place.
// Placeholders awaiting the practice owner's wording (Sam, 2026-11-19): the three REVIEW_PROMPT
// sentences and MODEL_TEXT_MARKER_REAL. None of them is clinical wording.
// ---------------------------------------------------------------------------------------------

export function generateButtonLabel(offer: "generate" | "regenerate", realMode: boolean): string {
  if (offer === "regenerate") return realMode ? "Regenerate from notes" : "Regenerate test text";
  return realMode ? "Generate from notes" : GENERATE_BUTTON_LABEL;
}

/** Under the button: what the output is. Real text is the person's to review; stub text is a placeholder. */
export function generateNote(realMode: boolean): string {
  return realMode
    ? "Written by the practice's own model from the session notes above. It is a draft for you to review and edit; you are responsible for the content."
    : GENERATE_NOTE;
}

export const REGENERATE_NOTE = "Adds a new version above the current text. The older versions stay in the history.";

export function reportGeneratingNote(realMode: boolean): string {
  return realMode
    ? `A generation is running or was interrupted. Reload in a moment. If it did not finish, the report returns to its earlier status by itself after about ${LEASE_MINUTES} minutes.`
    : REPORT_GENERATING_NOTE;
}

export function reportErrorNote(realMode: boolean): string {
  return realMode ? "The last generation did not finish. A section can be tried again." : REPORT_ERROR_NOTE;
}

/** The marker on text the model wrote and nobody has edited since. */
export const MODEL_TEXT_MARKER_REAL = "Generated from your notes. Review it before you finalize.";
export function modelTextMarker(realMode: boolean): string {
  return realMode ? MODEL_TEXT_MARKER_REAL : TEST_TEXT_MARKER;
}

// The session notes box (real mode only; one per report, shared by all sections).
export const NOTES_HEADING = "Session notes";
export const NOTES_HELP =
  "Type or paste your session notes. They go to the practice's own model when you press Generate or Regenerate on a section.";
export const NOTES_NOT_SAVED = "Not saved. Cleared when you leave or reload this page.";
export const NOTES_CLEAR_BUTTON = "Clear notes";
export const NOTES_NEEDED = "Add your session notes above first.";

// While a run is in flight.
export const GENERATE_WORKING_LABEL = "Working…";
export const GENERATE_WORKING_REAL =
  "Working. This can take a few minutes. Keep this page open. Saving and finalizing are paused until it finishes.";
export const GENERATE_WORKING_CLOSE = `If you close this page, reload it later to check. If the run did not finish, the report returns to its earlier status by itself after about ${LEASE_MINUTES} minutes.`;

export function generateWorkingStatus(realMode: boolean): string {
  return realMode ? GENERATE_WORKING_REAL : GENERATE_RUNNING_STATUS;
}

/** The result line after a run that stored text. */
export function generatedResult(realMode: boolean, version: number | null): string {
  const n = version === null ? "" : ` ${version}`;
  return realMode ? `Generated version${n}. Review it before you finalize.` : `Test text added as version${n}.`;
}

// Review prompts, from the flags that came with the report read (closed list).
export const REVIEW_PROMPT: Record<"insufficient_input" | "sensitive_content_detected" | "low_confidence_interpretation", string> = {
  insufficient_input: 'Some details were missing from the notes. Look for "[Please provide]" in this section and fill those in.',
  sensitive_content_detected: "The notes may include sensitive content. Review this section carefully.",
  low_confidence_interpretation: "Part of this section may be a weak reading of the notes. Check it against your own judgment.",
};

/** What each missing category is called in the thin-notes warning (closed list, never notes text). */
export const MISSING_LABEL: Record<"observations" | "test_scores" | "quotes" | "family_context", string> = {
  observations: "Observations",
  test_scores: "Test scores",
  quotes: "Quotes",
  family_context: "Family context",
};

// Thin notes: shown BEFORE anything is generated.
export const THIN_HEADING = "Your notes may be too thin for this section";
export const THIN_INTRO_SOME = "These details do not seem to be in your notes:";
export const THIN_INTRO_NONE = "The notes do not seem to give enough to write this section.";
export const THIN_NEXT =
  'If you go ahead, the section will contain "[Please provide]" where the notes do not support it. Nothing is invented. You can go back and add to the notes instead.';
export const THIN_ADD_NOTES_BUTTON = "Add more notes";
export const THIN_GO_AHEAD_BUTTON = "Go ahead anyway";

// A person's own edit is about to be replaced.
export const REPLACE_HEADING = "Replace your own text?";
export const REPLACE_BODY =
  "The current text of this section was written or edited by a person. Going ahead replaces it with a new version written by the model. Your text stays in the version history.";
export const REPLACE_KEEP_BUTTON = "Keep my text";
export const REPLACE_GO_BUTTON = "Replace with a new version";

// Unsaved text somewhere on the page (same red list as Finalize and Download).
export const GENERATE_UNSAVED_HEADING = "Some text is not saved";
export const GENERATE_UNSAVED_NEXT = "Saving is paused while the model works, so these cannot be saved until it finishes. They stay in their boxes.";
export const GENERATE_GO_ANYWAY_BUTTON = "Generate anyway";
export const GENERATE_BLOCKED_HEADING = "Save your changes first";
export const GENERATE_BLOCKED_NEXT = "A new version would sit above text that is not saved yet. Save it, then press the button again.";

export function generateUnsavedIntro(count: number): string {
  return count === 1 ? "This section has changes that are not saved:" : "These sections have changes that are not saved:";
}

/** Longest wait ever quoted back, so an odd Retry-After cannot produce an absurd sentence. */
const MAX_QUOTED_SECONDS = 3600;

function waitPhrase(retryAfterSeconds: number | null): string {
  if (retryAfterSeconds === null) return "Wait a minute and try again.";
  const seconds = Math.min(retryAfterSeconds, MAX_QUOTED_SECONDS);
  if (seconds < 60) return `Try again in about ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
  const minutes = Math.ceil(seconds / 60);
  return `Try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

export function generateErrorMessage(failure: ApiFailure | null, retryAfterSeconds: number | null = null, realMode = false): string {
  const notesKept = realMode ? " Your notes are still here." : "";
  if (failure === null) return `Could not reach the server.${notesKept} Try again.`;
  if (failure.status === 0 && failure.code === "timeout") return "This is taking longer than expected. Reload the page to see whether it finished.";
  switch (failure.status) {
    case 401:
      return "Your session ended. Sign in again.";
    case 403:
      return "You do not have access to do this.";
    case 404:
      return "This section could not be found. Reload the page.";
    case 409:
      return failure.code === "inference_not_configured"
        ? `Text generation is not set up for this practice yet. Nothing was sent.${notesKept}`
        : "This section or report changed while you were working, or another generation is running. The page was refreshed. Check it and try again.";
    case 429:
      return `Too many generations right now. ${waitPhrase(retryAfterSeconds)}`;
    case 502:
    case 504:
      return `The ${realMode ? "model" : "test model"} did not answer. Nothing was saved.${notesKept} Try again.`;
    case 400:
      return "The request was not accepted. Reload the page and try again.";
    default:
      return "Something went wrong. Try again.";
  }
}

/**
 * After which failures the server's state (the report's status line) may have moved on without the
 * page knowing: the run could have started, been lost, or finished after the browser gave up.
 * The page then re-reads itself. A refusal before anything started (401, 403, 404, 429, a 409 for
 * "not set up") changes nothing, so nothing is re-read.
 */
export function failureMayHaveChangedState(failure: ApiFailure | null): boolean {
  if (failure === null) return false;
  if (failure.status === 0) return true;
  if (failure.status === 409) return failure.code !== "inference_not_configured";
  return failure.status >= 500;
}
