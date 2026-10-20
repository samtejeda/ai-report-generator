import { jsonError, jsonOk } from "@/lib/api/respond";
import { audit } from "@/lib/audit";
import type { SessionContext } from "@/lib/auth/session";
import type { UserChangeResult } from "@/lib/db/user-admin";

/**
 * One place that turns the result of a user change into the HTTP answer and the audit row, so the
 * user routes cannot drift apart:
 *   not found (or another practice's user) 404 · a refused rule 403, audited · a state that does
 *   not allow it 409 · a change 200, audited with ids and role names only · a no-op 200, not audited.
 */
export async function respondToUserChange(
  session: SessionContext,
  targetId: string,
  result: UserChangeResult,
  action: "user.role_changed" | "user.deactivated" | "user.reactivated" | null,
): Promise<Response> {
  const actor = { organizationId: session.organizationId, actorUserId: session.userId };
  if (result.ok) {
    // `null`: the change wrote its own audit row inside the same database transaction.
    if (result.changed && action) {
      await audit(actor, {
        action,
        resourceType: "user",
        resourceId: targetId,
        metadata: { role: result.user.role, ...(result.previousRole ? { previous_role: result.previousRole } : {}) },
      });
    }
    return jsonOk({ data: result.user });
  }
  switch (result.reason) {
    case "not_found":
      return jsonError("not_found");
    case "inactive":
    case "last_owner":
    case "conflict":
      return jsonError("conflict");
    default: {
      // A rule refused it. The reason is a fixed word, never anything from the request.
      await audit(actor, {
        action: "authz.denied",
        resourceType: "user",
        resourceId: targetId,
        outcome: "denied",
        metadata: { role: session.role, reason: result.reason === "self" ? "self_change" : result.reason },
      });
      return jsonError("forbidden");
    }
  }
}
