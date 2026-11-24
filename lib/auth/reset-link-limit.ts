import { jsonError } from "@/lib/api/respond";
import { addressBucket } from "./address-bucket";
import { clientIp } from "./auth";
import { RESET_LINK_PATTERN } from "./route-policy";

/**
 * The 5-per-15-minutes limit on `GET /api/auth/reset-password/{token}` (the emailed link), counted per
 * client address and NOTHING else.
 *
 * Why it is ours and not Better Auth's: Better Auth keys its limiter on address plus request path, and
 * here the token is IN the path, so each guessed token got a counter of its own and varying the token
 * never hit the limit (finding F5, docs/POSTMAN-PASS.md, 2026-11-24). This check runs in the catch-all
 * route before the request is handed to Better Auth, on the same `auth_rate_limits` counter the
 * invitation checks use. It reads nothing from the token and never stores or logs it; the answer for a
 * bad token, the redirect and the error code are Better Auth's and are not touched.
 *
 * The refusal copies Better Auth's own 429 (status, body and `X-Retry-After`), so the reset page and
 * every client that reads it see no difference.
 */

/** The counter key's path part: a fixed label, never the path that was asked for. */
export const RESET_LINK_LIMIT_PATH = "/reset-password/{token}";

export type ResetLinkLimitDeps = {
  /** Counts one request under `key` and says whether it may go on (consumeAddressLimit with RATE_LIMITS.resetLink). */
  limit: (key: string) => Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>;
};

/** `path` is the part after /api/auth, without the query string (the same value route-policy.ts checks). */
export function isResetLinkRequest(method: string, path: string): boolean {
  return method === "GET" && RESET_LINK_PATTERN.test(path);
}

/** The counter key for a request: the address bucket and the fixed label, so every token from one address shares it. */
export function resetLinkLimitKey(headers: Headers): string {
  return `${addressBucket(clientIp(headers))}|${RESET_LINK_LIMIT_PATH}`;
}

/** Better Auth's own rate-limit answer, byte for byte in status, body and header (api/rate-limiter in better-auth). */
function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ message: "Too many requests. Please try again later." }), {
    status: 429,
    statusText: "Too Many Requests",
    headers: { "Content-Type": "application/json", "X-Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  });
}

export function createResetLinkLimit(deps: ResetLinkLimitDeps) {
  /** A 429 when this address is over the limit, a fixed 500 when the counter cannot be read (fails closed), otherwise null. */
  return async function limitResetLink(request: Request, path: string): Promise<Response | null> {
    if (!isResetLinkRequest(request.method, path)) return null;
    try {
      const counted = await deps.limit(resetLinkLimitKey(request.headers));
      return counted.allowed ? null : tooManyRequests(counted.retryAfterSeconds);
    } catch (error) {
      // Same shape as the route guard's: the route and the kind of error, nothing from the request.
      console.error(JSON.stringify({ event: "route_error", resource: "auth_reset_link_limit", kind: error instanceof Error ? error.name : "unknown" }));
      return jsonError("internal_error");
    }
  };
}
