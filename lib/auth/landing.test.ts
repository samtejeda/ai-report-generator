import { describe, expect, it } from "vitest";
import { authPageRedirect, HOME_PATH, MFA_SETUP_PATH, rootRedirect, SIGN_IN_PATH, type Visitor } from "./landing";

const VISITORS: Visitor[] = ["signed_in", "enrolling", "signed_out"];

describe("rootRedirect (/)", () => {
  it("sends a signed-in person to the working home, a half-signed-in one to finish setup, everyone else to sign in", () => {
    expect(rootRedirect("signed_in")).toBe("/clients");
    expect(rootRedirect("enrolling")).toBe("/account/mfa");
    expect(rootRedirect("signed_out")).toBe("/login");
    expect([HOME_PATH, MFA_SETUP_PATH, SIGN_IN_PATH]).toEqual(["/clients", "/account/mfa", "/login"]);
  });

  it("never returns an address with a query or an external target (no ?next=)", () => {
    for (const v of VISITORS) expect(rootRedirect(v)).toMatch(/^\/[a-z/]+$/);
  });
});

describe("authPageRedirect (/login, /forgot-password, /reset-password)", () => {
  it("a signed-in person is sent home from a sign-in page", () => {
    expect(authPageRedirect("signed_in")).toBe("/clients");
    expect(authPageRedirect("signed_in", {})).toBe("/clients");
    expect(authPageRedirect("signed_in", { resetLink: false })).toBe("/clients");
  });

  it("a reset link opened on purpose still works for a signed-in person", () => {
    expect(authPageRedirect("signed_in", { resetLink: true })).toBeNull();
  });

  it("a signed-out person sees the page", () => {
    expect(authPageRedirect("signed_out")).toBeNull();
    expect(authPageRedirect("signed_out", { resetLink: true })).toBeNull();
  });

  it("a password-only (not yet enrolled) session is not trapped away from the sign-in page", () => {
    expect(authPageRedirect("enrolling")).toBeNull();
    expect(authPageRedirect("enrolling", { resetLink: true })).toBeNull();
  });
});
