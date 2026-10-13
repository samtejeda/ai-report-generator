import { sql } from "drizzle-orm";
import { char, check, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// The practice. The only table without organization_id (its own id is the tenant key).
// v1: exactly one row.
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    type: text("type").notNull().default("private_practice"),
    state: char("state", { length: 2 }),
    // Set by an admin action only, validated against an allow-list (never from request
    // input). Validation lives in the app layer; see audit 04 item 8.
    inferenceEndpoint: text("inference_endpoint"),
    modelConfig: jsonb("model_config").$type<Record<string, unknown>>().notNull().default({}),
    // Nothing enforces this yet: retention policy is a decision for Sam and the lawyer.
    dataRetentionDays: integer("data_retention_days"),
    baaSignedAt: timestamp("baa_signed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [check("organizations_retention_positive", sql`${t.dataRetentionDays} is null or ${t.dataRetentionDays} > 0`)],
);
