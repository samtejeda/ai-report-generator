import { notFound } from "next/navigation";
import { audit } from "@/lib/audit";
import { getAuthDb } from "@/lib/db/auth-db";
import { getAuthEnv } from "@/lib/env";
import type { UserRole } from "@/lib/db/schema/users";
import { createGuard } from "./guard-core";
import { getAuth, requireSession } from "./server";
import { resolveSession, type SessionContext } from "./session";

/**
 * Route handlers: wrap the handler, name the roles, and the gate does the rest (see
 * guard-core.ts for the order of checks). The static scan that makes a route without a guard fail
 * CI is a later chunk of this PR.
 */
export const guardedRoute = createGuard({
  resolve: (request) => resolveSession(request.headers, { auth: getAuth(), authDb: getAuthDb() }),
  allowedOrigin: () => new URL(getAuthEnv().BETTER_AUTH_URL).origin,
  audit: (actor, event) => audit(actor, event),
});

/**
 * Pages, layouts and server actions: the session (sign-in or MFA redirect handled by
 * requireSession) plus a role check. A role that may not be here gets the ordinary 404 page, not
 * a "forbidden" page that confirms the screen exists, and the denial is audited.
 * Every page calls this itself; a layout check is never the only gate.
 */
export async function requireRole(...roles: UserRole[]): Promise<SessionContext> {
  if (roles.length === 0) throw new Error("requireRole needs at least one allowed role");
  const session = await requireSession();
  if (!roles.includes(session.role)) {
    await audit(
      { organizationId: session.organizationId, actorUserId: session.userId },
      { action: "authz.denied", resourceType: "page", outcome: "denied", metadata: { role: session.role, reason: "role_not_allowed" } },
    );
    notFound();
  }
  return session;
}
