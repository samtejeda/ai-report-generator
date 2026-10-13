import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, deletedAt, organizationId, pk, updatedAt } from "./_shared";
import { clients } from "./clients";
import { reports } from "./reports";
import { users } from "./users";

export const CLIENT_HISTORY_ENTRY_TYPES = ["prior_evaluation", "reeval_due", "note"] as const;

// Longitudinal thread per client. `summary` is free text and therefore PHI: it is
// derived data that cascades away on a client purge.
export const clientHistory = pgTable(
  "client_history",
  {
    id: pk(),
    organizationId: organizationId(),
    clientId: uuid("client_id").notNull(),
    entryType: text("entry_type", { enum: CLIENT_HISTORY_ENTRY_TYPES }).notNull(),
    occurredOn: date("occurred_on", { mode: "string" }).notNull(),
    // Re-eval cadence (IDEA requires a re-evaluation every 3 years).
    dueOn: date("due_on", { mode: "string" }),
    summary: text("summary"),
    // Optional link to a report in this system (same org enforced by the FK).
    reportId: uuid("report_id"),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    foreignKey({
      name: "client_history_client_fk",
      columns: [t.organizationId, t.clientId],
      foreignColumns: [clients.organizationId, clients.id],
    }).onDelete("cascade"),
    // NO ACTION (checked at end of statement), not RESTRICT: a client purge deletes the
    // client's reports and history rows in the same statement.
    foreignKey({
      name: "client_history_report_fk",
      columns: [t.organizationId, t.reportId],
      foreignColumns: [reports.organizationId, reports.id],
    }).onDelete("no action"),
    foreignKey({
      name: "client_history_created_by_fk",
      columns: [t.organizationId, t.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete("restrict"),
    index("client_history_org_client_occurred_idx").on(t.organizationId, t.clientId, t.occurredOn.desc()),
    index("client_history_org_report_idx").on(t.organizationId, t.reportId),
    index("client_history_org_created_by_idx").on(t.organizationId, t.createdByUserId),
    check("client_history_entry_type_valid", sql`${t.entryType} in ('prior_evaluation','reeval_due','note')`),
  ],
);
