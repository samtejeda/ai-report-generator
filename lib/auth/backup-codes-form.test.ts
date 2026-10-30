import { describe, expect, it } from "vitest";
import { BACKUP_CODES_COUNT_NOTE, BACKUP_CODES_SAVE_PROMPT, BACKUP_CODES_WARNING, backupCodesErrorMessage, formatCodesForCopy, validateBackupCodesPassword } from "./backup-codes-form";

describe("backup codes form", () => {
  it("asks for the password before calling the server", () => {
    expect(validateBackupCodesPassword("")).toBe("Enter your current password.");
    expect(validateBackupCodesPassword("x")).toBeNull();
  });

  it("fixed messages, never the server's words", () => {
    expect(backupCodesErrorMessage({ status: 429 })).toMatch(/Too many attempts/);
    expect(backupCodesErrorMessage({ status: 401 })).toMatch(/session ended/);
    expect(backupCodesErrorMessage({ status: 400, code: "INVALID_PASSWORD" })).toBe("Your password is not correct.");
    expect(backupCodesErrorMessage({ status: 500, code: "SOMETHING_ELSE" })).toBe("Could not make new backup codes. Try again.");
    expect(backupCodesErrorMessage(null)).toBe("Could not make new backup codes. Try again.");
  });

  it("says the old codes stop working, that the codes are shown once, and that a count is not available", () => {
    expect(BACKUP_CODES_WARNING).toMatch(/old codes stop working/);
    expect(BACKUP_CODES_SAVE_PROMPT).toMatch(/shown only now/);
    expect(BACKUP_CODES_SAVE_PROMPT).toMatch(/old codes no longer work/);
    expect(BACKUP_CODES_COUNT_NOTE).toMatch(/cannot be shown/);
    expect(BACKUP_CODES_COUNT_NOTE).not.toMatch(/\d/);
  });

  it("copies one code per line and nothing else", () => {
    expect(formatCodesForCopy(["aaaa-bbbb", "cccc-dddd"])).toBe("aaaa-bbbb\ncccc-dddd");
    expect(formatCodesForCopy([])).toBe("");
  });
});
