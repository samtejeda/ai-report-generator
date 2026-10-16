import { bigint, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, pk, updatedAt } from "./_shared";
import { users } from "./users";

// =====================================================================================
// AUTH TABLES (Better Auth, self-hosted). Credentials, sessions, reset tokens and the
// login rate limiter.
//
// Deliberate exceptions to the tenant conventions (audit 04 item 1, audit 03):
// - NO organization_id and NO row-level security. These tables are not tenant data and are
//   never reached through tenantDb. Access is separated by role instead: only the
//   `auth_runtime` database role (used by Better Auth alone, via AUTH_DATABASE_URL) can touch
//   them; `app_runtime`, which feature code uses, has no privilege on them at all
//   (migration 0006, proven by tests). So a bug in feature code cannot read a password hash,
//   a session token or a reset token.
// - They are listed in AUTH_TABLES, not TENANT_TABLES, and lib/db/schema.test.ts checks the
//   two registries together cover every table exactly once.
//
// Nothing here may hold clinical data.
// =====================================================================================

// One row per sign-in method per user. Only the email+password ("credential") method exists;
// `password` holds a scrypt hash (Better Auth default), never the password.
export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("auth_accounts_user_idx").on(t.userId),
    unique("auth_accounts_provider_account_uq").on(t.providerId, t.accountId),
  ],
);

// `token` is the secret behind the session cookie. `expires_at` is the IDLE deadline (slides
// forward while the user is active); the absolute cap is created_at + SESSION_ABSOLUTE_SECONDS
// and is enforced in requireSession (lib/auth/session.ts).
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("auth_sessions_token_uq").on(t.token),
    index("auth_sessions_user_idx").on(t.userId),
    index("auth_sessions_expires_idx").on(t.expiresAt),
  ],
);

// Reset-password tokens (stored hashed; see lib/auth/auth.ts). Single use: the row is deleted
// when the token is spent. No organization or user FK: `value` is an opaque reference.
export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: pk(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_verifications_identifier_idx").on(t.identifier), index("auth_verifications_expires_idx").on(t.expiresAt)],
);

// Fixed-window counters for the auth endpoints, keyed by client address + path. Kept in the
// database because serverless instances share no memory.
export const authRateLimits = pgTable(
  "auth_rate_limits",
  {
    id: pk(),
    key: text("key").notNull(),
    count: integer("count").notNull(),
    lastRequest: bigint("last_request", { mode: "number" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("auth_rate_limits_key_uq").on(t.key)],
);

export const AUTH_TABLES = [authAccounts, authSessions, authVerifications, authRateLimits] as const;
