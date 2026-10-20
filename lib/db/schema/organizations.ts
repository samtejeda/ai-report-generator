import { sql } from "drizzle-orm";
import { char, check, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The allow-list for `inference_endpoint` (audit 04 item 8): https, a Tailscale name with at
 * least two labels before `.ts.net`, an optional Funnel port, an optional `/v1`. Lower case
 * only, no punycode label. The same text is the CHECK constraint below and is what
 * lib/inference-endpoint.ts validates against; lib/inference-endpoint.test.ts fails if the
 * constraint (here and in migration 0010) stops matching this constant. Written without
 * backslashes so it means the same thing to JavaScript and to Postgres.
 */
export const INFERENCE_ENDPOINT_PATTERN =
  "^https://(?!xn--)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.](?!xn--)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+[.]ts[.]net(:(443|8443|10000))?(/v1)?$";

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
  (t) => [
    check("organizations_retention_positive", sql`${t.dataRetentionDays} is null or ${t.dataRetentionDays} > 0`),
    // Must stay identical to INFERENCE_ENDPOINT_PATTERN above (a test compares them).
    check(
      "organizations_inference_endpoint_allowlist",
      sql`${t.inferenceEndpoint} is null or (length(${t.inferenceEndpoint}) <= 253 and ${t.inferenceEndpoint} ~ '^https://(?!xn--)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.](?!xn--)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+[.]ts[.]net(:(443|8443|10000))?(/v1)?$')`,
    ),
  ],
);
