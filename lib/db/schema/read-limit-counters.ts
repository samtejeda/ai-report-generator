// REMOVABLE (Sam, PROGRESS.md decision 15): this table exists only to count calls to
// GET /api/reports/{id}/state per person without writing an audit row. If the check is removed, this
// file goes too, but dropping the table needs a NEW forward-only migration (`drop table
// read_limit_counters`, after confirming nothing else uses it); never edit or delete migration
// 0014_read_limit_counters.sql, which has already been applied. Remove with it: the export in
// lib/db/schema/index.ts, COUNTER_TABLES and countRead() in lib/db/tenant.ts (and its tests in
// lib/db/tenant.test.ts), the table's entries in lib/db/schema.test.ts and the "per-person read
// counter" block and fixture row in lib/db/integration.test.ts, and the CLAUDE.md data-model bullet.
// The `report_state` key is the only one in READ_LIMIT_KEYS today.
import { sql } from "drizzle-orm";
import { check, foreignKey, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, organizationId, pk, updatedAt } from "./_shared";
import { users } from "./users";

export const READ_LIMIT_KEYS = ["report_state"] as const;
export type ReadLimitKey = (typeof READ_LIMIT_KEYS)[number];

// A coarse per-person limit on a frequently repeated READ (the "someone changed this section"
// check), counted without writing an audit row. One row per (person, key), never more, so the
// table does not grow and nothing has to clean it up: the row holds the current minute and how
// many calls that person made in it. Rows carry two ids, a closed key and two numbers; no PHI.
// Written only through tenantDb's countRead() (one atomic upsert); app_runtime may not delete,
// and may update only the counting columns.
export const readLimitCounters = pgTable(
  "read_limit_counters",
  {
    id: pk(),
    organizationId: organizationId(),
    userId: uuid("user_id").notNull(),
    key: text("key", { enum: READ_LIMIT_KEYS }).notNull(),
    // Start of the minute being counted, by the database clock.
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The upsert's conflict target; it also covers the composite foreign key below.
    unique("read_limit_counters_person_key_uq").on(t.organizationId, t.userId, t.key),
    foreignKey({
      name: "read_limit_counters_user_fk",
      columns: [t.organizationId, t.userId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete("restrict"),
    check("read_limit_counters_key_valid", sql`${t.key} in ('report_state')`),
    check("read_limit_counters_count_nonneg", sql`${t.count} >= 0`),
  ],
);
