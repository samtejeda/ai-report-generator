import { sql } from "drizzle-orm";
import { date, index, pgTable, text, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, deletedAt, organizationId, pk, updatedAt } from "./_shared";

// Minimum PII only (CLAUDE.md "Data model"). Deliberately absent: address, guardian
// contact, school name, diagnosis columns. Synthetic data only until Phase C.
export const clients = pgTable(
  "clients",
  {
    id: pk(),
    organizationId: organizationId(),
    externalId: text("external_id"),
    displayName: text("display_name").notNull(),
    dateOfBirth: date("date_of_birth", { mode: "string" }),
    gradeLevel: text("grade_level"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique("clients_org_id_uq").on(t.organizationId, t.id),
    uniqueIndex("clients_org_external_id_active_uq")
      .on(t.organizationId, t.externalId)
      .where(sql`${t.externalId} is not null and ${t.deletedAt} is null`),
    index("clients_org_created_idx").on(t.organizationId, t.createdAt.desc()),
  ],
);
