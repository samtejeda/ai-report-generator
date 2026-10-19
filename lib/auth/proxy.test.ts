import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "../../proxy";
import { isPublicPath, PUBLIC_API, PUBLIC_PAGES } from "./public-surface";

const req = (path: string, cookie?: string) =>
  new NextRequest(`https://app.example.test${path}`, { headers: cookie ? { cookie } : {} });
const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

describe("public surface", () => {
  it("lists the pages and endpoints that need no session, each with a reason", () => {
    expect(PUBLIC_PAGES.map((p) => p.path)).toEqual(["/", "/login", "/forgot-password", "/reset-password"]);
    expect(PUBLIC_API.map((a) => a.path)).toEqual(["/api/health", "/api/auth"]);
    for (const entry of [...PUBLIC_PAGES, ...PUBLIC_API]) expect(entry.reason.length, entry.path).toBeGreaterThan(20);
  });

  it.each(["/", "/login", "/login/", "/forgot-password", "/reset-password", "/api/health", "/api/auth", "/api/auth/sign-in/email"])("%s is public", (p) => {
    expect(isPublicPath(p)).toBe(true);
  });

  it.each([
    "/loginx", "/login/x", "/login/..", "/Login", "/api/authx", "/api/auth-x", "/api/health/x", "/api/healthz",
    "/clients", "/account", "/account/mfa", "/api/me", "/api/clients", "/api/clients/1", "//login", "/%6Cogin", "",
  ])("%s is not public", (p) => {
    expect(isPublicPath(p)).toBe(false);
  });
});

describe("proxy (a convenience, never the gate)", () => {
  it("sends a signed-out visitor to /login with a real 307, and adds no ?next parameter", () => {
    const res = proxy(req("/clients"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.example.test/login");
    for (const path of ["/account", "/account/mfa", "/anything/else", "/clients/123"]) {
      expect(proxy(req(path)).status, path).toBe(307);
    }
  });

  it("answers an unauthenticated API call 401 in the standard error shape, not a redirect", async () => {
    for (const path of ["/api/me", "/api/clients", "/api/clients/33333333-3333-4333-8333-333333333333", "/api"]) {
      const res = proxy(req(path));
      expect(res.status, path).toBe(401);
      expect(await res.json()).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue." } });
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("lets public paths through without a cookie", () => {
    for (const path of ["/", "/login", "/forgot-password", "/reset-password", "/api/health", "/api/auth/sign-in/email"]) {
      expect(passes(proxy(req(path))), path).toBe(true);
    }
  });

  it("lets a request with a session cookie through (the page or handler decides if it is valid)", () => {
    expect(passes(proxy(req("/clients", "rg.session_token=abc.def")))).toBe(true);
    expect(passes(proxy(req("/api/clients", "x=1; __Secure-rg.session_token=abc.def")))).toBe(true);
  });

  it("does not accept look-alike cookies as a session", () => {
    for (const cookie of ["better-auth.session_token=x", "rg.session_data=x", "rg.two_factor=x", "session_token=x", "xrg.session_token=x"]) {
      expect(proxy(req("/clients", cookie)).status, cookie).toBe(307);
    }
  });

  it("an empty or garbage cookie value still only reaches the page-level check, which refuses it", () => {
    // The proxy checks presence only. Rejecting a forged value is requireSession's job and is
    // tested against the real database in the route-level integration tests.
    expect(passes(proxy(req("/clients", "rg.session_token=")))).toBe(true);
  });
});
