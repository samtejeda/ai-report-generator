import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { buildAuditRow, type AuditEvent } from "@/lib/audit";
import { INVITATION_LIMITS, INVITATION_SECONDS } from "@/lib/auth/config";
import type { SessionContext } from "@/lib/auth/session";
import { clampPage } from "./client-access";
import { auditLog, invitations } from "./schema";
import { tenantDb } from "./tenant";

/**
 * The owner's side of invitations: list, create, re-send, revoke. OWNER ONLY (Sam, 2026-11-06), and
 * only the associate role (the table's CHECK allows nothing else).
 *
 * Everything goes through tenantDb, so another practice's invitation is simply "not found". Creating
 * and re-sending are rate-limited per practice from the practice's own audit rows, so those rows are
 * written INSIDE the same transaction and under a per-practice lock (like generation starts): two
 * requests cannot both pass the check, and a refusal costs the same as a mail.
 *
 * "The address already has an account" is decided by the caller (`addressTaken`, answered by the auth
 * layer, which alone may look across practices). When it is true nothing differs for the owner: the row
 * is stored and listed exactly like any other, with the same answer, and only the mail is skipped and
 * the audit row says `invitation.refused`. The token hash passed in is the only token-derived value
 * that ever reaches the database.
 */

type Db = Parameters<typeof tenantDb>[1];
type Row = typeof invitations.$inferSelect;

export type InvitationStatus = "pending" | "expired" | "accepted" | "revoked";

/** Ids, an address and times. Never the token or its hash. */
export type InvitationView = {
  id: string;
  email: string;
  role: Row["role"];
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
  invitedByUserId: string;
};

export function invitationStatus(row: Pick<Row, "acceptedAt" | "revokedAt" | "expiresAt">, now: Date = new Date()): InvitationStatus {
  if (row.acceptedAt) return "accepted";
  if (row.revokedAt) return "revoked";
  return row.expiresAt.getTime() <= now.getTime() ? "expired" : "pending";
}

const toView = (row: Row): InvitationView => ({
  id: row.id,
  email: row.email,
  role: row.role,
  status: invitationStatus(row),
  expiresAt: row.expiresAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
  invitedByUserId: row.invitedBy,
});

// Defense in depth: the routes allow the owner only. Any other caller reaching this is a bug and fails
// loudly (the route turns it into a fixed 500) instead of acting.
function assertOwner(session: SessionContext) {
  if (session.role !== "owner") throw new Error("invitations are managed by the owner only");
}

const RATE_ACTIONS = ["invitation.created", "invitation.resent", "invitation.refused"] as const;
const window = sql`make_interval(secs => ${INVITATION_LIMITS.windowSeconds})`;
const newExpiry = () => new Date(Date.now() + INVITATION_SECONDS * 1000);

type Txn = Parameters<Parameters<ReturnType<typeof tenantDb>["transaction"]>[0]>[0];

async function rateLimited(t: Txn): Promise<number | null> {
  const rows = await t.find(auditLog, {
    where: and(inArray(auditLog.action, [...RATE_ACTIONS]), gt(auditLog.createdAt, sql`now() - ${window}`)),
    orderBy: desc(auditLog.createdAt),
    limit: INVITATION_LIMITS.maxPerPractice,
  });
  if (rows.length < INVITATION_LIMITS.maxPerPractice) return null;
  // The oldest of the newest `max` rows is the one that has to age out of the window.
  const oldest = rows[rows.length - 1].createdAt.getTime();
  return Math.max(1, Math.ceil(INVITATION_LIMITS.windowSeconds - (Date.now() - oldest) / 1000));
}

function auditRow(session: SessionContext, event: AuditEvent) {
  return { ...buildAuditRow(event), actorUserId: session.userId, requestId: null };
}

export async function listInvitations(session: SessionContext, page: { limit?: number; offset?: number } = {}, db?: Db): Promise<InvitationView[]> {
  assertOwner(session);
  const { limit, offset } = clampPage(page);
  const rows = await tenantDb({ organizationId: session.organizationId }, db).find(invitations, {
    orderBy: [desc(invitations.createdAt), desc(invitations.id)],
    limit,
    offset,
  });
  return rows.map(toView);
}

export type IssueResult =
  | { ok: true; invitation: InvitationView; taken: boolean }
  | { ok: false; reason: "rate_limited"; retryAfterSeconds: number };

/**
 * Invites an address. A pending invitation to the same address in this practice is replaced (new token,
 * new expiry, old link dead), never duplicated. `taken` is true when the address already has an account
 * somewhere: the caller then sends no mail.
 */
export async function issueInvitation(
  session: SessionContext,
  input: { email: string; tokenHash: string; addressTaken: (email: string) => Promise<boolean> },
  db?: Db,
): Promise<IssueResult> {
  assertOwner(session);
  return tenantDb({ organizationId: session.organizationId }, db).transaction(async (t): Promise<IssueResult> => {
    await t.lock("invitation");
    const wait = await rateLimited(t);
    if (wait !== null) return { ok: false, reason: "rate_limited", retryAfterSeconds: wait };

    const taken = await input.addressTaken(input.email);
    const [pending] = await t.find(invitations, { where: and(eq(invitations.email, input.email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)), limit: 1 });
    let row: Row;
    if (pending) {
      [row] = await t.update(invitations, pending.id, { tokenHash: input.tokenHash, expiresAt: newExpiry(), invitedBy: session.userId });
    } else {
      [row] = await t.insert(invitations, { email: input.email, tokenHash: input.tokenHash, invitedBy: session.userId, expiresAt: newExpiry() });
    }
    await t.insert(
      auditLog,
      auditRow(
        session,
        taken
          ? { action: "invitation.refused", resourceType: "invitation", resourceId: row.id, outcome: "denied", metadata: { reason: "address_in_use", role: "associate" } }
          : { action: "invitation.created", resourceType: "invitation", resourceId: row.id, metadata: { role: "associate" } },
      ),
    );
    return { ok: true, invitation: toView(row), taken };
  });
}

export type ResendResult =
  | { ok: true; invitation: InvitationView; email: string; taken: boolean }
  | { ok: false; reason: "not_found" | "closed" }
  | { ok: false; reason: "rate_limited"; retryAfterSeconds: number };

/** A new link and a fresh period for a pending (or expired) invitation; the old link stops working. */
export async function resendInvitation(
  session: SessionContext,
  input: { id: string; tokenHash: string; addressTaken: (email: string) => Promise<boolean> },
  db?: Db,
): Promise<ResendResult> {
  assertOwner(session);
  return tenantDb({ organizationId: session.organizationId }, db).transaction(async (t): Promise<ResendResult> => {
    await t.lock("invitation");
    const [found] = await t.find(invitations, { where: eq(invitations.id, input.id), limit: 1 });
    if (!found) return { ok: false, reason: "not_found" };
    if (found.acceptedAt || found.revokedAt) return { ok: false, reason: "closed" };
    const wait = await rateLimited(t);
    if (wait !== null) return { ok: false, reason: "rate_limited", retryAfterSeconds: wait };

    const taken = await input.addressTaken(found.email);
    const rows = await t.update(
      invitations,
      found.id,
      { tokenHash: input.tokenHash, expiresAt: newExpiry() },
      and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt)),
    );
    if (!rows[0]) return { ok: false, reason: "closed" };
    await t.insert(
      auditLog,
      auditRow(
        session,
        taken
          ? { action: "invitation.refused", resourceType: "invitation", resourceId: found.id, outcome: "denied", metadata: { reason: "address_in_use", role: "associate" } }
          : { action: "invitation.resent", resourceType: "invitation", resourceId: found.id, metadata: { role: "associate" } },
      ),
    );
    return { ok: true, invitation: toView(rows[0]), email: found.email, taken };
  });
}

export type RevokeResult = { ok: true; invitation: InvitationView } | { ok: false; reason: "not_found" | "accepted" };

/** Revokes a pending (or expired) invitation. Already revoked is a no-op success; accepted cannot be revoked. */
export async function revokeInvitation(session: SessionContext, id: string, db?: Db): Promise<RevokeResult> {
  assertOwner(session);
  return tenantDb({ organizationId: session.organizationId }, db).transaction(async (t): Promise<RevokeResult> => {
    const [found] = await t.find(invitations, { where: eq(invitations.id, id), limit: 1 });
    if (!found) return { ok: false, reason: "not_found" };
    if (found.acceptedAt) return { ok: false, reason: "accepted" };
    if (found.revokedAt) return { ok: true, invitation: toView(found) };
    const rows = await t.update(invitations, found.id, { revokedAt: new Date() }, and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    if (!rows[0]) {
      // The state moved between the read and the write: answer as if it had been like this before.
      const [now] = await t.find(invitations, { where: eq(invitations.id, found.id), limit: 1 });
      return now?.revokedAt ? { ok: true, invitation: toView(now) } : { ok: false, reason: "accepted" };
    }
    await t.insert(auditLog, auditRow(session, { action: "invitation.revoked", resourceType: "invitation", resourceId: found.id, metadata: { role: "associate" } }));
    return { ok: true, invitation: toView(rows[0]) };
  });
}
