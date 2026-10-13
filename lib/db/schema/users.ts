import { sql } from "drizzle-orm";
import { check, pgTable, text, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, deletedAt, organizationId, pk, updatedAt } from "./_shared";

export const USER_ROLES = ["owner", "associate", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

// =====================================================================================
// AUTH-PLAN EXTENSION POINT. This is a deliberately minimal shape for the data model.
// The auth plan owns: credentials (password_hash or provider-managed), the link to the
// auth identity, email uniqueness rules (per org vs global), sessions, tokens, MFA,
// client assignment for associates. Add those as additive migrations. Open questions
// are listed in PROGRESS.md. Do not put session or token columns in this file.
// =====================================================================================
export const users = pgTable(
  "users",
  {
    id: pk(),
    organizationId: organizationId(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: USER_ROLES }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique("users_org_id_uq").on(t.organizationId, t.id),
    // Provisional: per-org active email uniqueness. The auth plan may tighten to global.
    uniqueIndex("users_org_email_active_uq")
      .on(t.organizationId, sql`lower(${t.email})`)
      .where(sql`${t.deletedAt} is null`),
    check("users_role_valid", sql`${t.role} in ('owner','associate','admin')`),
  ],
);
