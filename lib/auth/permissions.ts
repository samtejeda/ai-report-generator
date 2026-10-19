import type { UserRole } from "@/lib/db/schema/users";

/**
 * The approved permission matrix (PROGRESS.md "Auth decisions"), as code, in one place.
 *
 *   owner      everything in the practice, including every client
 *   associate  assigned clients and reports only
 *   admin      users and practice administration; NO clinical content (client or report data)
 *              until a grant mechanism exists (designed with the admin screens), so for now
 *              an admin is refused on every clinical route and the data functions return nothing
 *
 * Roles are read from the database on every request, never from the cookie.
 */

/** Roles that may reach clinical content at all (clients, reports). Anything else is refused. */
export const CLINICAL_ROLES = ["owner", "associate"] as const satisfies readonly UserRole[];

export function canReachClinicalContent(role: UserRole): boolean {
  return (CLINICAL_ROLES as readonly string[]).includes(role);
}

/** Owner sees every client in the practice; an associate only the assigned ones. */
export function seesEveryClient(role: UserRole): boolean {
  return role === "owner";
}
