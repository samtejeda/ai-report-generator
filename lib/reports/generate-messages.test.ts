import { describe, expect, it } from "vitest";
import {
  failureMayHaveChangedState,
  generateErrorMessage,
  GENERATE_BUTTON_LABEL,
  GENERATE_NOTE,
  REPORT_ERROR_NOTE,
  REPORT_GENERATING_NOTE,
  generatedResult,
  generateButtonLabel,
  generateNote,
  generateWorkingStatus,
  MISSING_LABEL,
  modelTextMarker,
  REVIEW_PROMPT,
  TEST_TEXT_MARKER,
  reportErrorNote,
  reportGeneratingNote,
} from "./generate-messages";
import { GENERATION_LEASE_SECONDS } from "./generation-limits";

const STATUSES = [0, 400, 401, 403, 404, 409, 429, 500, 502, 504];

describe("generateErrorMessage", () => {
  it("a request that never arrived", () => {
    expect(generateErrorMessage(null)).toMatch(/Could not reach the server/);
  });

  it("the browser giving up says to reload and see, not to try again", () => {
    expect(generateErrorMessage({ status: 0, code: "timeout" })).toMatch(/Reload the page to see whether it finished/);
  });

  it("each documented answer has its own sentence", () => {
    expect(generateErrorMessage({ status: 401, code: "unauthenticated" })).toMatch(/session ended/);
    expect(generateErrorMessage({ status: 403, code: "forbidden" })).toMatch(/do not have access/);
    expect(generateErrorMessage({ status: 404, code: "not_found" })).toMatch(/could not be found/);
    expect(generateErrorMessage({ status: 409, code: "inference_not_configured" })).toMatch(/not set up for this practice yet\. Nothing was sent/);
    expect(generateErrorMessage({ status: 409, code: "conflict" })).toMatch(/changed while you were working.*page was refreshed/);
    expect(generateErrorMessage({ status: 502, code: "inference_failed" })).toMatch(/did not answer.*Nothing was saved/);
    expect(generateErrorMessage({ status: 504, code: "inference_failed" })).toMatch(/did not answer.*Nothing was saved/);
    expect(generateErrorMessage({ status: 500, code: "internal_error" })).toMatch(/Something went wrong/);
  });

  it("the two 409s are told apart by code, and an unknown 409 code falls back to the conflict sentence", () => {
    expect(generateErrorMessage({ status: 409, code: null })).toBe(generateErrorMessage({ status: 409, code: "conflict" }));
    expect(generateErrorMessage({ status: 409, code: "inference_not_configured" })).not.toBe(generateErrorMessage({ status: 409, code: "conflict" }));
  });

  it("429 quotes Retry-After as seconds, then minutes, clamped, and copes with none", () => {
    const m = (s: number | null) => generateErrorMessage({ status: 429, code: "rate_limited" }, s);
    expect(m(1)).toMatch(/about 1 second\./);
    expect(m(30)).toMatch(/about 30 seconds\./);
    expect(m(59)).toMatch(/about 59 seconds\./);
    expect(m(60)).toMatch(/about 1 minute\./);
    expect(m(61)).toMatch(/about 2 minutes\./);
    expect(m(600)).toMatch(/about 10 minutes\./);
    expect(m(10_000_000)).toMatch(/about 60 minutes\./);
    expect(m(null)).toMatch(/Wait a minute/);
  });

  it("every status, with and without a code, gets a fixed sentence with no server text or placeholders in it", () => {
    for (const status of STATUSES)
      for (const code of [null, "x", "inference_failed", "conflict"]) {
        const text = generateErrorMessage({ status, code }, 5);
        expect(text.length).toBeGreaterThan(10);
        expect(text).not.toMatch(/undefined|null|NaN|\[object/);
        // A code the server might send is never echoed.
        if (code === "x") expect(text).not.toContain("x ");
      }
  });
});

describe("failureMayHaveChangedState", () => {
  it("is true where the run could have started, been lost or finished unseen", () => {
    expect(failureMayHaveChangedState({ status: 0, code: "timeout" })).toBe(true);
    expect(failureMayHaveChangedState({ status: 409, code: "conflict" })).toBe(true);
    expect(failureMayHaveChangedState({ status: 502, code: "inference_failed" })).toBe(true);
    expect(failureMayHaveChangedState({ status: 504, code: "inference_failed" })).toBe(true);
    expect(failureMayHaveChangedState({ status: 500, code: "internal_error" })).toBe(true);
  });

  it("is false where nothing was started", () => {
    expect(failureMayHaveChangedState(null)).toBe(false);
    for (const status of [400, 401, 403, 404, 429]) expect(failureMayHaveChangedState({ status, code: "x" })).toBe(false);
    expect(failureMayHaveChangedState({ status: 409, code: "inference_not_configured" })).toBe(false);
  });
});

describe("the labels", () => {
  it("say it is a test model's placeholder, not clinical content", () => {
    expect(GENERATE_BUTTON_LABEL).toMatch(/test text/);
    expect(GENERATE_NOTE).toMatch(/test model/);
    expect(GENERATE_NOTE).toMatch(/not clinical content/);
    expect(TEST_TEXT_MARKER).toMatch(/test model/);
    expect(TEST_TEXT_MARKER).toMatch(/not use it as clinical content/);
  });

  it("the report-level notes tell a reader to reload, and name no cause beyond the generation", () => {
    expect(REPORT_GENERATING_NOTE).toMatch(/Reload/);
    expect(REPORT_ERROR_NOTE).toMatch(/did not finish/);
  });
});

describe("real mode wording", () => {
  it("stub keeps today's wording; real mode says generate from notes", () => {
    expect(generateButtonLabel("generate", false)).toBe(GENERATE_BUTTON_LABEL);
    expect(generateButtonLabel("generate", true)).toBe("Generate from notes");
    expect(generateButtonLabel("regenerate", true)).toMatch(/Regenerate/);
    expect(generateButtonLabel("regenerate", false)).toMatch(/Regenerate test text/);
    expect(generateNote(false)).toBe(GENERATE_NOTE);
    expect(modelTextMarker(false)).toBe(TEST_TEXT_MARKER);
    expect(modelTextMarker(true)).not.toMatch(/test model/);
    expect(reportGeneratingNote(false)).toBe(REPORT_GENERATING_NOTE);
    expect(reportErrorNote(false)).toBe(REPORT_ERROR_NOTE);
  });

  it("the working message is honest about minutes, has no percentage, and the generating note names the lease", () => {
    expect(generateWorkingStatus(true)).toMatch(/few minutes/);
    expect(generateWorkingStatus(true)).not.toMatch(/\d+\s*%/);
    expect(reportGeneratingNote(true)).toContain(`${Math.round(GENERATION_LEASE_SECONDS / 60)} minutes`);
  });

  it("not-configured never sends the person to the inference-endpoint screen (in real mode the missing piece may be the methodology)", () => {
    for (const real of [false, true]) expect(generateErrorMessage({ status: 409, code: "inference_not_configured" }, null, real)).not.toMatch(/Inference endpoint/i);
  });

  it("real mode tells the person their notes are still there after a failed call; stub does not mention notes", () => {
    for (const failure of [null, { status: 502, code: "inference_failed" }, { status: 504, code: "inference_failed" }, { status: 409, code: "inference_not_configured" }])
      expect(generateErrorMessage(failure, null, true)).toMatch(/notes are still here/);
    expect(generateErrorMessage({ status: 502, code: "inference_failed" })).not.toMatch(/notes/);
  });

  it("the result line names the version", () => {
    expect(generatedResult(true, 3)).toMatch(/version 3/);
    expect(generatedResult(false, 1)).toMatch(/version 1/);
    expect(generatedResult(true, null)).not.toMatch(/null|undefined/);
  });

  it("every flag and every missing category has a sentence, and none repeats a raw name", () => {
    expect(Object.keys(REVIEW_PROMPT).sort()).toEqual(["insufficient_input", "low_confidence_interpretation", "sensitive_content_detected"]);
    expect(Object.keys(MISSING_LABEL).sort()).toEqual(["family_context", "observations", "quotes", "test_scores"]);
    for (const text of [...Object.values(REVIEW_PROMPT), ...Object.values(MISSING_LABEL)]) expect(text).not.toMatch(/_/);
  });

  it('the insufficient-input note does not promise a "[Please provide]" marker (the model does not always write one)', async () => {
    const { PLEASE_PROVIDE } = await import("@/lib/ai/pipeline/schemas");
    expect(REVIEW_PROMPT.insufficient_input).not.toContain(PLEASE_PROVIDE);
  });
});
