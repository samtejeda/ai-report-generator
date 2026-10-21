import { describe, expect, it } from "vitest";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./config";
import { changePasswordErrorMessage, validatePasswordChange } from "./password-form";

const good = "correct horse battery staple 1";
const next = "a different long passphrase 2";

describe("validatePasswordChange", () => {
  it("accepts a fine change", () => {
    expect(validatePasswordChange(good, next, next)).toBeNull();
  });
  it("accepts exactly the minimum and the maximum length", () => {
    expect(validatePasswordChange(good, "x".repeat(PASSWORD_MIN_LENGTH), "x".repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(validatePasswordChange(good, "y".repeat(PASSWORD_MAX_LENGTH), "y".repeat(PASSWORD_MAX_LENGTH))).toBeNull();
  });
  it.each([
    ["no current password", "", next, next],
    ["too short", good, "x".repeat(PASSWORD_MIN_LENGTH - 1), "x".repeat(PASSWORD_MIN_LENGTH - 1)],
    ["too long", good, "y".repeat(PASSWORD_MAX_LENGTH + 1), "y".repeat(PASSWORD_MAX_LENGTH + 1)],
    ["confirmation differs", good, next, next + "!"],
    ["same as current", good, good, good],
  ])("refuses %s", (_label, c, n, f) => {
    expect(validatePasswordChange(c, n, f)).toEqual(expect.any(String));
  });
  it("never repeats a password in its message", () => {
    for (const m of [validatePasswordChange(good, "short", "short"), validatePasswordChange(good, next, "other other other")]) {
      expect(m).not.toContain(good);
      expect(m).not.toContain(next);
    }
  });
});

describe("changePasswordErrorMessage", () => {
  it("maps what the server can say to fixed messages", () => {
    expect(changePasswordErrorMessage(null)).toBeNull();
    expect(changePasswordErrorMessage({ status: 429 })).toMatch(/too many/i);
    expect(changePasswordErrorMessage({ status: 401 })).toMatch(/session ended/i);
    expect(changePasswordErrorMessage({ status: 400, code: "INVALID_PASSWORD" })).toMatch(/current password/i);
    expect(changePasswordErrorMessage({ status: 400, code: "PASSWORD_TOO_SHORT" })).toMatch(String(PASSWORD_MIN_LENGTH));
    expect(changePasswordErrorMessage({ status: 500, code: "ANYTHING", message: "secret detail" } as never)).not.toContain("secret");
  });
});
