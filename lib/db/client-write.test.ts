import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";
import type { SessionContext } from "@/lib/auth/session";
import { CLIENT_DELETE_ROLES, CLIENT_WRITE_ROLES, canWriteClients } from "@/lib/auth/permissions";
import { createClient, softDeleteClient, updateClient, updateClientQuery } from "./client-write";

// SQL-shape tests without a connection. What matters most: in an UPDATE, the visibility rule must
// compare against the clients row being updated (qualified names), or the subquery would bind to
// client_assignments and be true for every row. Behavior against a real database is in
// lib/auth/clients.integration.test.ts.
const mock = drizzle.mock({ schema });
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";
const as = (role: SessionContext["role"]): SessionContext => ({ userId: USER, organizationId: ORG, role, signedInAt: new Date("2026-10-20T12:00:00Z") });

describe("who may write", () => {
  it("owner and associate write; admin and unknown roles do not; only the owner deletes", () => {
    expect([...CLIENT_WRITE_ROLES]).toEqual(["owner", "associate"]);
    expect([...CLIENT_DELETE_ROLES]).toEqual(["owner"]);
    expect(canWriteClients("admin")).toBe(false);
    expect(canWriteClients("superuser" as never)).toBe(false);
  });

  it("the data layer refuses a role the route should already have refused", async () => {
    await expect(createClient(as("admin"), { displayName: "x", dateOfBirth: null, gradeLevel: null, externalId: null }, mock)).rejects.toThrow(/not allowed/);
    await expect(updateClient(as("admin"), ID, { gradeLevel: "3" }, mock)).rejects.toThrow(/not allowed/);
    await expect(softDeleteClient(as("associate"), ID, mock)).rejects.toThrow(/not allowed/);
    await expect(softDeleteClient(as("admin"), ID, mock)).rejects.toThrow(/not allowed/);
  });
});

describe("update query", () => {
  it("owner: organization filter, soft-delete hiding, the id, no assignment rule", () => {
    const q = updateClientQuery(as("owner"), ID, { gradeLevel: "4" }, mock)!.toSQL();
    expect(q.sql).toMatch(/^update "clients"/);
    expect(q.sql).toContain('"organization_id" = $');
    expect(q.sql).toContain('"deleted_at" is null');
    expect(q.sql).not.toContain("client_assignments");
    expect(q.params).toContain(ORG);
    expect(q.params).toContain(ID);
  });

  it("associate: the assignment rule is inside the same statement and compares the clients row being updated", () => {
    const q = updateClientQuery(as("associate"), ID, { gradeLevel: "4" }, mock)!.toSQL();
    expect(q.sql).toContain('from "client_assignments"');
    // Qualified on both sides; an unqualified "organization_id" inside the subquery would bind to client_assignments.
    expect(q.sql).toContain('"client_assignments"."organization_id" = "clients"."organization_id"');
    expect(q.sql).toContain('"client_assignments"."client_id" = "clients"."id"');
    expect(q.sql).toContain('"client_assignments"."deleted_at" is null');
    expect(q.params).toContain(USER);
    expect(q.sql).not.toContain(USER);
  });

  it("the patch cannot touch id, organization or created_at", () => {
    for (const key of ["id", "organizationId", "createdAt"]) {
      expect(() => updateClientQuery(as("owner"), ID, { [key]: "x" } as never, mock)).toThrow(/cannot be updated/);
    }
  });

  it("a malformed id builds no statement", () => {
    expect(() => updateClientQuery(as("owner"), "not-a-uuid", { gradeLevel: "4" }, mock)).toThrow(/UUID/);
  });
});

describe("the routes name the same roles as the permission constants", () => {
  it("POST /api/clients, PATCH and DELETE /api/clients/{id}", async () => {
    const { readFileSync } = await import("node:fs");
    const collection = readFileSync("app/api/clients/route.ts", "utf8");
    const item = readFileSync("app/api/clients/[id]/route.ts", "utf8");
    const rolesOf = (src: string, method: string) => {
      const m = new RegExp(`export const ${method} = guardedRoute[^]*?roles:\\s*(\\[[^\\]]*\\])`).exec(src);
      return JSON.parse(m![1]) as string[];
    };
    expect(rolesOf(collection, "POST")).toEqual([...CLIENT_WRITE_ROLES]);
    expect(rolesOf(item, "PATCH")).toEqual([...CLIENT_WRITE_ROLES]);
    expect(rolesOf(item, "DELETE")).toEqual([...CLIENT_DELETE_ROLES]);
  });
});
