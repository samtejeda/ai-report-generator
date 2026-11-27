import { describe, expect, it } from "vitest";
import { INITIAL_SETUP, setupReducer, type SetupState } from "./mfa-setup-state";
import { totpQr } from "./totp-qr";

const KEY = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const URI = `otpauth://totp/AI%20Report%20Generator:owner%40example.test?secret=${KEY}&issuer=AI%20Report%20Generator&algorithm=SHA1&digits=6&period=30`;
const CODES = ["aaaa-1111", "bbbb-2222"];

const enabled = (): SetupState =>
  setupReducer(INITIAL_SETUP, { type: "enabled", setupKey: KEY, qr: totpQr(URI), backupCodes: CODES });

describe("the enrollment state: the key and its QR code do not outlive their job", () => {
  it("starts with nothing secret, then holds the key, the QR drawing and the codes for the code step", () => {
    expect(INITIAL_SETUP).toEqual({ step: "password", setupKey: "", qr: null, backupCodes: [] });
    const s = enabled();
    expect(s.step).toBe("code");
    expect(s.setupKey).toBe(KEY);
    expect(s.qr).not.toBeNull();
    expect(s.backupCodes).toEqual(CODES);
  });

  it("drops the key and the QR drawing once the first code is verified, and keeps the backup codes to show", () => {
    const s = setupReducer(enabled(), { type: "verified" });
    expect(s).toEqual({ step: "codes", setupKey: "", qr: null, backupCodes: CODES });
  });

  it("clears the key, the QR drawing and the codes on done", () => {
    const s = setupReducer(setupReducer(enabled(), { type: "verified" }), { type: "done" });
    expect(s).toEqual({ step: "codes", setupKey: "", qr: null, backupCodes: [] });
    // Done also clears them if it is pressed before verify ever ran (nothing secret may remain).
    expect(setupReducer(enabled(), { type: "done" })).toMatchObject({ setupKey: "", qr: null, backupCodes: [] });
  });

  it("goes back to the start, with nothing secret, when the page is hidden at any step", () => {
    for (const s of [INITIAL_SETUP, enabled(), setupReducer(enabled(), { type: "verified" })]) {
      expect(setupReducer(s, { type: "hidden" })).toEqual(INITIAL_SETUP);
    }
  });

  it("never leaves the key or the address anywhere in state once cleared", () => {
    for (const a of [{ type: "verified" }, { type: "done" }, { type: "hidden" }] as const) {
      const json = JSON.stringify(setupReducer(enabled(), a));
      expect(json).not.toContain(KEY);
      expect(json).not.toContain("otpauth");
    }
  });
});
