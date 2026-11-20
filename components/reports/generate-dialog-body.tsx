import { UnsavedList } from "@/components/unsaved/unsaved-list";
import type { Question } from "@/lib/reports/generate-flow";
import { GENERATE_BLOCKED_NEXT, GENERATE_UNSAVED_NEXT, generateUnsavedIntro, MISSING_LABEL, REPLACE_BODY, REVIEW_PROMPT, THIN_INTRO_NONE, THIN_INTRO_SOME, THIN_NEXT } from "@/lib/reports/generate-messages";

// The words inside the Generate dialog, per question (lib/reports/generate-flow.ts). Titles and
// closed category names only: no notes and no section text ever reach it.
export function GenerateDialogBody({ dialog }: { dialog: Question }) {
  switch (dialog.kind) {
    case "thin":
      return (
        <>
          <p>{dialog.missing.length > 0 ? THIN_INTRO_SOME : THIN_INTRO_NONE}</p>
          {dialog.missing.length > 0 ? (
            <ul className="list-inside list-disc">
              {dialog.missing.map((m) => (
                <li key={m}>{MISSING_LABEL[m]}</li>
              ))}
            </ul>
          ) : null}
          {dialog.sensitive ? <p>{REVIEW_PROMPT.sensitive_content_detected}</p> : null}
          <p>{THIN_NEXT}</p>
        </>
      );
    case "replace":
      return <p>{REPLACE_BODY}</p>;
    case "warn":
      return (
        <>
          <UnsavedList intro={generateUnsavedIntro(dialog.titles.length)} titles={dialog.titles} />
          <p>{GENERATE_UNSAVED_NEXT}</p>
        </>
      );
    case "blocked":
      return (
        <>
          <UnsavedList intro={generateUnsavedIntro(dialog.titles.length)} titles={dialog.titles} />
          <p>{GENERATE_BLOCKED_NEXT}</p>
        </>
      );
  }
}
