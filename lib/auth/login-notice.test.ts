import { describe, expect, it } from "vitest";
import { INVITED_NOTICE, INVITED_PATH, loginNotice } from "./login-notice";

describe("loginNotice", () => {
  it("shows the sentence for the flag the accept page sets, and nothing for anything else", () => {
    expect(loginNotice("1")).toBe(INVITED_NOTICE);
    for (const v of [undefined, "", "0", "true", "yes", ["1"], ["1", "1"]]) expect(loginNotice(v as string | string[] | undefined)).toBeNull();
  });
  it("the address carries a fixed flag and nothing else", () => {
    expect(INVITED_PATH).toBe("/login?invited=1");
  });
  it("the sentence repeats nothing typed and names the next step", () => {
    expect(INVITED_NOTICE).toMatch(/Sign in now/);
    expect(INVITED_NOTICE).not.toMatch(/@/);
  });
});
