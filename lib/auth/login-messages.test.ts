import { describe, expect, it } from "vitest";
import { codeErrorMessage, codeStepExpired, signInErrorMessage, SIGN_OUT_FAILED, TOO_MANY_ATTEMPTS } from "./login-messages";

describe("signInErrorMessage", () => {
  it("no error, no message", () => expect(signInErrorMessage(null)).toBeNull());
  it("a wrong password and an unknown address look the same", () => {
    expect(signInErrorMessage({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD" })).toBe("Email or password is incorrect.");
    expect(signInErrorMessage({ status: 401 })).toBe("Email or password is incorrect.");
  });
  it("rate limit, unverified address and anything else", () => {
    expect(signInErrorMessage({ status: 429 })).toBe(TOO_MANY_ATTEMPTS);
    expect(signInErrorMessage({ status: 403, code: "EMAIL_NOT_VERIFIED" })).toMatch(/Verify your email/);
    expect(signInErrorMessage({ status: 500 })).toBe("Could not sign in. Try again.");
  });
});

describe("the code step", () => {
  it("is over when the challenge expired or was spent on too many wrong codes", () => {
    expect(codeStepExpired({ code: "INVALID_TWO_FACTOR_COOKIE" })).toBe(true);
    expect(codeStepExpired({ code: "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" })).toBe(true);
    expect(codeStepExpired({ status: 401, code: "INVALID_CODE" })).toBe(false);
    expect(codeStepExpired({ status: 429 })).toBe(false);
    expect(codeStepExpired(null)).toBe(false);
  });
  it("an expired step says to enter the password again; a wrong code says try again", () => {
    expect(codeErrorMessage({ code: "INVALID_TWO_FACTOR_COOKIE" })).toBe("That sign-in expired. Enter your password again.");
    expect(codeErrorMessage({ status: 401, code: "INVALID_CODE" })).toBe("That code is not right. Try again.");
    expect(codeErrorMessage({ status: 429 })).toBe(TOO_MANY_ATTEMPTS);
    expect(codeErrorMessage(null)).toBeNull();
  });
});

describe("sign-out", () => {
  it("a failed sign-out has its own fixed sentence", () => expect(SIGN_OUT_FAILED).toBe("Could not sign out. Try again."));
});
