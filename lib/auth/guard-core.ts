import type { AuditActor, AuditEvent } from "@/lib/audit";
import { jsonError } from "@/lib/api/respond";
import type { UserRole } from "@/lib/db/schema/users";
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
 *   4. the handler runs; anything it throws becomes a fixed 500, no details -> 500
 *
 * Kept free of Next.js imports and with injected dependencies so it is unit-tested directly.
 * `guard.ts` wires it to the real session lookup.
 */

export type GuardDeps = {
  resolve: (request: Request) => Promise<SessionContext | null>;
  /** The app's own origin, e.g. "https://app.example.com" (no path). */
  allowedOrigin: () => string;
  audit: (actor: AuditActor, event: AuditEvent) => Promise<boolean>;
};

export type GuardedHandlerArgs<P> = { request: Request; session: SessionContext; params: P };

export type GuardedRouteOptions<P> = {
  /** Who may call this. A role not listed gets 403, and the denial is audited. */
  roles: readonly UserRole[];
  /** What the route is about, as a table-style word ("client"); used only for the audit row. */
  resource: string;
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

        const params = (routeContext?.params ? await routeContext.params : {}) as P;
        return await options.handler({ request, session, params });
      } catch (error) {
        // Fixed message to the caller; the log carries the route's resource and nothing from the
        // error text or the request, which could hold client data.
        console.error(JSON.stringify({ event: "route_error", resource: options.resource, kind: error instanceof Error ? error.name : "unknown" }));
        return jsonError("internal_error");
      }
    };
  };
}
