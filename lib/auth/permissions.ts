import type { UserRole } from "@/lib/db/schema/users";

/**
 * The approved permission matrix (PROGRESS.md "Auth decisions"), as code, in one place.
 *
 *   owner      everything in the practice, including every client
 *   associate  assigned clients and reports only
 *   admin      users and practice administration; NO clinical content unless granted. A grant
 *              is the same thing as an associate's assignment (Sam, 2026-10-20: per-client): the
 *              owner assigns the admin to specific clients through client_assignments, and the
 *              admin then sees exactly those clients and no others. With no grant an admin sees
 *              an empty list and a 404 for every id, exactly like an associate with no clients.
 *
 * Roles are read from the database on every request, never from the cookie.
 */

/**
 * Roles that may call the clinical routes (clients, reports) at all. Anything else is refused.
 * Calling is not seeing: what each role sees is decided inside the query (lib/db/client-access.ts),
 * so an admin without a grant gets nothing back from a route it is allowed to call.
 */
export const CLINICAL_ROLES = ["owner", "associate", "admin"] as const satisfies readonly UserRole[];

export function canReachClinicalContent(role: UserRole): boolean {
  return (CLINICAL_ROLES as readonly string[]).includes(role);
}

/** Owner sees every client in the practice; an associate or an admin only the assigned ones. */
export function seesEveryClient(role: UserRole): boolean {
  return role === "owner";
}

/**
 * Who may create and edit a client record (Sam, 2026-10-21, plan "client CRUD + report shell").
 * An admin never writes clinical records, not even for a client the owner granted them: a grant
 * is read access. An associate edits only clients assigned to them (the query enforces that).
 */
export const CLIENT_WRITE_ROLES = ["owner", "associate"] as const satisfies readonly UserRole[];

/** Soft-deleting a client hides it and every report under it from everyone: owner only. */
export const CLIENT_DELETE_ROLES = ["owner"] as const satisfies readonly UserRole[];

export function canWriteClients(role: UserRole): boolean {
  return (CLIENT_WRITE_ROLES as readonly string[]).includes(role);
}

 * Who may create, edit and finalize a report (plan "client CRUD + report shell", Sam 2026-10-21).
 * Same people as client writes: an admin with a client grant READS that client's reports and
 * never writes them. An associate writes only reports of clients assigned to them (the query).
 */
export const REPORT_WRITE_ROLES = ["owner", "associate"] as const satisfies readonly UserRole[];
