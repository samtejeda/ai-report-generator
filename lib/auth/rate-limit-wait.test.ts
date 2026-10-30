import { describe, expect, it } from "vitest";
import { backupCodesErrorMessage } from "./backup-codes-form";
import { codeErrorMessage, signInErrorMessage } from "./login-messages";
import { changePasswordErrorMessage } from "./password-form";
import { captureWait, MAX_WAIT_MINUTES, TOO_MANY_ATTEMPTS, tooManyAttemptsMessage, waitSecondsFromHeader } from "./rate-limit-wait";

describe("waitSecondsFromHeader", () => {
  it("reads whole seconds only", () => {
    expect(waitSecondsFromHeader("120")).toBe(120);
    expect(waitSecondsFromHeader(" 45 ")).toBe(45);
    expect(waitSecondsFromHeader("0")).toBe(0);
  });
  it.each([null, undefined, "", " ", "abc", "-5", "1.5", "12s", "Wed, 21 Oct 2026 07:28:00 GMT", "1234567890", "0x10"])("treats %j as missing", (value) => {
    expect(waitSecondsFromHeader(value)).toBeNull();
  });
});

describe("tooManyAttemptsMessage", () => {
  it.each([
    [0, 1],
    [1, 1],
    [59, 1],
    [60, 1],
    [61, 2],
    [120, 2],
    [121, 3],
    [840, 14],
    [841, 15],
    [900, 15],
    [901, 15],
    [99999, 15],
  ])("%i seconds -> about %i minute(s), rounded up, at least 1, at most 15", (seconds, minutes) => {
    expect(tooManyAttemptsMessage(seconds)).toBe(`Too many attempts. Try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`);
  });

  it("keeps the generic text when there is no usable wait", () => {
    expect(tooManyAttemptsMessage(null)).toBe(TOO_MANY_ATTEMPTS);
    expect(tooManyAttemptsMessage(Number.NaN)).toBe(TOO_MANY_ATTEMPTS);
    expect(tooManyAttemptsMessage(-3)).toBe(TOO_MANY_ATTEMPTS);
  });
  it("a form can keep its own generic text as the fallback", () => {
    expect(tooManyAttemptsMessage(null, "Too many requests. Wait a few minutes and try again.")).toBe("Too many requests. Wait a few minutes and try again.");
  });
  it("never quotes more than the rate-limit window", () => {
    expect(MAX_WAIT_MINUTES).toBe(15);
  });
});

describe("captureWait", () => {
  const context = (header: string | null) => ({ response: { headers: { get: (name: string) => (name === "x-retry-after" ? header : null) } } });

  it("is null until a failure delivers the header", () => {
    expect(captureWait().seconds()).toBeNull();
  });
  it("keeps the seconds from the failed response", () => {
    const wait = captureWait();
    wait.fetchOptions.onError(context("185"));
    expect(wait.seconds()).toBe(185);
  });
  it("a failure without the header leaves it null", () => {
    const wait = captureWait();
    wait.fetchOptions.onError(context(null));
    expect(wait.seconds()).toBeNull();
  });
  it("each capture is separate, so one call's wait cannot leak into the next", () => {
    const first = captureWait();
    const second = captureWait();
    first.fetchOptions.onError(context("60"));
    expect(second.seconds()).toBeNull();
  });
});

describe("every auth message function quotes the wait on a 429 and only on a 429", () => {
  const e429 = { status: 429 };
  const wait = "Too many attempts. Try again in about 3 minutes.";

  it("sign-in", () => {
    expect(signInErrorMessage(e429, 150)).toBe(wait);
    expect(signInErrorMessage(e429)).toBe(TOO_MANY_ATTEMPTS);
    expect(signInErrorMessage({ status: 401 }, 150)).toBe("Email or password is incorrect.");
  });
  it("code step", () => {
    expect(codeErrorMessage(e429, 150)).toBe(wait);
    expect(codeErrorMessage(e429, null)).toBe(TOO_MANY_ATTEMPTS);
    expect(codeErrorMessage({ status: 400 }, 150)).toBe("That code is not right. Try again.");
  });
  it("backup codes", () => {
    expect(backupCodesErrorMessage(e429, 150)).toBe(wait);
    expect(backupCodesErrorMessage(e429)).toBe(TOO_MANY_ATTEMPTS);
    expect(backupCodesErrorMessage({ status: 400, code: "INVALID_PASSWORD" }, 150)).toBe("Your password is not correct.");
  });
  it("change password", () => {
    expect(changePasswordErrorMessage(e429, 150)).toBe(wait);
    expect(changePasswordErrorMessage(e429)).toBe(TOO_MANY_ATTEMPTS);
    expect(changePasswordErrorMessage({ status: 401 }, 150)).toBe("Your session ended. Sign in again.");
  });
});
