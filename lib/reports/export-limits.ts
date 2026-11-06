/**
 * Limits on exporting a report (GET /api/reports/{id}/export). An export puts the whole report
 * into a file that leaves the system, so it is limited per person. Counted from the person's own
 * `report.exported` audit rows inside the export transaction (lib/db/report-export.ts), so there
 * is no separate counter table. API.md quotes these numbers; lib/reports/export-docx.test.ts keeps
 * the two equal.
 */
export const EXPORT_WINDOW_SECONDS = 600;
export const MAX_EXPORTS_PER_USER = 20;
