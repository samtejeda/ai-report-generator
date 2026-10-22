/**
 * Response helpers for our own route handlers (API.md "Conventions").
 *
 * Errors are `{ "error": { "code", "message" } }` with a fixed message per code: nothing from an
 * exception, a query, or the request is ever echoed back.
 */

const MESSAGES = {
  validation_failed: "The request is not valid.",
  unauthenticated: "Sign in to continue.",
  forbidden: "You do not have access to this.",
  forbidden_origin: "This request came from an unexpected origin.",
  reauth_required: "Sign in again to do this.",
  not_found: "Not found.",
  conflict: "This conflicts with the current state. Reload and try again.",
  rate_limited: "Too many requests. Try again shortly.",
  inference_not_configured: "Text generation is not set up for this practice.",
  inference_failed: "Text generation did not work. Try again.",
  internal_error: "Something went wrong.",
} as const;

export type ApiErrorCode = keyof typeof MESSAGES;

const STATUS: Record<ApiErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  forbidden_origin: 403,
  reauth_required: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  inference_not_configured: 409,
  inference_failed: 502,
  internal_error: 500,
};

export type ErrorOptions = {
  /** Replaces the code's usual status (a timeout is 504 under the same `inference_failed` code). */
  status?: number;
  /** Seconds, sent as `Retry-After` (rate limits). */
  retryAfterSeconds?: number;
};

export function jsonError(code: ApiErrorCode, options: ErrorOptions = {}): Response {
  const headers = new Headers(noStore());
  if (options.retryAfterSeconds !== undefined) headers.set("Retry-After", String(Math.max(1, Math.ceil(options.retryAfterSeconds))));
  return Response.json({ error: { code, message: MESSAGES[code] } }, { status: options.status ?? STATUS[code], headers });
}

export function jsonOk(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: noStore() });
}

// Tenant data must never sit in a shared cache (next.config.ts sets the same for every dynamic
// path; stated here too so a handler is safe on its own).
function noStore(): HeadersInit {
  return { "Cache-Control": "private, no-store" };
}
