import type { GenerateAnswer, GenerateBody, MissingCategory, ReviewFlag } from "@/lib/reports/generate-call";
import { failureMayHaveChangedState, generateErrorMessage } from "@/lib/reports/generate-messages";
import { unsavedTitles } from "@/lib/reports/unsaved";
import type { UnsavedEntry } from "@/lib/ui/unsaved-store";

/**
 * The rules of one Generate / Regenerate press, kept out of the components so they are tested
 * without a browser. Pure: nothing here reads or writes the notes anywhere, and nothing here is a
 * gate (the route re-checks everything).
 *
 * One press is one `Run`. A run starts with NO confirmations. The two confirmations are separate
 * questions that only the person's own click can answer, and neither one stands for the other
 * (API.md: `confirm` is thin notes, `replaceEdited` is a person's own text):
 *   - `withReplaceConfirmed` after "Replace with a new version";
 *   - `withThinConfirmed` after "Go ahead anyway".
 * A run is never reused for the next press, so a confirmation is never sticky.
 */

export type Run = { replaceEdited: boolean; confirm: boolean };

export const newRun = (): Run => ({ replaceEdited: false, confirm: false });
export const withReplaceConfirmed = (run: Run): Run => ({ ...run, replaceEdited: true });
export const withThinConfirmed = (run: Run): Run => ({ ...run, confirm: true });

/**
 * The request body. Stub mode sends the two version fields only (its body is strict and refuses
 * notes). Real mode adds the notes, and `confirm: true` only when the run holds the person's
 * confirmation. Absent means false; the page never sends `false` or `true` by default.
 */
export function buildGenerateBody(input: { realMode: boolean; notes: string; baseVersion: number; run: Run }): GenerateBody {
  const body: GenerateBody = { baseVersion: input.baseVersion };
  if (input.run.replaceEdited) body.replaceEdited = true;
  if (input.realMode) {
    body.notes = input.notes;
    if (input.run.confirm) body.confirm = true;
  }
  return body;
}

/** Real mode needs notes the route will accept (1 to 20,000 characters, not blank). Stub needs none. */
export function notesReady(realMode: boolean, notes: string): boolean {
  return !realMode || notes.trim().length > 0;
}

export type Precheck =
  | { action: "go" }
  /** Unsaved text in the section about to be regenerated: one way forward, "Go back and save". */
  | { action: "blocked"; titles: string[]; firstKey: string }
  /** Unsaved text elsewhere: go back and save (default), or go ahead; it stays in its box. */
  | { action: "warn"; titles: string[]; firstKey: string };

/** Looks at the unsaved store (titles and keys only) before anything is sent. */
export function checkBeforeGenerate(unsaved: readonly UnsavedEntry[], targetKey: string): Precheck {
  if (unsaved.length === 0) return { action: "go" };
  const sorted = [...unsaved].sort((a, b) => a.position - b.position);
  const titles = unsavedTitles(unsaved);
  if (unsaved.some((e) => e.key === targetKey)) return { action: "blocked", titles, firstKey: targetKey };
  return { action: "warn", titles, firstKey: sorted[0].key };
}

/** What the page does after the server's answer to one call. */
export type Step =
  | { step: "done"; version: number | null; flags: ReviewFlag[] }
  | { step: "ask_replace" }
  | { step: "ask_thin"; missing: MissingCategory[]; sensitive: boolean }
  | { step: "error"; message: string; /** Re-read the page (the run may have started, ended or been refused as stale). */ refresh: boolean };

export function nextStep(answer: GenerateAnswer, realMode: boolean): Step {
  switch (answer.kind) {
    case "generated":
      return { step: "done", version: answer.version, flags: answer.flags };
    case "edited_text":
      return { step: "ask_replace" };
    case "thin_notes":
      return { step: "ask_thin", missing: answer.missing, sensitive: answer.sensitive };
    case "failed":
      return { step: "error", message: generateErrorMessage(answer.failure, answer.retryAfterSeconds, realMode), refresh: failureMayHaveChangedState(answer.failure) };
  }
}
