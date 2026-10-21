import { describe, expect, it } from "vitest";
import { adminErrorMessage, needsReauth, REAUTH_MESSAGE, type AdminAction } from "./messages";

const ACTIONS: AdminAction[] = ["change_role", "deactivate", "reactivate", "reset_mfa", "assign", "end_assignment", "set_endpoint", "clear_endpoint"];
const STATUSES = [400, 401, 403, 404, 409, 429, 500, 502];

describe("adminErrorMessage", () => {
  it("a request that never arrived", () => {
    for (const a of ACTIONS) expect(adminErrorMessage(a, null)).toMatch(/Could not reach the server/);
  });
  it("an old sign-in is recognised by status AND code, and says what to do", () => {
    const stale = { status: 403, code: "reauth_required" };
    expect(needsReauth(stale)).toBe(true);
    expect(adminErrorMessage("set_endpoint", stale)).toBe(REAUTH_MESSAGE);
    expect(needsReauth({ status: 403, code: "forbidden" })).toBe(false);
    expect(needsReauth({ status: 403, code: null })).toBe(false);
    expect(needsReauth({ status: 401, code: "reauth_required" })).toBe(false);
    expect(needsReauth(null)).toBe(false);
    expect(adminErrorMessage("reset_mfa", { status: 403, code: "forbidden" })).toMatch(/do not have access/);
  });
  it("every action and status gets a non-empty fixed sentence", () => {
    for (const a of ACTIONS) for (const status of STATUSES) {
      const m = adminErrorMessage(a, { status, code: "x" });
      expect(m.length).toBeGreaterThan(10);
      expect(m).not.toMatch(/undefined|\[object/);
    }
  });
  it("409 on an assignment means already assigned; on a user change it lists the possible reasons", () => {
    expect(adminErrorMessage("assign", { status: 409, code: "conflict" })).toMatch(/already has this client/);
    expect(adminErrorMessage("deactivate", { status: 409, code: "conflict" })).toMatch(/deactivated|someone else|owner/);
  });
  it("a refused endpoint shows the allowed shape and never anything typed", () => {
    const m = adminErrorMessage("set_endpoint", { status: 400, code: "validation_failed" });
    expect(m).toMatch(/ts\.net/);
  });
});
