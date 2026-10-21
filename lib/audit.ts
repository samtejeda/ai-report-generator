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
  // Client writes (feat/clients-crud). The client id and the caller's role; never a name or a date.
  "client.created",
  "client.updated",
  "client.deleted",
  // Admin (feat/auth-admin). Ids and a role or a "set"/"cleared" word only; never the endpoint URL.
  "org.inference_endpoint_set",
  "user.role_changed",
  "user.deactivated",
  "user.reactivated",
  "assignment.created",
  "assignment.ended",
  // Reports (feat/report-shell). Report, section-version and template ids and the caller's role; never section text.
  "report.listed",
  "report.viewed",
  "report.created",
  "report.section_edited",
  "report.finalized",
  // Generation (feat/generate-section-stub). Report and version ids, the caller's role, and the model
  // tag, token counts, latency and a failure code from a closed list; never the prompt, the output or
  // the endpoint.
  "report.generation_started",
  "report.generated",
  "report.generation_failed",
  // Written by scripts/seed-report-template.mjs (method `seed_script`).
  "template.created",
  "methodology_prompt.created",
  // Written by scripts/bootstrap-owner.mjs (method `bootstrap_script`); there is no sign-up in the app.
  "org.created",
  "user.created",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// `previous_role` is a role name (owner, associate, admin) and nothing else: it cannot carry PHI.
// `fields` names which client columns a write touched, from the closed list below and nothing else.
export const AUDIT_METADATA_KEYS = ["reason", "ip", "method", "role", "previous_role", "fields", "mode", "model", "input_tokens", "output_tokens", "latency_ms"] as const;
/** Column names only (never values). A `fields` value outside this list is rejected, so it cannot carry PHI. */
export const AUDIT_CLIENT_FIELDS = ["display_name", "date_of_birth", "grade_level", "external_id"] as const;
/** Why a generation failed: a code, never text from the model or the transport. */
export const AUDIT_GENERATION_FAILURES = ["unreachable", "timeout", "bad_response", "invalid_output", "invalid_config", "not_implemented", "stale", "internal"] as const;
const MAX_VALUE_LENGTH = 100;
// An Ollama tag (same character rules as lib/ai/models.ts), so `model` cannot hold free text.
const MODEL_TAG = /^(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._\-:/]{0,99}$/; // no "//", so a URL cannot pass as a tag

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
    if (key === "fields") {
      const names = String(value).split(",");
      if (!names.every((n) => (AUDIT_CLIENT_FIELDS as readonly string[]).includes(n))) throw new Error("audit metadata value for fields is not a known field list");
    }
    if (key === "mode" && value !== "stub" && value !== "real") throw new Error("audit metadata value for mode must be stub or real");
    if (key === "model" && !(kind === "string" && MODEL_TAG.test(value as string))) throw new Error("audit metadata value for model is not a model tag");
    if ((key === "input_tokens" || key === "output_tokens" || key === "latency_ms") && !(kind === "number" && Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1e9)) {
      throw new Error(`audit metadata value for ${key} must be a non-negative whole number`);
    }
    metadata[key] = value;
  }
  // A failed generation says why with a code from the closed list, nothing else.
  if (event.action === "report.generation_failed" && !(AUDIT_GENERATION_FAILURES as readonly string[]).includes(String(metadata.reason))) {
    throw new Error("audit metadata value for reason is not a known generation failure code");
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
