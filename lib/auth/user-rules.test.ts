import { describe, expect, it } from "vitest";
import type { UserRole } from "@/lib/db/schema/users";
import { canManageUsers, checkUserChange, type UserChange } from "./user-rules";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ROLES: UserRole[] = ["owner", "associate", "admin"];
const CHANGES: UserChange[] = [
  { kind: "role", to: "owner" },
  { kind: "role", to: "admin" },
  { kind: "role", to: "associate" },
  { kind: "deactivate" },
  { kind: "reactivate" },
];
const label = (c: UserChange) => (c.kind === "role" ? `role→${c.to}` : c.kind);

describe("who may manage users", () => {
  it("only owner and admin", () => {
    expect(ROLES.filter(canManageUsers)).toEqual(["owner", "admin"]);
  });

  it("an associate may change nobody, whatever the target and the change", () => {
    for (const target of ROLES) for (const c of CHANGES) expect(checkUserChange({ userId: ME, role: "associate" }, { id: OTHER, role: target }, c)).toBe("not_allowed");
  });

  it("an unknown role is refused (deny by default)", () => {
    const stranger = { userId: ME, role: "visitor" as unknown as UserRole };
    expect(checkUserChange(stranger, { id: OTHER, role: "associate" }, { kind: "deactivate" })).toBe("not_allowed");
  });
});

describe("nobody changes themselves", () => {
  it.each(ROLES.filter(canManageUsers))("%s cannot change their own role or deactivate themselves", (role) => {
    for (const c of CHANGES) expect(checkUserChange({ userId: ME, role }, { id: ME, role }, c), label(c)).toBe("self");
  });
});

describe("admin: never touches an owner, never makes one", () => {
  const admin = { userId: ME, role: "admin" as const };
  it.each(CHANGES.map((c) => [label(c), c] as const))("%s on an owner is refused", (_l, c) => {
    expect(checkUserChange(admin, { id: OTHER, role: "owner" }, c)).toBe("admin_cannot_touch_owner");
  });
  it("making anyone an owner is refused", () => {
    for (const target of ["associate", "admin"] as const) expect(checkUserChange(admin, { id: OTHER, role: target }, { kind: "role", to: "owner" })).toBe("admin_cannot_grant_owner");
  });
  it("everything else about associates and fellow admins is allowed", () => {
    for (const target of ["associate", "admin"] as const) {
      for (const c of CHANGES.filter((x) => !(x.kind === "role" && x.to === "owner"))) expect(checkUserChange(admin, { id: OTHER, role: target }, c), `${target} ${label(c)}`).toBe("ok");
    }
  });
});

describe("owner: anything else in the practice", () => {
  const owner = { userId: ME, role: "owner" as const };
  it("may change, promote, demote, deactivate and reactivate anyone but themselves, owners included", () => {
    for (const target of ROLES) for (const c of CHANGES) expect(checkUserChange(owner, { id: OTHER, role: target }, c), `${target} ${label(c)}`).toBe("ok");
  });
});
