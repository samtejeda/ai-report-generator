/**
 * The numbers behind section generation (audit 09 items 1 and 8). Plain constants so they can be
 * changed in one reviewed place; none of them is policy text. Sam, 2026-10-21: taken as proposed.
 *
 * Time: the route's `maxDuration` is 60 s, the model call gives up after 30 s, and a report that
 * has said `generating` for longer than the lease is treated as abandoned (the function that
 * started it was killed) and may be reclaimed. The lease must stay longer than `maxDuration`.
 */
export const GENERATION_CALL_TIMEOUT_MS = 30_000;
export const GENERATION_ROUTE_MAX_SECONDS = 60;
export const GENERATION_LEASE_SECONDS = 120;

/** Live `generating` reports one practice may have at once, so one tenant cannot queue up its own box. */
export const MAX_CONCURRENT_GENERATIONS = 2;

/** Generation starts allowed inside the window, per person and per practice. */
export const RATE_WINDOW_SECONDS = 600;
export const MAX_STARTS_PER_USER = 10;
export const MAX_STARTS_PER_ORGANIZATION = 30;

/** What to tell a caller who was refused only because other generations are running. */
export const BUSY_RETRY_SECONDS = 30;
