import type { AuditActor, AuditEvent } from "@/lib/audit";
import { jsonError } from "@/lib/api/respond";
import type { UserRole } from "@/lib/db/schema/users";
import { FRESH_PASSWORD_SECONDS } from "./config";
import type { SessionContext } from "./session";

/**
 * The route-handler gate (CLAUDE.md "Authorization chain", layer 3). Every route handler we
 * write is wrapped in this, so identity, role and origin are re-checked by the handler itself
 * and never rest on the proxy or a layout.
 *
 * Order, each step failing closed:
 *   1. state-changing methods must come from our own origin (CSRF)        -> 403
 *   2. there must be a session (password AND second factor, see session.ts) -> 401
 *   3. the caller's role, read from the database just now, must be allowed -> 403 (audited)
 *   4. a `fresh` route also needs a recent sign-in (checked after the role, so a role that may
 *      not call the route never learns about the requirement)                -> 403 (audited)
 *   5. the handler runs; anything it throws becomes a fixed 500, no details -> 500
 *
 * Kept free of Next.js imports and with injected dependencies so it is unit-tested directly.
 * `guard.ts` wires it to the real session lookup.
 */

export type GuardDeps = {
  resolve: (request: Request) => Promise<SessionContext | null>;
  /** The app's own origin, e.g. "https://app.example.com" (no path). */
  allowedOrigin: () => string;
  audit: (actor: AuditActor, event: AuditEvent) => Promise<boolean>;
  /** How recent a sign-in must be for a `fresh` route. Defaults to FRESH_PASSWORD_SECONDS. */
  freshSeconds?: number;
  /** The clock; injectable for tests. Only read on `fresh` routes, after the session lookup. */
  now?: () => Date;
};

export type GuardedHandlerArgs<P> = { request: Request; session: SessionContext; params: P };

export type GuardedRouteOptions<P> = {
  /** Who may call this. A role not listed gets 403, and the denial is audited. */
  roles: readonly UserRole[];
  /** What the route is about, as a table-style word ("client"); used only for the audit row. */
  resource: string;
  /**
   * Sensitive action: the caller must have signed in within the last FRESH_PASSWORD_SECONDS
   * (lib/auth/config.ts). Otherwise 403 `reauth_required` and they sign in again, code step
   * included. There is no password prompt on the route, so a stolen session has no way to
   * guess the password through it.
   */
  fresh?: boolean;
  handler: (args: GuardedHandlerArgs<P>) => Promise<Response>;
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createGuard(deps: GuardDeps) {
  return function guardedRoute<P = Record<string, never>>(options: GuardedRouteOptions<P>) {
    if (options.roles.length === 0) throw new Error("guardedRoute needs at least one allowed role");

    return async function handle(request: Request, routeContext?: { params?: Promise<P> }): Promise<Response> {
      try {
        if (!SAFE_METHODS.has(request.method.toUpperCase()) && request.headers.get("origin") !== deps.allowedOrigin()) {
          return jsonError("forbidden_origin");
        }

        const session = await deps.resolve(request);
        if (!session) return jsonError("unauthenticated");

        if (!options.roles.includes(session.role)) {
          await deps.audit(
            { organizationId: session.organizationId, actorUserId: session.userId },
            {
              action: "authz.denied",
              resourceType: options.resource,
              outcome: "denied",
              metadata: { role: session.role, reason: "role_not_allowed" },
            },
          );
          return jsonError("forbidden");
        }

        if (options.fresh) {
          // After the session read on purpose: the clock must not be read before request-time I/O.
          const age = ((deps.now ?? (() => new Date()))().getTime() - session.signedInAt.getTime()) / 1000;
          if (!(age >= 0 && age <= (deps.freshSeconds ?? FRESH_PASSWORD_SECONDS))) {
            await deps.audit(
              { organizationId: session.organizationId, actorUserId: session.userId },
              {
                action: "authz.denied",
                resourceType: options.resource,
                outcome: "denied",
                metadata: { role: session.role, reason: "sign_in_not_recent" },
              },
            );
            return jsonError("reauth_required");
          }
        }

        const params = (routeContext?.params ? await routeContext.params : {}) as P;
        return await options.handler({ request, session, params });
      } catch (error) {
        // Next.js controls prerendering, redirects and not-found by throwing errors that carry a
        // `digest`. Those are signals, not failures: swallowing one would hide that this route
        // reads the request (so it must stay dynamic). A plain Error never has a digest.
        if (typeof (error as { digest?: unknown } | null)?.digest === "string") throw error;
        // Fixed message to the caller; the log carries the route's resource and nothing from the
        // error text or the request, which could hold client data.
        console.error(JSON.stringify({ event: "route_error", resource: options.resource, kind: error instanceof Error ? error.name : "unknown" }));
        return jsonError("internal_error");
      }
    };
  };
}
