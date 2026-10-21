import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { canReachClinicalContent, seesEveryClient } from "@/lib/auth/permissions";
import type { SessionContext } from "@/lib/auth/session";
import { clientAssignments, clients } from "./schema";
import { tenantDb, type TenantQuery } from "./tenant";

/**
 * Who may see which client. This is layer 4 of the authorization chain (CLAUDE.md): the rule
 * lives inside the query, so a route that forgets to check still cannot return someone else's
 * client.
 *
 *   owner      every client in their practice
 *   associate  only clients with an active assignment to them
 *   admin      only clients the owner has granted them, the same assignment rule as an associate
 *              (Sam, 2026-10-20); with no grant, nothing
 *
 * Underneath: tenantDb adds `organization_id = <session's organization>` to every statement and
 * Postgres row-level security enforces the same. A client that is not visible is simply absent,
 * so callers answer 404 and never reveal whether it exists.
 */

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
export const MAX_OFFSET = 10_000;

const uuid = z.uuid();

/** The only client fields that ever leave the server. No organization id, no deletion state. */
export type ClientView = {
  id: string;
  displayName: string;
  dateOfBirth: string | null;
  gradeLevel: string | null;
  externalId: string | null;
  createdAt: string;
};

export type ClientRow = typeof clients.$inferSelect;
type Db = Parameters<typeof tenantDb>[1];

export function toClientView(row: ClientRow): ClientView {
  return {
    id: row.id,
    displayName: row.displayName,
    dateOfBirth: row.dateOfBirth,
    gradeLevel: row.gradeLevel,
    externalId: row.externalId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The extra row filter for this caller: `undefined` means "no extra filter" (owner), an SQL
 * predicate narrows it (associate), and `null` means "no clients at all" (anything else; the
 * default for an unknown role is no access).
 */
export function visibilityFilter(session: SessionContext): SQL | undefined | null {
  if (!canReachClinicalContent(session.role)) return null;
  if (seesEveryClient(session.role)) return undefined;
  if (session.role !== "associate" && session.role !== "admin") return null;
  const userId = uuid.parse(session.userId);
  return sql`exists (
    select 1 from ${clientAssignments}
    where ${clientAssignments.organizationId} = ${clients.organizationId}
      and ${clientAssignments.clientId} = ${clients.id}
      and ${clientAssignments.userId} = ${userId}
      and ${clientAssignments.deletedAt} is null
  )`;
}

/** Out-of-range paging is clamped, not an error: nobody can ask for the whole table. */
export function clampPage(page: { limit?: number; offset?: number }): { limit: number; offset: number } {
  const limit = Number.isFinite(page.limit) ? Math.trunc(page.limit!) : DEFAULT_PAGE_SIZE;
  const offset = Number.isFinite(page.offset) ? Math.trunc(page.offset!) : 0;
  return { limit: Math.min(Math.max(limit, 1), MAX_PAGE_SIZE), offset: Math.min(Math.max(offset, 0), MAX_OFFSET) };
}

/** The list query for this caller, or null when they may see no clients (nothing is sent). */
export function listClientsQuery(
  session: SessionContext,
  page: { limit?: number; offset?: number } = {},
  db?: Db,
): TenantQuery<ClientRow[]> | null {
  const filter = visibilityFilter(session);
  if (filter === null) return null;
  const { limit, offset } = clampPage(page);
  return tenantDb({ organizationId: session.organizationId }, db).find(clients, {
    where: filter,
    orderBy: [desc(clients.createdAt), desc(clients.id)],
    limit,
    offset,
  });
}

/** The single-client query for this caller, or null when it cannot match (bad id, no access). */
export function getClientQuery(session: SessionContext, id: string, db?: Db): TenantQuery<ClientRow[]> | null {
  if (!uuid.safeParse(id).success) return null;
  const filter = visibilityFilter(session);
  if (filter === null) return null;
  return tenantDb({ organizationId: session.organizationId }, db).find(clients, {
    where: and(eq(clients.id, id), filter),
    limit: 1,
  });
}

export async function listClients(session: SessionContext, page: { limit?: number; offset?: number } = {}, db?: Db): Promise<ClientView[]> {
  const query = listClientsQuery(session, page, db);
  return query ? (await query).map(toClientView) : [];
}

/** One visible client, or undefined: not found, in another practice, not assigned, or not allowed. */
export async function getClient(session: SessionContext, id: string, db?: Db): Promise<ClientView | undefined> {
  const query = getClientQuery(session, id, db);
  if (!query) return undefined;
  const rows = await query;
  return rows[0] ? toClientView(rows[0]) : undefined;
}
