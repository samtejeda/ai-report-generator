import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { QUIET_ZONE_MODULES, totpQr } from "./totp-qr";

// A synthetic address in the shape Better Auth returns. The key is made up.
const URI =
  "otpauth://totp/AI%20Report%20Generator:owner%40example.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=AI%20Report%20Generator&algorithm=SHA1&digits=6&period=30";

/** Reads the svg path back into a grid of dark squares (the inverse of what totpQr writes). */
function gridOf(qr: { size: number; path: string }): boolean[][] {
  const grid = Array.from({ length: qr.size }, () => Array<boolean>(qr.size).fill(false));
  const runs = [...qr.path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)];
  expect(runs.map((r) => r[0]).join("")).toBe(qr.path); // nothing in the path but runs
  for (const [, x, y, w, back] of runs) {
    expect(back).toBe(w);
    for (let i = 0; i < Number(w); i++) grid[Number(y)][Number(x) + i] = true;
  }
  return grid;
}

describe("totpQr", () => {
  it("is the same every time for the same address, and different for another", () => {
    const a = totpQr(URI);
    expect(a).not.toBeNull();
    expect(totpQr(URI)).toEqual(a);
    expect(totpQr(URI.replace("JBSW", "KBSW"))?.path).not.toBe(a?.path);
  });

  it("pins the output for a known address (a change to the drawing is a deliberate one; this exact drawing was read back by Apple's CoreImage QR detector on 2026-11-27)", () => {
    const qr = totpQr(URI)!;
    expect(qr.size).toBe(61); // version 9 (53 squares) plus a 4-square quiet zone on each side
    expect(createHash("sha256").update(qr.path).digest("hex")).toBe("9887aab62555b263f1bf068fa1eea73307b55dfd42ca60138f97d6136cdd867a");
  });

  it("draws the three finder patterns in the corners and leaves the quiet zone light", () => {
    const qr = totpQr(URI)!;
    const g = gridOf(qr);
    const q = QUIET_ZONE_MODULES;
    const last = qr.size - q - 7; // first column or row of the right and bottom finder patterns
    for (const [ox, oy] of [
      [q, q],
      [last, q],
      [q, last],
    ]) {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3)); // 3 outer, 2 light ring, 0 to 1 centre
          expect(g[oy + dy][ox + dx], `finder at ${ox},${oy} square ${dx},${dy}`).toBe(ring !== 2);
        }
      }
    }
    // No dark square in the quiet zone, on any side.
    for (let i = 0; i < qr.size; i++) {
      for (let k = 0; k < q; k++) {
        expect(g[k][i] || g[qr.size - 1 - k][i] || g[i][k] || g[i][qr.size - 1 - k]).toBe(false);
      }
    }
  });

  it("is only squares of one svg path: no markup, no address, no key in the output", () => {
    const qr = totpQr(URI)!;
    expect(qr.path).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
    expect(JSON.stringify(qr)).not.toContain("JBSW");
    expect(JSON.stringify(qr)).not.toContain("otpauth");
  });

  it("refuses anything that is not an authenticator setup address", () => {
    for (const bad of [
      "",
      "not a url",
      "https://example.test/?secret=JBSWY3DPEHPK3PXP",
      "http://totp/x?secret=JBSWY3DPEHPK3PXP",
      "javascript:alert(1)",
      "otpauth://hotp/Label?secret=JBSWY3DPEHPK3PXP",
      "otpauth://totp/Label", // no key
      "otpauth://totp/Label?secret=", // empty key
      "otpauth-lookalike://totp/Label?secret=JBSWY3DPEHPK3PXP",
    ]) {
      expect(totpQr(bad), bad).toBeNull();
    }
  });

  it("never throws, and answers null, for odd or very long input", () => {
    const longLabel = "x".repeat(5000);
    expect(() => totpQr(`otpauth://totp/${longLabel}?secret=JBSWY3DPEHPK3PXP`)).not.toThrow();
    expect(totpQr(`otpauth://totp/${longLabel}?secret=JBSWY3DPEHPK3PXP`)).toBeNull();
    // Over the scannable size but under the length guard: refused by the encoder, still no throw.
    const mid = `otpauth://totp/${"y".repeat(400)}?secret=JBSWY3DPEHPK3PXP`;
    expect(() => totpQr(mid)).not.toThrow();
    expect(totpQr(mid)).toBeNull();
    for (const odd of [undefined, null, 42, {}, []]) {
      expect(() => totpQr(odd as unknown as string)).not.toThrow();
      expect(totpQr(odd as unknown as string)).toBeNull();
    }
    expect(() => totpQr("otpauth://totp/é\u0000😀?secret=JBSWY3DPEHPK3PXP")).not.toThrow();
  });
});
