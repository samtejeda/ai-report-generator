import { foreignKey, index, pgTable, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createdAt, deletedAt, organizationId, pk, updatedAt } from "./_shared";
import { clients } from "./clients";
import { users } from "./users";

// Which psychologist (associate) may see which client. The owner sees every client in the
// practice and needs no row; an admin gets no clinical access from this table in v1 (the
// "granted" mechanism is designed with the admin screens). Rows carry no PHI: three ids.
//
// Ending an assignment is a soft delete (deleted_at), so who had access and when stays
// answerable. A client purge removes the rows with the client (cascade). Creating and ending
// assignments is an owner action built with the admin screens; until then rows come from
// tests and the owner credential only.
export const clientAssignments = pgTable(
  "client_assignments",
  {
    id: pk(),
    organizationId: organizationId(),
    clientId: uuid("client_id").notNull(),
    userId: uuid("user_id").notNull(),
    assignedByUserId: uuid("assigned_by_user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique("client_assignments_org_id_uq").on(t.organizationId, t.id),
    // Composite FKs: the database itself rejects an assignment that crosses organizations.
    foreignKey({
      name: "client_assignments_client_fk",
      columns: [t.organizationId, t.clientId],
      foreignColumns: [clients.organizationId, clients.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "client_assignments_user_fk",
      columns: [t.organizationId, t.userId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "client_assignments_assigned_by_fk",
      columns: [t.organizationId, t.assignedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete("restrict"),
    // One active assignment per (client, user); a revoked one can be granted again.
    uniqueIndex("client_assignments_active_uq")
      .on(t.organizationId, t.clientId, t.userId)
      .where(sql`${t.deletedAt} is null`),
    // "Which clients may this user see" (the associate's list) leads with the user.
    index("client_assignments_org_user_client_idx").on(t.organizationId, t.userId, t.clientId),
    index("client_assignments_org_assigned_by_idx").on(t.organizationId, t.assignedByUserId),
  ],
);
