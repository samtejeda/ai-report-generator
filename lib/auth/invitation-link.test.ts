import { describe, expect, it, vi } from "vitest";
import { callInvitationLinkUsable, tokenForForm, type LinkCheckDeps } from "./invitation-link";
import { hashInvitationToken, newInvitationToken } from "./invitation-token";

function setup(over: Partial<LinkCheckDeps> = {}) {
  const calls: string[] = [];
  const deps: LinkCheckDeps = {
    limit: vi.fn(async () => (calls.push("limit"), { allowed: true as const })),
    usable: vi.fn(async () => (calls.push("usable"), true)),
    log: vi.fn(),
    ...over,
  };
  return { deps, calls };
}

describe("the accept page's link check (tokenForForm)", () => {
  it("a usable link keeps its token for the form; the database is asked about the HASH, never the token", async () => {
    const { deps, calls } = setup();
    const { token } = newInvitationToken();
    expect(await tokenForForm(token, "203.0.113.9", deps)).toBe(token);
    expect(calls).toEqual(["limit", "usable"]);
    expect(deps.usable).toHaveBeenCalledWith(hashInvitationToken(token));
    expect(JSON.stringify(vi.mocked(deps.usable).mock.calls)).not.toContain(token);
    expect(deps.limit).toHaveBeenCalledWith("203.0.113.9");
  });

  it("an unusable link (unknown, used, revoked, expired, replaced and address taken are all `false` to the page) becomes null", async () => {
    const { deps } = setup({ usable: async () => false });
    expect(await tokenForForm(newInvitationToken().token, "203.0.113.9", deps)).toBeNull();
  });

  it.each([undefined, "", "short", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}\n`, "!".repeat(43)])(
    "a missing or malformed token (%j) is null with no count and no lookup",
    async (token) => {
      const { deps, calls } = setup();
      expect(await tokenForForm(token, "203.0.113.9", deps)).toBeNull();
      expect(calls).toEqual([]);
    },
  );

  it("counts the address by bucket (an IPv6 address by its /64, no usable address as one shared bucket)", async () => {
    const { deps } = setup();
    const { token } = newInvitationToken();
    await tokenForForm(token, "2001:db8:0:17::5", deps);
    await tokenForForm(token, undefined, deps);
    expect(vi.mocked(deps.limit).mock.calls.map((c) => c[0])).toEqual(["2001:0db8:0000:0017::/64", "no-trusted-ip"]);
  });

  it("a visitor over the limit gets the form for ANY token, with no lookup: being limited is no oracle", async () => {
    const limit = vi.fn(async () => ({ allowed: false as const, retryAfterSeconds: 300 }));
    for (const usable of [true, false]) {
      const { deps, calls } = setup({ limit, usable: async () => (calls.push("usable"), usable) });
      const { token } = newInvitationToken();
      expect(await tokenForForm(token, "203.0.113.9", deps)).toBe(token);
      expect(calls).toEqual([]);
    }
  });

  it("a failing check falls back to the form and logs the error KIND only (no token, hash or message)", async () => {
    const { token } = newInvitationToken();
    for (const failing of ["limit", "usable"] as const) {
      const boom = async () => {
        throw new TypeError(`database said no about ${token} ${hashInvitationToken(token)}`);
      };
      const { deps } = setup(failing === "limit" ? { limit: boom } : { usable: boom });
      expect(await tokenForForm(token, "203.0.113.9", deps), failing).toBe(token);
      expect(deps.log).toHaveBeenCalledWith("invitation_link_check_failed", { kind: "TypeError" });
      const logged = JSON.stringify(vi.mocked(deps.log).mock.calls);
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(hashInvitationToken(token));
      expect(logged).not.toContain("database said");
    }
  });

  it("logs nothing at all on the ordinary paths", async () => {
    for (const usable of [true, false]) {
      const { deps } = setup({ usable: async () => usable });
      await tokenForForm(newInvitationToken().token, "203.0.113.9", deps);
      expect(deps.log).not.toHaveBeenCalled();
    }
  });
});

describe("callInvitationLinkUsable", () => {
  const dbReturning = (rows: unknown[]) => ({ execute: vi.fn(async () => ({ rows })) }) as never;

  it("returns the function's boolean, and refuses anything else", async () => {
    expect(await callInvitationLinkUsable(dbReturning([{ usable: true }]), "0".repeat(64))).toBe(true);
    expect(await callInvitationLinkUsable(dbReturning([{ usable: false }]), "0".repeat(64))).toBe(false);
    for (const rows of [[], [{ usable: null }], [{ usable: "true" }], [{}]]) {
      await expect(callInvitationLinkUsable(dbReturning(rows), "0".repeat(64))).rejects.toThrow(/unexpected value/);
    }
  });
});
