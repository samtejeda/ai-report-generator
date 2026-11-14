import type { REPORT_STATUSES } from "@/lib/db/schema/reports";

/**
 * Report status transitions, in one place. The database enforces the same table with a trigger
 * (`reports_enforce_status`, migration 0013, replaced by 0017); lib/reports/status.test.ts keeps
 * the two equal.
 *
 *   draft -> generating <-> generated -> finalized
 *                |  ^
 *                v  |
 *               error
 *
 * `generated -> generating` (0017) lets a generated report generate again: another empty section,
 * or a regenerated one. `reports.status_before_generation` records where a generation started
 * from (set and cleared by the trigger), so a later change can send a failed regenerate back to
 * `generated` (`generating -> generated` already exists) rather than to `error`.
 *
 * Only `generated -> finalized` is performed by a user-facing route in the report shell. The
 * others belong to generation.
 * A finalized report never changes status again; amending one is a policy question nobody has
 * answered (PROGRESS.md), so there is deliberately no way back.
 */
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_TRANSITIONS: readonly (readonly [ReportStatus, ReportStatus])[] = [
  ["draft", "generating"],
  ["generating", "generated"],
  ["generating", "error"],
  ["error", "generating"],
  ["generated", "generating"],
  ["generated", "finalized"],
];

export function canTransition(from: ReportStatus, to: ReportStatus): boolean {
  return REPORT_TRANSITIONS.some(([a, b]) => a === from && b === to);
}

/**
 * Statuses in which a person may edit section text. Not `generating` (generation is writing) and
 * not `finalized` (the record is closed).
 */
export const EDITABLE_STATUSES: readonly ReportStatus[] = ["draft", "generated", "error"];

export function isEditable(status: ReportStatus): boolean {
  return EDITABLE_STATUSES.includes(status);
}
