import type { ApiFailure } from "@/lib/admin/api-call";

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

/** Longest wait ever quoted back, so an odd Retry-After cannot produce an absurd sentence. */
const MAX_QUOTED_SECONDS = 3600;

function waitPhrase(retryAfterSeconds: number | null): string {
  if (retryAfterSeconds === null) return "Wait a minute and try again.";
  const seconds = Math.min(retryAfterSeconds, MAX_QUOTED_SECONDS);
  if (seconds < 60) return `Try again in about ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
  const minutes = Math.ceil(seconds / 60);
  return `Try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

export function generateErrorMessage(failure: ApiFailure | null, retryAfterSeconds: number | null = null): string {
  if (failure === null) return "Could not reach the server. Try again.";
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
        ? "Text generation is not set up for this practice. The practice owner sets it under Practice, Inference endpoint."
        : "This section or report changed, or a run is in progress. Reload the page.";
    case 429:
      return `Too many generations right now. ${waitPhrase(retryAfterSeconds)}`;
    case 502:
    case 504:
      return "The test model did not answer. Nothing was saved. Try again.";
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
