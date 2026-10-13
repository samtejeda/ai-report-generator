import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, pk } from "./_shared";

export const AUDIT_OUTCOMES = ["success", "failure", "denied"] as const;

// APPEND-ONLY. Grants and triggers (custom migration) forbid UPDATE and DELETE.
//
// Deliberate exceptions to the table conventions, so the log survives everything else:
// - NO foreign keys (not even to organizations or users): a client or user purge must
//   never be blocked by, or cascade into, the audit trail.
// - Only created_at: rows are never updated or soft-deleted.
//
// NO PHI: ids, action names, and allow-listed metadata keys only (enforced by
// lib/audit.ts when it is written). Never client names, note text, or request bodies.
export const auditLog = pgTable(
  "audit_log",
  {
    id: pk(),
    organizationId: uuid("organization_id").notNull(),
    // Null for system actions.
    actorUserId: uuid("actor_user_id"),
    // e.g. "client.read", "report.finalize", "auth.login_failed"
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id"),
    outcome: text("outcome", { enum: AUDIT_OUTCOMES }).notNull().default("success"),
    requestId: text("request_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    // Access path required by CLAUDE.md "Audit logging".
    index("audit_log_org_resource_idx").on(t.organizationId, t.resourceType, t.resourceId, t.createdAt),
    index("audit_log_org_created_idx").on(t.organizationId, t.createdAt),
    index("audit_log_org_actor_created_idx").on(t.organizationId, t.actorUserId, t.createdAt),
    check("audit_log_outcome_valid", sql`${t.outcome} in ('success','failure','denied')`),
  ],
);
