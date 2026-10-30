// REMOVABLE (Sam, PROGRESS.md decision 15): the only limit constant for the "someone changed this
// section" check (GET /api/reports/{id}/state). Delete it with that route and lib/db/report-state.ts;
// lib/reports/state.test.ts reads it and goes too. If the counter table is kept for another limited
// read, give that read its own constant and key instead of reusing this one.

/**
 * The one number behind the "someone changed this section" check's limit (GET /api/reports/{id}/state).
 * A person's open editor asks about once a minute; this is a coarse ceiling against a loop or abuse,
 * far above any real use. Counted per person in a fixed database minute (tenantDb.countRead), so up
 * to twice this can pass across a minute boundary; that is accepted for a coarse limit.
 * API.md quotes the number; lib/reports/state.test.ts keeps the two equal.
 */
export const STATE_READS_PER_MINUTE = 120;
