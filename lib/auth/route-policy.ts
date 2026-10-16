/**
 * The only Better Auth endpoints reachable over HTTP. Better Auth ships many more (session
 * listing, user update, account linking, ...); none is needed, so none is exposed: this list is
 * the allow-list, and everything else answers 404 before Better Auth sees the request. Adding an
 * entry means adding it to API.md and to the tests in the same change.
 */
export const AUTH_ENDPOINTS: readonly { method: "GET" | "POST"; pattern: RegExp; label: string }[] = [
  { method: "POST", pattern: /^\/sign-in\/email$/, label: "/sign-in/email" },
  { method: "POST", pattern: /^\/sign-out$/, label: "/sign-out" },
  { method: "POST", pattern: /^\/request-password-reset$/, label: "/request-password-reset" },
  { method: "GET", pattern: /^\/reset-password\/[A-Za-z0-9_-]{1,128}$/, label: "/reset-password/{token}" },
  { method: "POST", pattern: /^\/reset-password$/, label: "/reset-password" },
  { method: "POST", pattern: /^\/send-verification-email$/, label: "/send-verification-email" },
  { method: "GET", pattern: /^\/verify-email$/, label: "/verify-email" },
  { method: "POST", pattern: /^\/change-password$/, label: "/change-password" },
];

/** `path` is the part after /api/auth, without the query string. */
export function isAllowedAuthRequest(method: string, path: string): boolean {
  return AUTH_ENDPOINTS.some((e) => e.method === method && e.pattern.test(path));
}
