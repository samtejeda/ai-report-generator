import type { ReportStatus } from "@/lib/reports/status";

/**
 * Which sections of a report page get the Generate or Regenerate control. This is a convenience for
 * the screen, never a gate: the route (`POST /api/reports/{id}/sections/{sectionId}/generate`)
 * re-checks the role, the report's visibility, its status and the section's version, and
 * answers 403 or 409 to anything else. The rule here mirrors the server's on purpose so the control
 * is shown exactly when a request can succeed.
 */

export type GenerateControlInput = {
  /** Owner or associate (REPORT_WRITE_ROLES). An admin reads only. */
  canWrite: boolean;
  status: ReportStatus;
  type: "prose" | "structured";
  /** The section's current version number; 0 means it has no text yet. */
  version: number;
};

/** "generate": a first generation of an empty section. "regenerate": a new version above existing text. */
export type GenerateOffer = "generate" | "regenerate" | null;

/**
 * One rule for both modes (stub and real; Sam, 2026-11-19), the same one the route enforces:
 *  - an empty prose section on a draft, error or generated report: generate;
 *  - a prose section with text, on a generated report only: regenerate (text on a draft or error
 *    report is never replaced, the route answers 409);
 *  - nothing while the report is generating or finalized, and nothing for a person who cannot write.
 */
export function generateOffer({ canWrite, status, type, version }: GenerateControlInput): GenerateOffer {
  if (!canWrite || type !== "prose") return null;
  if (version === 0) return status === "draft" || status === "error" || status === "generated" ? "generate" : null;
  return status === "generated" ? "regenerate" : null;
}

/** True when the section's current text is model text that nobody has edited since (generated or regenerated). */
export function isModelText(editType: string | null): boolean {
  return editType === "ai_generated" || editType === "ai_regenerated_section";
}
