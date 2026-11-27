import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIp, parseForwardedEntry, resolveClientIp, withResolvedClientIp } from "./client-ip";
import { RESOLVED_CLIENT_IP_HEADER } from "./config";
import { getTrustedProxyHops } from "@/lib/env";

// The client address is the entry our own proxies appended, counted from the right. Everything the caller
// put to its left is theirs and is ignored.

const xff = (value: string) => new Headers({ "x-forwarded-for": value });

afterEach(() => vi.unstubAllEnvs());

describe("resolveClientIp: the entry our proxy appended", () => {
  it("ignores a forged first entry behind one trusted hop", () => {
    expect(resolveClientIp(xff("6.6.6.6, 203.0.113.5"), 1)).toBe("203.0.113.5");
    expect(resolveClientIp(xff("6.6.6.6, 7.7.7.7, 8.8.8.8, 203.0.113.5"), 1)).toBe("203.0.113.5");
  });

  it("a single entry is the client", () => {
    expect(resolveClientIp(xff("203.0.113.5"), 1)).toBe("203.0.113.5");
  });

  it("no header, or no headers object, is no address", () => {
    expect(resolveClientIp(new Headers(), 1)).toBeUndefined();
    expect(resolveClientIp(null, 1)).toBeUndefined();
    expect(resolveClientIp(undefined, 1)).toBeUndefined();
    expect(resolveClientIp(xff(""), 1)).toBeUndefined();
  });

  it("zero hops never reads the header, whatever it holds", () => {
    expect(resolveClientIp(xff("203.0.113.5"), 0)).toBeUndefined();
    expect(resolveClientIp(xff("6.6.6.6, 203.0.113.5"), 0)).toBeUndefined();
  });

  it("two hops: the entry second from the end (a CDN, then the load balancer)", () => {
    expect(resolveClientIp(xff("6.6.6.6, 203.0.113.5, 198.51.100.9"), 2)).toBe("203.0.113.5");
    expect(resolveClientIp(xff("203.0.113.5, 198.51.100.9"), 2)).toBe("203.0.113.5");
  });

  it("fewer entries than hops means the request skipped a proxy of ours: no address", () => {
    expect(resolveClientIp(xff("203.0.113.5"), 2)).toBeUndefined();
    expect(resolveClientIp(xff("203.0.113.5, 198.51.100.9"), 3)).toBeUndefined();
  });

  it("a hop count that is not a whole number of at least 1 is no address", () => {
    for (const hops of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(resolveClientIp(xff("203.0.113.5"), hops)).toBeUndefined();
  });

  it("whitespace around entries is trimmed", () => {
    expect(resolveClientIp(xff("  6.6.6.6 ,\t203.0.113.5  "), 1)).toBe("203.0.113.5");
  });

  it("an empty or junk entry in the counted place is no address, never a fall back to an earlier entry", () => {
    expect(resolveClientIp(xff("203.0.113.5,"), 1)).toBeUndefined();
    expect(resolveClientIp(xff("203.0.113.5, ,"), 1)).toBeUndefined();
    expect(resolveClientIp(xff("203.0.113.5, unknown"), 1)).toBeUndefined();
    expect(resolveClientIp(xff("203.0.113.5, 999.1.1.1"), 1)).toBeUndefined();
    expect(resolveClientIp(xff("203.0.113.5, 1.2.3.4 5.6.7.8"), 1)).toBeUndefined();
  });

  it("an empty entry to the left does not shift which entry is ours", () => {
    expect(resolveClientIp(xff(",203.0.113.5"), 1)).toBe("203.0.113.5");
    expect(resolveClientIp(xff("1.1.1.1,,203.0.113.5,198.51.100.9"), 2)).toBe("203.0.113.5");
  });

  it("a header over 2 KB is refused whole", () => {
    expect(resolveClientIp(xff(`${"6.6.6.6, ".repeat(300)}203.0.113.5`), 1)).toBeUndefined();
  });

  it("several header lines are joined by the platform and read as one list", () => {
    const headers = new Headers();
    headers.append("x-forwarded-for", "6.6.6.6");
    headers.append("x-forwarded-for", "203.0.113.5");
    expect(resolveClientIp(headers, 1)).toBe("203.0.113.5");
  });
});

describe("parseForwardedEntry: address forms", () => {
  it.each([
    ["203.0.113.5", "203.0.113.5"],
    ["203.0.113.5:49152", "203.0.113.5"],
    ["2001:db8::1", "2001:db8::1"],
    ["2001:DB8:0:0:0:0:0:1", "2001:DB8:0:0:0:0:0:1"],
    ["[2001:db8::1]", "2001:db8::1"],
    ["[2001:db8::1]:443", "2001:db8::1"],
    ["::ffff:203.0.113.5", "::ffff:203.0.113.5"],
    ["::1", "::1"],
  ])("%s gives %s", (entry, expected) => expect(parseForwardedEntry(entry)).toBe(expected));

  it.each([
    "", " ", "unknown", "_hidden", "203.0.113", "203.0.113.5.6", "256.1.1.1", "203.0.113.5:", "203.0.113.5:port", "203.0.113.5:99999999",
    "2001:db8::1:443:extra:zz", "[2001:db8::1", "2001:db8::1]", "[203.0.113.5]:80x", "fe80::1%eth0", "[fe80::1%25eth0]", "<script>", "1.2.3.4/32",
  ])("%j is not an address", (entry) => expect(parseForwardedEntry(entry)).toBeUndefined());
});

describe("clientIp: the deployment's hop count", () => {
  it("reads TRUSTED_PROXY_HOPS on every call", () => {
    const h = xff("6.6.6.6, 203.0.113.5");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    expect(clientIp(h)).toBe("203.0.113.5");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    expect(clientIp(h)).toBeUndefined();
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    expect(clientIp(h)).toBe("6.6.6.6");
  });

  it("unset means 0: the header is not trusted", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", undefined);
    expect(getTrustedProxyHops()).toBe(0);
    expect(clientIp(xff("203.0.113.5"))).toBeUndefined();
  });

  it.each(["-1", "4", "1.5", "two", "NaN"])("a bad value (%s) fails, naming the variable and not the value", (value) => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", value);
    expect(() => getTrustedProxyHops()).toThrow(/TRUSTED_PROXY_HOPS/);
    expect(() => getTrustedProxyHops()).toThrow(expect.objectContaining({ message: expect.not.stringContaining(value) }));
  });
});

describe("withResolvedClientIp: what Better Auth is shown", () => {
  const req = (headers: Record<string, string>, init: RequestInit = {}) =>
    new Request("http://localhost:3000/api/auth/sign-in/email", { method: "POST", body: "{}", ...init, headers });

  it("sets the private header from the trusted entry, not the forged one", () => {
    const out = withResolvedClientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.5" }));
    expect(out.headers.get(RESOLVED_CLIENT_IP_HEADER)).toBe("203.0.113.5");
  });

  it("removes a private header the caller sent, whatever else happens", () => {
    const forged = { [RESOLVED_CLIENT_IP_HEADER]: "6.6.6.6" };
    expect(withResolvedClientIp(req({ ...forged, "x-forwarded-for": "6.6.6.6, 203.0.113.5" })).headers.get(RESOLVED_CLIENT_IP_HEADER)).toBe("203.0.113.5");
    expect(withResolvedClientIp(req(forged)).headers.has(RESOLVED_CLIENT_IP_HEADER)).toBe(false);
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    expect(withResolvedClientIp(req({ ...forged, "x-forwarded-for": "203.0.113.5" })).headers.has(RESOLVED_CLIENT_IP_HEADER)).toBe(false);
  });

  it("carries the method, url, other headers and body through", async () => {
    const out = withResolvedClientIp(req({ "x-forwarded-for": "203.0.113.5", "content-type": "application/json", origin: "http://localhost:3000" }, { body: '{"a":1}' }));
    expect(out.method).toBe("POST");
    expect(out.url).toBe("http://localhost:3000/api/auth/sign-in/email");
    expect(out.headers.get("content-type")).toBe("application/json");
    expect(out.headers.get("origin")).toBe("http://localhost:3000");
    expect(await out.text()).toBe('{"a":1}');
  });

  it("leaves the caller's own x-forwarded-for untouched (audit and limits read it with the hop rule)", () => {
    const out = withResolvedClientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.5" }));
    expect(out.headers.get("x-forwarded-for")).toBe("6.6.6.6, 203.0.113.5");
  });

  it("works for a GET with no body", () => {
    const out = withResolvedClientIp(new Request("http://localhost:3000/api/auth/get-session", { headers: { "x-forwarded-for": "203.0.113.5" } }));
    expect(out.method).toBe("GET");
    expect(out.headers.get(RESOLVED_CLIENT_IP_HEADER)).toBe("203.0.113.5");
  });
});
