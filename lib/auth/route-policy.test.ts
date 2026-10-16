import { describe, expect, it } from "vitest";
import { AUTH_ENDPOINTS, isAllowedAuthRequest } from "./route-policy";

describe("auth route allow-list", () => {
  it.each([
    ["POST", "/sign-in/email"],
    ["POST", "/sign-out"],
    ["POST", "/request-password-reset"],
    ["GET", "/reset-password/abcDEF123_-"],
    ["POST", "/reset-password"],
    ["POST", "/send-verification-email"],
    ["GET", "/verify-email"],
    ["POST", "/change-password"],
  ])("allows %s %s", (method, path) => {
    expect(isAllowedAuthRequest(method, path)).toBe(true);
  });

  it.each([
    ["POST", "/sign-up/email"], // no self sign-up
    ["GET", "/get-session"],
    ["POST", "/get-session"],
    ["GET", "/list-sessions"],
    ["POST", "/revoke-sessions"],
    ["POST", "/revoke-other-sessions"],
    ["POST", "/update-user"],
    ["POST", "/delete-user"],
    ["POST", "/change-email"],
    ["POST", "/link-social"],
    ["POST", "/sign-in/social"],
    ["GET", "/callback/github"],
    ["GET", "/ok"],
    ["GET", "/error"],
    ["GET", "/sign-in/email"], // right path, wrong method
    ["POST", "/verify-email"],
    ["GET", "/reset-password"],
    ["POST", "/reset-password/token"],
    ["GET", "/reset-password/a/b"],
    ["GET", "/reset-password/"],
    ["POST", "/sign-in/email/extra"],
    ["POST", "/sign-in/email/../sign-up/email"],
    ["DELETE", "/sign-out"],
    ["POST", ""],
  ])("refuses %s %s", (method, path) => {
    expect(isAllowedAuthRequest(method, path)).toBe(false);
  });

  it("is the same list API.md documents", async () => {
    const { readFileSync } = await import("node:fs");
    const api = readFileSync("API.md", "utf8");
    for (const e of AUTH_ENDPOINTS) expect(api, `${e.method} ${e.label}`).toContain(`/api/auth${e.label}`);
  });
});
