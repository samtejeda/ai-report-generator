import { uuid, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

// Conventions (see the data-model plan in PROGRESS.md):
// - uuid PKs via gen_random_uuid(), timestamptz everywhere.
// - Every table except `organizations` carries organization_id (FK, RESTRICT).
// - Parent tables expose UNIQUE (organization_id, id) so children can use composite
//   FKs (organization_id, parent_id) and the database itself rejects cross-tenant links.
// - Status/type columns are text + CHECK, not pg enums (enum values cannot be removed).

export const pk = () => uuid("id").primaryKey().defaultRandom();

export const organizationId = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" });

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// Kept fresh by the set_updated_at() trigger (custom migration), not only by Drizzle.
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const deletedAt = () => timestamp("deleted_at", { withTimezone: true });
