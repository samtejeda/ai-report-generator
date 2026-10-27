import type { ReportStatus } from "@/lib/reports/status";

/**
 * Which sections of a report page get the "Generate test text" control. This is a convenience for
 * the screen, never a gate: the route (`POST /api/reports/{id}/sections/{sectionId}/generate`)
 * re-checks the role, the report's visibility, its status and that the section is empty, and
 * answers 403 or 409 to anything else. The rule here mirrors the server's on purpose (an empty
 * prose section, a draft or error report, owner or associate) so the control is shown exactly
 * when a request can succeed.
 */

export type GenerateControlInput = {
  /** Owner or associate (REPORT_WRITE_ROLES). An admin reads only. */
  canWrite: boolean;
  status: ReportStatus;
  type: "prose" | "structured";
  /** The section's current version number; 0 means it has no text yet. */
  version: number;
};

export function canOfferGenerate({ canWrite, status, type, version }: GenerateControlInput): boolean {
  return canWrite && (status === "draft" || status === "error") && type === "prose" && version === 0;
}

/** True when the section's current text is what the test model wrote and nobody has edited it since. */
export function isTestModelText(editType: string | null): boolean {
  return editType === "ai_generated";
}
