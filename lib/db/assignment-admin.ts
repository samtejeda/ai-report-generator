import { and, desc, eq, type SQL } from "drizzle-orm";
import type { SessionContext } from "@/lib/auth/session";
import { clampPage } from "./client-access";
import { clientAssignments, clients } from "./schema";
import { users, type UserRole } from "./schema/users";
import { tenantDb } from "./tenant";

/**
 * Who may see which client: creating and ending assignments. OWNER ONLY (Sam, 2026-10-20): choosing
 * a client means seeing a client's name, and a grant is what lets an associate or an admin see
 * anything at all. The assignment is the same row for both roles; the visibility rule that reads it
 * is lib/db/client-access.ts.
 *
 * Everything goes through tenantDb, and the composite foreign keys on client_assignments keep a
 * row inside one practice even if this code were wrong, so a client or person from another
 * practice is simply "not found" and can never be linked.
 */

type Db = Parameters<typeof tenantDb>[1];
type Row = typeof clientAssignments.$inferSelect;

/** Ids only. No client name, no person name: the screens look those up with their own access. */
export type AssignmentView = { id: string; clientId: string; userId: string; assignedByUserId: string; createdAt: string };

const toView = (row: Row): AssignmentView => ({
  id: row.id,
  clientId: row.clientId,
  userId: row.userId,
  assignedByUserId: row.assignedByUserId,
  createdAt: row.createdAt.toISOString(),
});

export type CreateAssignmentResult =
  | { ok: true; assignment: AssignmentView; assigneeRole: UserRole }
  | { ok: false; reason: "client_not_found" | "user_not_found" | "owner_needs_no_assignment" | "already_assigned" };

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

// Defense in depth: the route already allows the owner only. A caller that reaches this with any
// other role is a bug, and fails loudly (the route turns it into a fixed 500) instead of acting.
function assertOwner(session: SessionContext) {
  if (session.role !== "owner") throw new Error("assignments are managed by the owner only");
}

export async function listAssignments(
  session: SessionContext,
  filter: { clientId?: string; userId?: string; limit?: number; offset?: number } = {},
  db?: Db,
): Promise<AssignmentView[]> {
  assertOwner(session);
  const { limit, offset } = clampPage(filter);
  const where: SQL[] = [];
  if (filter.clientId) where.push(eq(clientAssignments.clientId, filter.clientId));
  if (filter.userId) where.push(eq(clientAssignments.userId, filter.userId));
  const rows = await tenantDb({ organizationId: session.organizationId }, db).find(clientAssignments, {
    where: where.length ? and(...where) : undefined,
    orderBy: [desc(clientAssignments.createdAt), desc(clientAssignments.id)],
    limit,
    offset,
  });
  return rows.map(toView);
}

export async function createAssignment(
  session: SessionContext,
  input: { clientId: string; userId: string },
  db?: Db,
): Promise<CreateAssignmentResult> {
  assertOwner(session);
  const t = tenantDb({ organizationId: session.organizationId }, db);
  const client = await t.get(clients, input.clientId);
  if (!client) return { ok: false, reason: "client_not_found" };
  const person = await t.get(users, input.userId);
  if (!person) return { ok: false, reason: "user_not_found" };
  // An owner already sees every client; a row for one would only suggest otherwise.
  if (person.role === "owner") return { ok: false, reason: "owner_needs_no_assignment" };
  try {
    const [row] = await t.insert(clientAssignments, { clientId: client.id, userId: person.id, assignedByUserId: session.userId });
    return { ok: true, assignment: toView(row), assigneeRole: person.role };
  } catch (error) {
    // The unique index allows one active assignment per client and person.
    if (pgCode(error) === UNIQUE_VIOLATION) return { ok: false, reason: "already_assigned" };
    throw error;
  }
}

/** Ends one assignment (soft delete). Not found covers another practice's id and one already ended. */
export async function endAssignment(session: SessionContext, id: string, db?: Db): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
  assertOwner(session);
  const rows = await tenantDb({ organizationId: session.organizationId }, db).softDelete(clientAssignments, id);
  return rows.length ? { ok: true } : { ok: false, reason: "not_found" };
}
