import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";
import type { SessionContext } from "@/lib/auth/session";
import { canReachClinicalContent, seesEveryClient } from "@/lib/auth/permissions";
import { clampPage, getClient, getClientQuery, listClients, listClientsQuery, MAX_OFFSET, MAX_PAGE_SIZE, visibilityFilter } from "./client-access";

// Real queries built without a connection; the tests read the SQL. Behavior against a real
// database, with two organizations and three roles, is in the route-level integration tests.
const mock = drizzle.mock({ schema });
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";
const as = (role: SessionContext["role"]): SessionContext => ({ userId: USER, organizationId: ORG, role, signedInAt: new Date("2026-10-20T12:00:00Z") });

describe("permission matrix", () => {
  it("owner and associate reach clinical content; admin does not (option A, 2026-10-19)", () => {
    expect(canReachClinicalContent("owner")).toBe(true);
    expect(canReachClinicalContent("associate")).toBe(true);
    expect(canReachClinicalContent("admin")).toBe(false);
  });

  it("only the owner sees every client", () => {
    expect(seesEveryClient("owner")).toBe(true);
    expect(seesEveryClient("associate")).toBe(false);
    expect(seesEveryClient("admin")).toBe(false);
  });

  it("an unknown role gets no access (the default is deny)", () => {
    expect(canReachClinicalContent("superuser" as never)).toBe(false);
    expect(visibilityFilter(as("superuser" as never))).toBeNull();
  });
});

describe("list query per role", () => {
  it("owner: the organization filter, soft-delete hiding, no assignment join", () => {
    const q = listClientsQuery(as("owner"), {}, mock)!.toSQL();
    expect(q.sql).toContain('"clients"."organization_id" = $1');
    expect(q.params[0]).toBe(ORG);
    expect(q.sql).toContain('"clients"."deleted_at" is null');
    expect(q.sql).not.toContain("client_assignments");
  });

  it("associate: also limited to active assignments for this user, in this organization", () => {
    const q = listClientsQuery(as("associate"), {}, mock)!.toSQL();
    expect(q.sql).toContain('"clients"."organization_id" = $1');
    expect(q.sql).toContain('from "client_assignments"');
    expect(q.sql).toContain('"client_assignments"."organization_id" = "clients"."organization_id"');
    expect(q.sql).toContain('"client_assignments"."client_id" = "clients"."id"');
    expect(q.sql).toContain('"client_assignments"."deleted_at" is null');
    // The user id is a bound parameter, never spliced into the text.
    expect(q.params).toContain(USER);
    expect(q.sql).not.toContain(USER);
  });

  it("admin: no query is built at all", () => {
    expect(listClientsQuery(as("admin"), {}, mock)).toBeNull();
    expect(getClientQuery(as("admin"), ID, mock)).toBeNull();
  });

  it("is ordered newest first with a stable tiebreak", () => {
    const q = listClientsQuery(as("owner"), {}, mock)!.toSQL();
    expect(q.sql).toMatch(/order by "clients"."created_at" desc, "clients"."id" desc/);
  });
});

describe("single client query", () => {
  it("ANDs the id with the same visibility rule, so an id alone never selects a row", () => {
    const owner = getClientQuery(as("owner"), ID, mock)!.toSQL();
    expect(owner.sql).toContain('"clients"."organization_id" = $1');
    expect(owner.sql).toContain('"clients"."id" = $');
    expect(owner.params).toContain(ID);

    const associate = getClientQuery(as("associate"), ID, mock)!.toSQL();
    expect(associate.sql).toContain('"clients"."id" = $');
    expect(associate.sql).toContain('from "client_assignments"');
    expect(associate.params).toContain(ID);
    expect(associate.params).toContain(USER);
  });

  it("a malformed id builds no query", () => {
    for (const bad of ["not-a-uuid", "' or 1=1 --", "", "33333333-3333-4333-8333-33333333333"]) {
      expect(getClientQuery(as("owner"), bad, mock), bad).toBeNull();
    }
  });
});

describe("paging is clamped", () => {
  it("never above the cap, never below one, offset bounded", () => {
    expect(clampPage({ limit: 1_000_000, offset: 99_999_999 })).toEqual({ limit: MAX_PAGE_SIZE, offset: MAX_OFFSET });
    expect(clampPage({ limit: 0, offset: -5 })).toEqual({ limit: 1, offset: 0 });
    expect(clampPage({ limit: Number.NaN, offset: Number.NaN })).toEqual({ limit: 50, offset: 0 });
    expect(clampPage({})).toEqual({ limit: 50, offset: 0 });
  });

  it("shows up in the SQL as bound parameters", () => {
    const q = listClientsQuery(as("owner"), { limit: 5_000, offset: 1_000_000 }, mock)!.toSQL();
    expect(q.params).toContain(MAX_PAGE_SIZE);
    expect(q.params).toContain(MAX_OFFSET);
    expect(q.params).not.toContain(5_000);
    expect(q.params).not.toContain(1_000_000);
  });
});

describe("failing closed", () => {
  it("a malformed user id throws instead of building SQL from it", () => {
    expect(() => visibilityFilter({ ...as("associate"), userId: "' or 1=1 --" })).toThrow();
  });

  it("the async functions return nothing for admin without touching a database", async () => {
    expect(await listClients(as("admin"), {}, undefined)).toEqual([]);
    expect(await getClient(as("admin"), ID, undefined)).toBeUndefined();
    expect(await getClient(as("owner"), "not-a-uuid", undefined)).toBeUndefined();
  });
});
