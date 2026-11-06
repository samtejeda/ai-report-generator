import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashInvitationToken, INVITATION_TOKEN_PATTERN, newInvitationToken } from "./invitation-token";

describe("invitation token", () => {
  it("is 256 random bits as 43 base64url characters, and its hash is the SHA-256 in hex", () => {
    const { token, hash } = newInvitationToken();
    expect(token).toMatch(INVITATION_TOKEN_PATTERN);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hashInvitationToken(token)).toBe(hash);
  });

  it("never repeats, and the hash does not contain the token", () => {
    const made = Array.from({ length: 200 }, () => newInvitationToken());
    expect(new Set(made.map((m) => m.token)).size).toBe(200);
    expect(new Set(made.map((m) => m.hash)).size).toBe(200);
    for (const m of made) expect(m.hash).not.toContain(m.token);
  });

  it("the pattern refuses anything that is not exactly 43 URL-safe characters", () => {
    for (const bad of ["", "short", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}+`, `${"a".repeat(42)} `, `${"a".repeat(42)}\n`]) {
      expect(INVITATION_TOKEN_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
