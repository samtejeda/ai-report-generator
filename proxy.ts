import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/api/respond";
import { COOKIE_PREFIX } from "@/lib/auth/config";
import { isPublicPath } from "@/lib/auth/public-surface";

/**
 * Layer 1 of the authorization chain: a convenience, never the gate. It turns away a request
 * that carries no session cookie at all (a page gets a real 307 to /login, an API call gets 401)
 * so signed-out visitors do not render protected pages. It does NOT know whether the cookie is
 * valid, expired, or belongs to a role that may be here: every page, server action and route
 * handler re-checks the session, role and organization itself (requireSession, requireRole,
 * guardedRoute). If this file were deleted, nothing would become reachable.
 *
 * Public paths are the single list in lib/auth/public-surface.ts.
 */

const SESSION_COOKIES = [`${COOKIE_PREFIX}.session_token`, `__Secure-${COOKIE_PREFIX}.session_token`];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  if (SESSION_COOKIES.some((name) => request.cookies.has(name))) return NextResponse.next();
  if (pathname === "/api" || pathname.startsWith("/api/")) return jsonError("unauthenticated");
  // No ?next= parameter: a redirect target taken from the request is an open-redirect risk.
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  // Everything except Next's hashed static assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
