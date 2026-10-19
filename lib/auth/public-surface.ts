/**
 * Every page and endpoint that is reachable WITHOUT a session, with the reason. This is the one
 * list the proxy (proxy.ts) lets through and the static scan (lib/auth/guard-coverage.test.ts)
 * accepts as "no guard needed". Anything not here needs a session, and every page and route
 * handler must still check for itself: the proxy only turns away requests that carry no session
 * cookie at all, and is never the gate (CLAUDE.md "Authorization chain").
 *
 * Adding an entry is a security decision: say why it can be public, and add it to API.md.
 */

export const PUBLIC_PAGES: readonly { path: string; reason: string }[] = [
  { path: "/", reason: "Static placeholder home page; shows no tenant data." },
  { path: "/login", reason: "The sign-in form; it creates the session." },
  { path: "/forgot-password", reason: "Requests a reset link; same answer whether or not the address has an account." },
  { path: "/reset-password", reason: "The emailed single-use token is the credential." },
];

export const PUBLIC_API: readonly { path: string; prefix: boolean; reason: string }[] = [
  { path: "/api/health", prefix: false, reason: "Liveness and database reachability for monitors; no tenant data." },
  { path: "/api/auth", prefix: true, reason: "Sign-in, reset and verification create identity, so they cannot require one. Narrowed to an allow-list in lib/auth/route-policy.ts; each endpoint does its own checks." },
];

function normalize(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

/** Exact match for pages (so /loginx and /login/x are not public); segment-aware prefix for the auth API. */
export function isPublicPath(pathname: string): boolean {
  const path = normalize(pathname);
  if (PUBLIC_PAGES.some((p) => p.path === path)) return true;
  return PUBLIC_API.some((a) => (a.prefix ? path === a.path || path.startsWith(a.path + "/") : path === a.path));
}
