import { asc, eq } from "drizzle-orm";
import { checkUserChange, type UserChangeVerdict } from "@/lib/auth/user-rules";
import type { SessionContext } from "@/lib/auth/session";
import { clampPage } from "./client-access";
import { users, type UserRole } from "./schema/users";
import { tenantDb } from "./tenant";

/**
 * User administration inside one practice (owner and admin). Layer 4 of the authorization
 * chain: every statement goes through tenantDb, so another practice's user is simply absent
 * (the route answers the same 404 as for an id that does not exist). The who-may-change-whom rule
 * is lib/auth/user-rules.ts. Every change is a compare-and-set on the role the rule was checked
 * against, so a check made a moment earlier cannot be raced by a concurrent change.
 */

type Db = Parameters<typeof tenantDb>[1];
type UserRow = typeof users.$inferSelect;

/** The only user fields that leave the server. No organization id, no credential, no deletion date. */
export type UserView = {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  mfaEnabled: boolean;
  createdAt: string;
};

export function toUserView(row: UserRow): UserView {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    active: row.deletedAt === null,
    mfaEnabled: row.twoFactorEnabled,
    createdAt: row.createdAt.toISOString(),
  };
}

export type UserChangeResult =
  | { ok: true; changed: boolean; user: UserView; previousRole?: UserRole }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: Exclude<UserChangeVerdict, "ok"> }
  | { ok: false; reason: "inactive" | "last_owner" | "conflict" };

const RESTRICT_VIOLATION = "23001";
function pgCode(error: unknown): string | undefined {
  let cur: unknown = error;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const rec = cur as { code?: unknown; cause?: unknown };
    if (typeof rec.code === "string" && /^[0-9A-Z]{5}$/.test(rec.code)) return rec.code;
    cur = rec.cause;
  }
  return undefined;
}

export async function listUsers(session: SessionContext, page: { limit?: number; offset?: number } = {}, db?: Db): Promise<UserView[]> {
  const { limit, offset } = clampPage(page);
  const rows = await tenantDb({ organizationId: session.organizationId }, db).find(users, {
    orderBy: [asc(users.createdAt), asc(users.id)],
    limit,
    offset,
    includeDeleted: true,
  });
  return rows.map(toUserView);
}

async function load(session: SessionContext, id: string, db?: Db) {
  const t = tenantDb({ organizationId: session.organizationId }, db);
  return { t, target: await t.get(users, id, true) };
}

export async function changeUserRole(session: SessionContext, id: string, role: UserRole, db?: Db): Promise<UserChangeResult> {
  const { t, target } = await load(session, id, db);
  if (!target) return { ok: false, reason: "not_found" };
  const verdict = checkUserChange(session, target, { kind: "role", to: role });
  if (verdict !== "ok") return { ok: false, reason: verdict };
  if (target.deletedAt) return { ok: false, reason: "inactive" };
  if (target.role === role) return { ok: true, changed: false, user: toUserView(target) };
  try {
    const [row] = await t.update(users, id, { role }, eq(users.role, target.role));
    if (!row) return { ok: false, reason: "conflict" };
    return { ok: true, changed: true, user: toUserView(row), previousRole: target.role };
  } catch (error) {
    if (pgCode(error) === RESTRICT_VIOLATION) return { ok: false, reason: "last_owner" };
    throw error;
  }
}

export async function setUserActive(session: SessionContext, id: string, active: boolean, db?: Db): Promise<UserChangeResult> {
  const { t, target } = await load(session, id, db);
  if (!target) return { ok: false, reason: "not_found" };
  const verdict = checkUserChange(session, target, { kind: active ? "reactivate" : "deactivate" });
  if (verdict !== "ok") return { ok: false, reason: verdict };
  const isActive = target.deletedAt === null;
  if (isActive === active) return { ok: true, changed: false, user: toUserView(target) };
  try {
    const guard = eq(users.role, target.role);
    const [row] = active ? await t.restore(users, id, guard) : await t.update(users, id, { deletedAt: new Date() }, guard);
    if (!row) return { ok: false, reason: "conflict" };
    return { ok: true, changed: true, user: toUserView(row) };
  } catch (error) {
    if (pgCode(error) === RESTRICT_VIOLATION) return { ok: false, reason: "last_owner" };
    throw error;
  }
}
