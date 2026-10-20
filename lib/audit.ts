import { tenantDb } from "@/lib/db/tenant";
import type { TenantContext } from "@/lib/db/tenant";
import { auditLog, AUDIT_OUTCOMES } from "@/lib/db/schema/audit-log";

/**
 * The only writer to audit_log (audit 03 item 7, 04 item 9, CLAUDE.md "Audit logging").
 *
 * Ids and allow-listed facts only. The metadata allow-list below is what keeps client
 * names, note text, request bodies, passwords and tokens out of the log: a key that is not
 * listed is rejected, and so is any value that is not a short plain string, number or
 * boolean. Add a key here only after asking whether it could carry PHI.
 *
 * A failed audit write is logged to the application log (no payload) and does not block the
 * user action. Validation errors do throw: they mean the calling code is wrong, and tests
 * catch them.
 */

export const AUDIT_ACTIONS = [
  "auth.login",
  "auth.login_failed",
  "auth.logout",
  "auth.password_changed",
  "auth.password_reset_requested",
  "auth.password_reset_completed",
  "auth.email_verified",
  "auth.session_ended",
  // MFA (feat/auth-mfa). Codes, secrets and device tokens are never recorded, only that it happened.
  "auth.mfa_enrollment_started",
  "auth.mfa_enrolled",
  "auth.mfa_challenge",
  "auth.mfa_failed",
  "auth.mfa_backup_code_used",
  "auth.mfa_backup_codes_regenerated",
  "auth.mfa_device_trusted",
  "auth.mfa_reset",
  // Authorization (feat/auth-authz). Ids and the caller's role only, never a client's name.
  "authz.denied",
  "client.listed",
  "client.viewed",
  // Admin (feat/auth-admin). Ids and a role or a "set"/"cleared" word only; never the endpoint URL.
  "org.inference_endpoint_set",
  "user.role_changed",
  "user.deactivated",
  "user.reactivated",
  "assignment.created",
  "assignment.ended",
  // Written by scripts/bootstrap-owner.mjs (method `bootstrap_script`); there is no sign-up in the app.
  "org.created",
  "user.created",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// `previous_role` is a role name (owner, associate, admin) and nothing else: it cannot carry PHI.
export const AUDIT_METADATA_KEYS = ["reason", "ip", "method", "role", "previous_role"] as const;
const MAX_VALUE_LENGTH = 100;

export type AuditEvent = {
  action: AuditAction;
  resourceType: string;
  resourceId?: string | null;
  outcome?: (typeof AUDIT_OUTCOMES)[number];
  metadata?: Record<string, string | number | boolean>;
};

export type AuditActor = TenantContext & { actorUserId?: string | null; requestId?: string | null };

export type AuditDb = Parameters<typeof tenantDb>[1];

/** Validates an event and builds the row. Pure; throws on anything that could hold PHI. */
export function buildAuditRow(event: AuditEvent) {
  if (!(AUDIT_ACTIONS as readonly string[]).includes(event.action)) throw new Error(`unknown audit action: ${event.action}`);
  if (!/^[a-z_]+$/.test(event.resourceType)) throw new Error("resourceType must be a lowercase table-style name");
  const metadata: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(event.metadata ?? {})) {
    if (!(AUDIT_METADATA_KEYS as readonly string[]).includes(key)) throw new Error(`audit metadata key not allowed: ${key}`);
    const kind = typeof value;
    if (kind !== "string" && kind !== "number" && kind !== "boolean") throw new Error(`audit metadata value for ${key} must be a string, number or boolean`);
    if (kind === "string" && (value as string).length > MAX_VALUE_LENGTH) throw new Error(`audit metadata value for ${key} is too long`);
    metadata[key] = value;
  }
  return {
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId ?? null,
    outcome: event.outcome ?? "success",
    metadata,
  };
}

/** Records one event for the actor's organization. Returns false if the write failed. */
export async function audit(actor: AuditActor, event: AuditEvent, db?: AuditDb): Promise<boolean> {
  const row = buildAuditRow(event);
  try {
    await tenantDb({ organizationId: actor.organizationId }, db).insert(auditLog, {
      ...row,
      actorUserId: actor.actorUserId ?? null,
      requestId: actor.requestId ?? null,
    });
    return true;
  } catch (error) {
    // No payload: only the action and the Postgres error code, if any.
    const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
    console.error(JSON.stringify({ event: "audit_write_failed", action: event.action, code: code ?? "unknown" }));
    return false;
  }
}
