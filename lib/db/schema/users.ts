import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, unique } from "drizzle-orm/pg-core";
import { createdAt, deletedAt, organizationId, pk, updatedAt } from "./_shared";

export const USER_ROLES = ["owner", "associate", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

// Credentials, sessions and reset tokens live in the auth tables (auth.ts), reached only
// through the auth_runtime role. This table holds identity, role and tenant membership.
// Email is globally unique (one account per address across all practices) and lowercase.
export const users = pgTable(
  "users",
  {
    id: pk(),
    organizationId: organizationId(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    // Set only by the auth layer (the MFA plugin), after the first authenticator code verifies.
    // app_runtime cannot write it (migration 0008), so feature code cannot switch MFA off.
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
    displayName: text("display_name").notNull(),
    // Unused. Better Auth's schema check requires the column; nothing writes or reads it.
    image: text("image"),
    role: text("role", { enum: USER_ROLES }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique("users_org_id_uq").on(t.organizationId, t.id),
    // Global, and includes deactivated rows: an address is never reused for a second
    // account, and Better Auth looks users up by email without knowing about deleted_at.
    unique("users_email_uq").on(t.email),
    check("users_email_lowercase", sql`${t.email} = lower(${t.email})`),
    check("users_role_valid", sql`${t.role} in ('owner','associate','admin')`),
  ],
);
