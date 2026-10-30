/**
 * The one number behind the "someone changed this section" check's limit (GET /api/reports/{id}/state).
 * A person's open editor asks about once a minute; this is a coarse ceiling against a loop or abuse,
 * far above any real use. Counted per person in a fixed database minute (tenantDb.countRead), so up
 * to twice this can pass across a minute boundary; that is accepted for a coarse limit.
 * API.md quotes the number; lib/reports/state.test.ts keeps the two equal.
 */
export const STATE_READS_PER_MINUTE = 120;
