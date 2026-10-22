import { describe, expect, it } from "vitest";
import { USER_ROLES } from "@/lib/db/schema/users";
import { checkUserChange } from "@/lib/auth/user-rules";
import { userActionsFor, type ListedUser } from "./user-actions";

const owner = { userId: "o1", role: "owner" as const };
const person = (role: ListedUser["role"], over: Partial<ListedUser> = {}): ListedUser => ({ id: `p-${role}`, role, active: true, mfaEnabled: true, ...over });

describe("userActionsFor (the owner's users screen)", () => {
  it("offers nothing for oneself", () => {
    expect(userActionsFor(owner, { id: "o1", role: "owner", active: true, mfaEnabled: true })).toEqual({
      isSelf: true, changeRole: false, deactivate: false, reactivate: false, resetMfa: false,
    });
  });
  it("an active associate or admin: role, deactivate and authenticator reset", () => {
    for (const role of ["associate", "admin"] as const) {
      expect(userActionsFor(owner, person(role))).toEqual({ isSelf: false, changeRole: true, deactivate: true, reactivate: false, resetMfa: true });
    }
  });
  it("another owner: role and deactivate, but never an authenticator reset (break-glass script only)", () => {
    expect(userActionsFor(owner, person("owner"))).toEqual({ isSelf: false, changeRole: true, deactivate: true, reactivate: false, resetMfa: false });
  });
  it("a deactivated person: reactivate only", () => {
    for (const role of USER_ROLES) {
      expect(userActionsFor(owner, person(role, { active: false }))).toEqual({ isSelf: false, changeRole: false, deactivate: false, reactivate: true, resetMfa: false });
    }
  });
  it("no authenticator reset when none is enrolled", () => {
    expect(userActionsFor(owner, person("associate", { mfaEnabled: false })).resetMfa).toBe(false);
  });
  it("never offers what the server rule refuses, for every actor, target and state", () => {
    for (const actorRole of USER_ROLES) {
      for (const targetRole of USER_ROLES) {
        for (const active of [true, false]) {
          const actor = { userId: "a", role: actorRole };
          const target = { id: "t", role: targetRole, active, mfaEnabled: true };
          const a = userActionsFor(actor, target);
          const t = { id: "t", role: targetRole };
          if (a.changeRole) expect(checkUserChange(actor, t, { kind: "role", to: targetRole })).toBe("ok");
          if (a.deactivate) expect(checkUserChange(actor, t, { kind: "deactivate" })).toBe("ok");
          if (a.reactivate) expect(checkUserChange(actor, t, { kind: "reactivate" })).toBe("ok");
          if (a.resetMfa) expect(checkUserChange(actor, t, { kind: "reset_mfa" })).toBe("ok");
        }
      }
    }
  });
  it("an associate is offered nothing at all", () => {
    for (const role of USER_ROLES) {
      const a = userActionsFor({ userId: "a", role: "associate" }, person(role));
      expect([a.changeRole, a.deactivate, a.reactivate, a.resetMfa]).toEqual([false, false, false, false]);
    }
  });
});
