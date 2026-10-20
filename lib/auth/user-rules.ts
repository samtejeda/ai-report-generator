import type { UserRole } from "@/lib/db/schema/users";

/**
 * Who may change whom (the approved permission matrix: owner = everything in the practice;
 * admin = manage users and practice administration, but never the owner's standing). One pure
 * function, tested as a table, so the rule is readable in one place and the data layer and the
 * routes cannot disagree about it.
 *
 *   - Only an owner or an admin manages users at all.
 *   - Nobody changes their own role or deactivates themselves (it also keeps the acting owner in
 *     place, so the practice always has an owner; migration 0011 backs that up in the database).
 *   - An admin cannot touch an owner and cannot make anyone an owner.
 *   - An owner may do anything else, including making another owner or demoting one.
 */

export type UserChange = { kind: "role"; to: UserRole } | { kind: "deactivate" } | { kind: "reactivate" };

export type UserChangeVerdict = "ok" | "not_allowed" | "self" | "admin_cannot_touch_owner" | "admin_cannot_grant_owner";

export function canManageUsers(role: UserRole): boolean {
  return role === "owner" || role === "admin";
}

export function checkUserChange(
  actor: { userId: string; role: UserRole },
  target: { id: string; role: UserRole },
  change: UserChange,
): UserChangeVerdict {
  if (!canManageUsers(actor.role)) return "not_allowed";
  if (actor.userId === target.id) return "self";
  if (actor.role === "admin") {
    if (target.role === "owner") return "admin_cannot_touch_owner";
    if (change.kind === "role" && change.to === "owner") return "admin_cannot_grant_owner";
  }
  return "ok";
}
