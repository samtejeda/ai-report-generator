import { describe, expect, it } from "vitest";
import { INVITE_CREATED_MESSAGE, INVITE_RESENT_MESSAGE, invitationActionsFor, STATUS_LABEL, validateInviteEmail, type InvitationStatus } from "./invitation-view";

describe("invitationActionsFor", () => {
  it("offers Resend and Revoke on pending and expired, nothing on accepted or revoked", () => {
    expect(invitationActionsFor("pending")).toEqual({ resend: true, revoke: true });
    expect(invitationActionsFor("expired")).toEqual({ resend: true, revoke: true });
    expect(invitationActionsFor("accepted")).toEqual({ resend: false, revoke: false });
    expect(invitationActionsFor("revoked")).toEqual({ resend: false, revoke: false });
  });
});

describe("labels and messages", () => {
  it("every status has a label", () => {
    const all: InvitationStatus[] = ["pending", "accepted", "expired", "revoked"];
    for (const s of all) expect(STATUS_LABEL[s].length).toBeGreaterThan(3);
  });
  it("the success messages never say the mail was sent for sure, and never repeat an address", () => {
    expect(INVITE_CREATED_MESSAGE).toMatch(/If the address can receive it/);
    expect(INVITE_RESENT_MESSAGE).toMatch(/if the address can receive it/);
    for (const m of [INVITE_CREATED_MESSAGE, INVITE_RESENT_MESSAGE]) expect(m).not.toMatch(/@/);
  });
  it("only an empty address is stopped on the screen; the server judges the rest", () => {
    expect(validateInviteEmail("")).not.toBeNull();
    expect(validateInviteEmail("   ")).not.toBeNull();
    expect(validateInviteEmail("not-an-address")).toBeNull();
    expect(validateInviteEmail("a@example.com")).toBeNull();
  });
});
