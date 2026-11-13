/**
 * The numbers behind section generation (audit 09 items 1 and 8). Plain constants so they can be
 * changed in one reviewed place; none of them is policy text. Sam, 2026-10-21: taken as proposed;
 * the real-mode times were raised on 2026-11-13 (plan approved 2026-11-09, decision 2).
 *
 * Time, stub mode: one fixed prompt to a tiny model, so the call gives up after 30 s and the whole
 * request is expected to end within 60 s.
 *
 * Time, real mode: up to six calls (three passes, each with one retry) on an 8b model. On laptop-class
 * hardware ONE pass can take longer than the stub's whole limit (estimate, not yet measured on the
 * Phase B machine), so real mode has its own named numbers: each call gives up after 120 s, the whole
 * run after 270 s, and the route's `maxDuration` is 300 s. Measure on the Phase B machine, then decide
 * whether this still fits or the work moves to a job (not built; Sam, 2026-11-09).
 *
 * Lease: a report that has said `generating` for longer than the lease is treated as abandoned (the
 * function that started it was killed) and may be reclaimed. It must stay longer than `maxDuration`,
 * so it was raised with it (120 s to 360 s); a dead run of either mode now holds its report that long.
 */
export const GENERATION_CALL_TIMEOUT_MS = 30_000;
/** What the stub request is expected to finish within (the browser waits this long, plus a margin). */
export const GENERATION_STUB_ROUTE_SECONDS = 60;
export const REAL_CALL_TIMEOUT_MS = 120_000;
export const REAL_BUDGET_MS = 270_000;
/** The route's `maxDuration` (a literal in the route file, kept equal by a test). */
export const GENERATION_ROUTE_MAX_SECONDS = 300;
export const GENERATION_LEASE_SECONDS = 360;

/** Live `generating` reports one practice may have at once, so one tenant cannot queue up its own box. */
export const MAX_CONCURRENT_GENERATIONS = 2;

/** Generation starts allowed inside the window, per person and per practice. */
export const RATE_WINDOW_SECONDS = 600;
export const MAX_STARTS_PER_USER = 10;
export const MAX_STARTS_PER_ORGANIZATION = 30;

/** What to tell a caller who was refused only because other generations are running. */
export const BUSY_RETRY_SECONDS = 30;

/**
 * The most characters of session notes a request may carry (the pipeline's own limit, restated here so
 * the route does not reach into lib/ai; a test keeps the two equal). Long notes degrade a small model.
 */
export const MAX_NOTES_CHARS = 20_000;
