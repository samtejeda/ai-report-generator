import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, organizationId, pk, updatedAt } from "./_shared";
import { users } from "./users";

/**
 * Only the role an owner may invite today. Admin invitations are undecided (Sam, 2026-11-06), so the
 * CHECK on the table accepts nothing else: making "admin" invitable is a deliberate later migration.
 */
export const INVITABLE_ROLES = ["associate"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

// An owner's invitation for one person to join the practice as an associate. Ids, an email and times:
// no name, no PHI. The emailed link carries a random 256-bit token; only its SHA-256 is stored here
// (`token_hash`), so a database reader cannot accept an invitation. Not soft-deleted: it ends by being
// revoked or accepted, and the row stays. `app_runtime` can never delete one, and can never set
// `accepted_at` (only the accept_invitation() function does, migration 0016).
export const invitations = pgTable(
  "invitations",
  {
    id: pk(),
    organizationId: organizationId(),
    email: text("email").notNull(),
    role: text("role", { enum: INVITABLE_ROLES }).notNull().default("associate"),
    tokenHash: text("token_hash").notNull(),
    invitedBy: uuid("invited_by").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("invitations_org_id_uq").on(t.organizationId, t.id),
    unique("invitations_token_hash_uq").on(t.tokenHash),
    foreignKey({
      name: "invitations_invited_by_fk",
      columns: [t.organizationId, t.invitedBy],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete("restrict"),
    check("invitations_email_lowercase", sql`${t.email} = lower(${t.email})`),
    check("invitations_role_valid", sql`${t.role} = 'associate'`),
    check("invitations_token_hash_shape", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    // One pending invitation per address per practice; a second invite to the same address rotates the
    // token on this row instead of adding another.
    uniqueIndex("invitations_pending_uq")
      .on(t.organizationId, t.email)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
    index("invitations_org_created_idx").on(t.organizationId, t.createdAt),
    index("invitations_org_invited_by_idx").on(t.organizationId, t.invitedBy),
  ],
);
