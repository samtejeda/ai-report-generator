import { describe, expect, it } from "vitest";
import { adminErrorMessage, needsReauth, REAUTH_MESSAGE, type AdminAction } from "./messages";

const ACTIONS: AdminAction[] = ["change_role", "deactivate", "reactivate", "reset_mfa", "assign", "end_assignment", "set_endpoint", "clear_endpoint", "invite", "resend_invitation", "revoke_invitation"];
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
  it("an invitation 429 quotes the wait up to an hour, not the 15 minute auth cap", () => {
    expect(adminErrorMessage("invite", { status: 429, code: "rate_limited", retryAfterSeconds: 2400 })).toBe("Too many attempts. Try again in about 40 minutes.");
    expect(adminErrorMessage("resend_invitation", { status: 429, code: "rate_limited", retryAfterSeconds: 3600 })).toMatch(/about 60 minutes/);
    expect(adminErrorMessage("invite", { status: 429, code: "rate_limited", retryAfterSeconds: 99_999 })).toMatch(/about 60 minutes/);
    expect(adminErrorMessage("invite", { status: 429, code: "rate_limited", retryAfterSeconds: 5 })).toMatch(/about 1 minute\./);
    expect(adminErrorMessage("invite", { status: 429, code: "rate_limited" })).toMatch(/Too many invitations/);
    expect(adminErrorMessage("assign", { status: 429, code: "rate_limited", retryAfterSeconds: 2400 })).toMatch(/few minutes/);
  });
  it("invitation wording: 400 asks for an address, 404 and 409 point at the list, and a stale sign-in is the usual guidance", () => {
    expect(adminErrorMessage("invite", { status: 400, code: "validation_failed" })).toBe("Enter a valid email address.");
    expect(adminErrorMessage("revoke_invitation", { status: 404, code: "not_found" })).toMatch(/invitation could not be found/);
    expect(adminErrorMessage("resend_invitation", { status: 409, code: "conflict" })).toMatch(/already accepted or revoked/);
    expect(adminErrorMessage("invite", { status: 403, code: "reauth_required" })).toBe(REAUTH_MESSAGE);
  });
});
