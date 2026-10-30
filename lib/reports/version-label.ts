/**
 * Who wrote a version, in words, for the section history and the line under each section. Never the
 * raw edit type (`human_edit`, `ai_generated`) and never an id or an email: the server sends a
 * display name or null (lib/db/report-access.ts), and this turns that into a fixed sentence.
 *
 * The date is added by the caller (components/reports/local-time.tsx) so it shows in the viewer's
 * own time zone.
 */

export const MODEL_TEXT_LABEL = "Test model text";
export const AUTHOR_UNKNOWN_LABEL = "Edited by (name not available)";
export const OTHER_EDIT_LABEL = "Saved";

export function versionAttribution(v: { editType: string | null; authorName: string | null }): string {
  switch (v.editType) {
    case "human_edit": {
      const name = v.authorName?.trim();
      return name ? `Edited by ${name}` : AUTHOR_UNKNOWN_LABEL;
    }
    // The only model today is the dev stub, so both kinds of model text read the same.
    case "ai_generated":
    case "ai_regenerated_section":
      return MODEL_TEXT_LABEL;
    default:
      return OTHER_EDIT_LABEL;
  }
}
