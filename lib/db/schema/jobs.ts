import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt, organizationId, pk, updatedAt } from "./_shared";

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed"] as const;

// For async work when sync timing hurts. Created now, not used in v1.
// payload holds ids only, never client content. resource_type/resource_id let the purge
// function find and delete jobs that reference a purged client or report (no FK, since a
// job can point at any resource type).
export const jobs = pgTable(
  "jobs",
  {
    id: pk(),
    organizationId: organizationId(),
    type: text("type").notNull(),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    resourceType: text("resource_type"),
    resourceId: uuid("resource_id"),
    attempts: integer("attempts").notNull().default(0),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    // Scrubbed error summary; never a stack with request data.
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jobs_queue_idx")
      .on(t.status, t.runAt)
      .where(sql`${t.status} = 'queued'`),
    index("jobs_org_status_idx").on(t.organizationId, t.status),
    index("jobs_org_resource_idx").on(t.organizationId, t.resourceType, t.resourceId),
    check("jobs_status_valid", sql`${t.status} in ('queued','running','succeeded','failed')`),
    check("jobs_attempts_nonneg", sql`${t.attempts} >= 0`),
  ],
);
