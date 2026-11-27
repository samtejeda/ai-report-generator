import { afterEach, describe, expect, it, vi } from "vitest";
import { RATE_LIMITS } from "./config";
import { createResetLinkLimit, isResetLinkRequest, resetLinkLimitKey, RESET_LINK_LIMIT_PATH } from "./reset-link-limit";

// The address-only limit on GET /api/auth/reset-password/{token} (finding F5). The counter here is an
// in-memory stand-in with the same rule as consumeAddressLimit (max requests, then refused); the real
// one, on auth_runtime and the scratch database, is exercised in auth.integration.test.ts.

function counter(max: number) {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    counts,
    limit: async (key: string) => {
      keys.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      if (n > max) return { allowed: false as const, retryAfterSeconds: 600 };
      counts.set(key, n);
      return { allowed: true as const };
    },
  };
}

const link = (token: string, ip?: string, method = "GET") =>
  new Request(`http://localhost:3000/api/auth/reset-password/${token}?callbackURL=/reset-password`, {
    method,
    headers: ip ? { "x-forwarded-for": ip } : {},
  });
const pathOf = (token: string) => `/reset-password/${token}`;

afterEach(() => vi.restoreAllMocks());

describe("which requests are counted", () => {
  it("matches only GET on /reset-password/{token}", () => {
    expect(isResetLinkRequest("GET", "/reset-password/abcDEF123_-")).toBe(true);
    expect(isResetLinkRequest("GET", `/reset-password/${"a".repeat(128)}`)).toBe(true);
  });

  it.each([
    ["GET", "/reset-password"],
    ["GET", "/reset-password/"],
    ["GET", "/reset-password/a/b"],
    ["GET", "/reset-password/tok%41"],
    ["GET", `/reset-password/${"a".repeat(129)}`],
    ["GET", "/reset-passwordX/abc"],
    ["GET", "/verify-email"],
    ["GET", "/sign-in/email"],
    ["POST", "/reset-password/abc"],
    ["POST", "/reset-password"],
    ["HEAD", "/reset-password/abc"],
  ])("does not match %s %s", (method, path) => {
    expect(isResetLinkRequest(method, path)).toBe(false);
  });

  it("passes a request that is not a reset link straight through without touching the counter", async () => {
    const c = counter(5);
    const limit = createResetLinkLimit({ limit: c.limit });
    expect(await limit(link("abc", "203.0.113.1", "POST"), pathOf("abc"))).toBeNull();
    expect(await limit(link("a/b", "203.0.113.1"), "/reset-password/a/b")).toBeNull();
    expect(c.keys).toEqual([]);
  });
});

describe("the key", () => {
  it("is the address bucket and a fixed label, whatever the token", () => {
    const a = resetLinkLimitKey(new Headers({ "x-forwarded-for": "203.0.113.5" }));
    expect(a).toBe(`203.0.113.5|${RESET_LINK_LIMIT_PATH}`);
    expect(a).not.toMatch(/abc|token=|callback/);
  });

  it("groups an IPv6 address by its /64 and uses one shared bucket when there is no usable address", () => {
    expect(resetLinkLimitKey(new Headers({ "x-forwarded-for": "2001:db8:1:2:aaaa::1" }))).toBe(resetLinkLimitKey(new Headers({ "x-forwarded-for": "2001:db8:1:2:bbbb::9" })));
    expect(resetLinkLimitKey(new Headers())).toBe(`no-trusted-ip|${RESET_LINK_LIMIT_PATH}`);
    expect(resetLinkLimitKey(new Headers({ "x-forwarded-for": "not an address" }))).toBe(`no-trusted-ip|${RESET_LINK_LIMIT_PATH}`);
  });

  it("counts the address our proxy appended, so a forged first entry cannot give each request a fresh allowance", () => {
    const keys = ["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((forged) => resetLinkLimitKey(new Headers({ "x-forwarded-for": `${forged}, 203.0.113.5` })));
    expect(new Set(keys)).toEqual(new Set([`203.0.113.5|${RESET_LINK_LIMIT_PATH}`]));
  });

  it("uses the same 5 per 15 minutes as the documented limit", () => {
    expect(RATE_LIMITS.resetLink).toEqual({ window: 15 * 60, max: 5 });
    expect(RATE_LIMITS.resetLink).toEqual(RATE_LIMITS.resetPassword);
  });
});

describe("the limit", () => {
  it("lets five different tokens from one address through and refuses the sixth, whatever the token", async () => {
    const c = counter(5);
    const limit = createResetLinkLimit({ limit: c.limit });
    for (let i = 1; i <= 5; i++) expect(await limit(link(`guess${i}`, "203.0.113.7"), pathOf(`guess${i}`)), `request ${i}`).toBeNull();
    const sixth = await limit(link("guess6", "203.0.113.7"), pathOf("guess6"));
    expect(sixth?.status).toBe(429);
    // Every request used the one key.
    expect(new Set(c.keys).size).toBe(1);
  });

  it("counts the same token like any other, and keeps refusing", async () => {
    const c = counter(5);
    const limit = createResetLinkLimit({ limit: c.limit });
    for (let i = 0; i < 5; i++) expect(await limit(link("same", "203.0.113.8"), pathOf("same"))).toBeNull();
    expect((await limit(link("same", "203.0.113.8"), pathOf("same")))?.status).toBe(429);
    expect((await limit(link("other", "203.0.113.8"), pathOf("other")))?.status).toBe(429);
  });

  it("does not affect another address", async () => {
    const c = counter(5);
    const limit = createResetLinkLimit({ limit: c.limit });
    for (let i = 0; i < 6; i++) await limit(link(`t${i}`, "203.0.113.9"), pathOf(`t${i}`));
    expect((await limit(link("t0", "203.0.113.9"), pathOf("t0")))?.status).toBe(429);
    expect(await limit(link("t0", "203.0.113.10"), pathOf("t0"))).toBeNull();
  });

  it("refuses with Better Auth's own 429: same status, body and X-Retry-After (whole seconds, at least 1)", async () => {
    const limit = createResetLinkLimit({ limit: async () => ({ allowed: false, retryAfterSeconds: 123.2 }) });
    const res = (await limit(link("abc", "203.0.113.11"), pathOf("abc")))!;
    expect(res.status).toBe(429);
    expect(res.statusText).toBe("Too Many Requests");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-retry-after")).toBe("124");
    expect(await res.json()).toEqual({ message: "Too many requests. Please try again later." });
    const tiny = createResetLinkLimit({ limit: async () => ({ allowed: false, retryAfterSeconds: 0 }) });
    expect((await tiny(link("abc", "203.0.113.11"), pathOf("abc")))!.headers.get("x-retry-after")).toBe("1");
  });

  it("fails closed with a fixed 500 when the counter cannot be read, and logs neither token nor address", async () => {
    const lines: string[] = [];
    for (const level of ["error", "warn", "info", "log"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    const limit = createResetLinkLimit({
      limit: async () => {
        throw new Error("connection to 203.0.113.12 failed for token-SECRET-123");
      },
    });
    const res = (await limit(link("token-SECRET-123", "203.0.113.12"), pathOf("token-SECRET-123")))!;
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toMatch(/SECRET|203\.0\.113|connection/);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ event: "route_error", resource: "auth_reset_link_limit", kind: "Error" });
  });

  it("writes no log line at all when it allows or refuses", async () => {
    const lines: string[] = [];
    for (const level of ["error", "warn", "info", "log"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    const c = counter(1);
    const limit = createResetLinkLimit({ limit: c.limit });
    await limit(link("token-SECRET-1", "203.0.113.13"), pathOf("token-SECRET-1"));
    await limit(link("token-SECRET-2", "203.0.113.13"), pathOf("token-SECRET-2"));
    expect(lines).toEqual([]);
  });
});
