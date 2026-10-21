import type { REPORT_STATUSES } from "@/lib/db/schema/reports";

/**
 * Report status transitions, in one place. The database enforces the same table with a trigger
 * (migration 0013, `reports_enforce_status`); lib/reports/status.test.ts keeps the two equal.
 *
 *   draft -> generating -> generated -> finalized
 *                |  ^
 *                v  |
 *               error
 *
 * Only `generated -> finalized` is performed by a user-facing route in the report shell. The
 * others belong to generation (the inference PR) and have no route yet.
 * A finalized report never changes status again; amending one is a policy question nobody has
 * answered (PROGRESS.md), so there is deliberately no way back.
 */
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_TRANSITIONS: readonly (readonly [ReportStatus, ReportStatus])[] = [
  ["draft", "generating"],
  ["generating", "generated"],
  ["generating", "error"],
  ["error", "generating"],
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
