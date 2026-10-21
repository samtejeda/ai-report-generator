import { buildAuditRow } from "@/lib/audit";
import { CLIENT_DELETE_ROLES, CLIENT_WRITE_ROLES } from "@/lib/auth/permissions";
import type { SessionContext } from "@/lib/auth/session";
import type { ClientCreateInput, ClientPatchInput } from "@/lib/clients/input";
import { toClientView, visibilityFilter, type ClientView } from "./client-access";
import { auditLog, clientAssignments, clients } from "./schema";
import { tenantDb, type TenantQuery } from "./tenant";

/**
 * Creating, editing and soft-deleting clients (plan "client CRUD + report shell", approved by Sam
 * 2026-10-21).
 *
 *   create   owner or associate. An associate is assigned to the new client in the same
 *            transaction, so they can never own a client they cannot see. The assignment is a
 *            self-assignment (`assigned_by` is the associate); the owner can end it with the
 *            existing endpoint.
 *   edit     owner (any client in the practice) or associate (assigned clients only). The
 *            visibility rule is ANDed into the UPDATE itself, so "not yours" and "not found" are the
 *            same empty result and there is no gap between checking and writing.
 *   delete   owner only; soft delete. The audit row is written in the same transaction, so a
 *            delete cannot happen without being recorded (CLAUDE.md "deletes — TBD", recommended
 *            by the plan). Hard deletion stays purge_client(), which no route calls.
 *
 * Everything goes through tenantDb, so the organization comes from the session and row-level
 * security backs it. The role checks here are defense in depth: the route already names its roles.
 */

type Db = Parameters<typeof tenantDb>[1];
type Patch = Partial<Omit<typeof clients.$inferInsert, "id" | "organizationId" | "createdAt">>;

const UNIQUE_VIOLATION = "23505";
function pgCode(error: unknown): string | undefined {
  let cur: unknown = error;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const rec = cur as { code?: unknown; cause?: unknown };
    if (typeof rec.code === "string" && /^[0-9A-Z]{5}$/.test(rec.code)) return rec.code;
    cur = rec.cause;
  }
  return undefined;
}

function assertRole(session: SessionContext, allowed: readonly string[], what: string) {
  if (!allowed.includes(session.role)) throw new Error(`${what} is not allowed for this role`);
}

export type CreateClientResult =
  | { ok: true; client: ClientView; assignmentId: string | null }
  | { ok: false; reason: "external_id_taken" };

export async function createClient(session: SessionContext, input: ClientCreateInput, db?: Db): Promise<CreateClientResult> {
  assertRole(session, CLIENT_WRITE_ROLES, "creating a client");
  const t = tenantDb({ organizationId: session.organizationId }, db);
  try {
    return await t.transaction(async (tx) => {
      const [row] = await tx.insert(clients, {
        displayName: input.displayName,
        dateOfBirth: input.dateOfBirth,
        gradeLevel: input.gradeLevel,
        externalId: input.externalId,
      });
      let assignmentId: string | null = null;
      if (session.role === "associate") {
        const [assignment] = await tx.insert(clientAssignments, { clientId: row.id, userId: session.userId, assignedByUserId: session.userId });
        assignmentId = assignment.id;
      }
      return { ok: true as const, client: toClientView(row), assignmentId };
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) return { ok: false, reason: "external_id_taken" };
    throw error;
  }
}

/** The UPDATE for this caller (exported so a test can look at the SQL without a database). */
export function updateClientQuery(session: SessionContext, id: string, patch: ClientPatchInput, db?: Db): TenantQuery<(typeof clients.$inferSelect)[]> | null {
  assertRole(session, CLIENT_WRITE_ROLES, "editing a client");
  const filter = visibilityFilter(session);
  if (filter === null) return null;
  return tenantDb({ organizationId: session.organizationId }, db).update(clients, id, patch as Patch, filter);
}

export type UpdateClientResult = { ok: true; client: ClientView } | { ok: false; reason: "not_found" | "external_id_taken" };

export async function updateClient(session: SessionContext, id: string, patch: ClientPatchInput, db?: Db): Promise<UpdateClientResult> {
  const query = updateClientQuery(session, id, patch, db);
  if (!query) return { ok: false, reason: "not_found" };
  try {
    const rows = await query;
    return rows[0] ? { ok: true, client: toClientView(rows[0]) } : { ok: false, reason: "not_found" };
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) return { ok: false, reason: "external_id_taken" };
    throw error;
  }
}

export async function softDeleteClient(session: SessionContext, id: string, db?: Db): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
  assertRole(session, CLIENT_DELETE_ROLES, "deleting a client");
  const t = tenantDb({ organizationId: session.organizationId }, db);
  return t.transaction(async (tx) => {
    const rows = await tx.softDelete(clients, id);
    if (!rows[0]) return { ok: false as const, reason: "not_found" as const };
    // Same transaction: if this insert fails, the delete is rolled back with it.
    await tx.insert(auditLog, {
      ...buildAuditRow({ action: "client.deleted", resourceType: "client", resourceId: id, metadata: { role: session.role } }),
      actorUserId: session.userId,
      requestId: null,
    });
    return { ok: true as const };
  });
}
