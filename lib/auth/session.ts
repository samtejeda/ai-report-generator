import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AuthDb } from "@/lib/db/auth-db";
import { authSessions } from "@/lib/db/schema";
import { USER_ROLES, type UserRole } from "@/lib/db/schema/users";
import type { Auth } from "./auth";
import { SESSION_ABSOLUTE_SECONDS, SESSION_IDLE_SECONDS, SESSION_SLIDE_INTERVAL_SECONDS } from "./config";

/** What every protected page, server action and route handler gets, and nothing more. */
export type SessionContext = {
  userId: string;
  /** From the database on every request, never from the cookie or request input. */
  organizationId: string;
  role: UserRole;
};

const identitySchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  role: z.enum(USER_ROLES),
  emailVerified: z.boolean(),
  deletedAt: z.coerce.date().nullish(),
});

export type ResolveDeps = {
  auth: Auth;
  authDb: AuthDb;
  now?: () => Date;
};

/**
 * Resolves the caller's session or returns null. Order matters and each step fails closed:
 *  1. Better Auth validates the signed cookie and the idle deadline (`expires_at`), with its own
 *     refresh disabled (it cannot write cookies from a Server Component).
 *  2. The absolute cap is enforced from created_at, and a capped session is deleted.
 *  3. A deactivated user or unverified email gets no session (and deactivation deletes theirs).
 *  4. An active session slides its idle deadline forward at most once per interval, never past
 *     the cap.
 * Role and organization come from this read, so a role change applies on the next request.
 */
export async function resolveSession(headers: Headers, deps: ResolveDeps): Promise<SessionContext | null> {
  const now = (deps.now ?? (() => new Date()))();
  const found = await deps.auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } });
  if (!found) return null;

  const { session } = found;
  const created = new Date(session.createdAt).getTime();
  if (now.getTime() - created >= SESSION_ABSOLUTE_SECONDS * 1000) {
    await deps.authDb.delete(authSessions).where(eq(authSessions.token, session.token));
    return null;
  }

  const parsed = identitySchema.safeParse(found.user);
  if (!parsed.success) return null;
  const user = parsed.data;
  if (user.deletedAt) {
    await deps.authDb.delete(authSessions).where(eq(authSessions.userId, user.id));
    return null;
  }
  if (!user.emailVerified) return null;

  const lastTouched = new Date(session.updatedAt).getTime();
  if (now.getTime() - lastTouched >= SESSION_SLIDE_INTERVAL_SECONDS * 1000) {
    const idleDeadline = now.getTime() + SESSION_IDLE_SECONDS * 1000;
    const capDeadline = created + SESSION_ABSOLUTE_SECONDS * 1000;
    await deps.authDb
      .update(authSessions)
      .set({ expiresAt: new Date(Math.min(idleDeadline, capDeadline)), updatedAt: now })
      .where(and(eq(authSessions.token, session.token), sql`${authSessions.expiresAt} > ${now}`));
  }

  return { userId: user.id, organizationId: user.organizationId, role: user.role };
}
