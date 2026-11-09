import { describe, expect, it } from "vitest";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./config";
import { ACCEPT_RETRY_MESSAGE, acceptOutcome, INVALID_LINK_MESSAGE, NAME_MAX_LENGTH, validateAcceptForm } from "./invitation-accept-form";

const PW = "x".repeat(PASSWORD_MIN_LENGTH);

describe("validateAcceptForm", () => {
  it("accepts a name and a matching password of allowed length", () => {
    expect(validateAcceptForm("Test Associate", PW, PW)).toBeNull();
    expect(validateAcceptForm("  Padded  ", "x".repeat(PASSWORD_MAX_LENGTH), "x".repeat(PASSWORD_MAX_LENGTH))).toBeNull();
  });
  it("refuses an empty or blank name, one over 200 after trimming, and control characters", () => {
    expect(validateAcceptForm("", PW, PW)).toMatch(/Enter your name/);
    expect(validateAcceptForm("   ", PW, PW)).toMatch(/Enter your name/);
    expect(validateAcceptForm("a".repeat(NAME_MAX_LENGTH), PW, PW)).toBeNull();
    expect(validateAcceptForm("a".repeat(NAME_MAX_LENGTH + 1), PW, PW)).toMatch(/at most 200/);
    expect(validateAcceptForm(`a${"\u0007"}b`, PW, PW)).toMatch(/not allowed/);
    expect(validateAcceptForm(`a${"\n"}b`, PW, PW)).toMatch(/not allowed/);
  });
  it("refuses a short, long or unmatched password, and the wording never contains what was typed", () => {
    expect(validateAcceptForm("A", PW.slice(1), PW.slice(1))).toMatch(/at least 12/);
    expect(validateAcceptForm("A", "x".repeat(PASSWORD_MAX_LENGTH + 1), "x".repeat(PASSWORD_MAX_LENGTH + 1))).toMatch(/at most 128/);
    expect(validateAcceptForm("A", PW, `${PW}y`)).toMatch(/do not match/);
    const typed = "Zebra-Secret-Pass-9";
    for (const m of [validateAcceptForm("Zed Name", typed.slice(0, 5), typed), validateAcceptForm("Zed Name", typed, "other")]) {
      expect(m).not.toContain("Zebra");
      expect(m).not.toContain("Zed");
    }
  });
  it("checks the name before the password, so one problem is shown at a time", () => {
    expect(validateAcceptForm("", "", "")).toMatch(/name/);
  });
});

describe("acceptOutcome", () => {
  it("one generic message for an unusable link, and it ends the form", () => {
    expect(acceptOutcome({ status: 400, code: "invalid_invitation" })).toEqual({ kind: "invalid_link", message: INVALID_LINK_MESSAGE });
    expect(INVALID_LINK_MESSAGE).not.toMatch(/expired|revoked|used|already|account/i);
  });
  it("a refused body keeps the form (a weak password must not look like a bad link)", () => {
    expect(acceptOutcome({ status: 400, code: "validation_failed" })).toEqual({ kind: "retry", message: ACCEPT_RETRY_MESSAGE });
    expect(acceptOutcome({ status: 400, code: null }).kind).toBe("retry");
  });
  it("a 429 quotes the wait (15 minute window) and keeps the form", () => {
    expect(acceptOutcome({ status: 429, code: "rate_limited", retryAfterSeconds: 400 })).toEqual({ kind: "retry", message: "Too many attempts. Try again in about 7 minutes." });
    expect(acceptOutcome({ status: 429, code: "rate_limited", retryAfterSeconds: 99_999 }).message).toMatch(/about 15 minutes/);
    expect(acceptOutcome({ status: 429, code: "rate_limited" }).message).toMatch(/Wait a few minutes/);
  });
  it("no network and unexpected statuses keep the form with a fixed sentence", () => {
    expect(acceptOutcome(null)).toEqual({ kind: "retry", message: "Could not reach the server. Try again." });
    for (const status of [401, 403, 404, 500, 502]) expect(acceptOutcome({ status, code: "x" })).toEqual({ kind: "retry", message: "Something went wrong. Try again." });
  });
});
