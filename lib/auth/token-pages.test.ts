import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

// The two public pages whose address carries a one-time token (the password reset link and the
// invitation link). A token in a query string must never leave in a Referer header, and the
// invitation page must never put the token or the password anywhere but the one request body.

const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

describe("one-time-token pages send no Referer", () => {
  it.each(["/reset-password", "/accept-invitation"])("%s: Referrer-Policy no-referrer", async (source) => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const own = rules.filter((r) => r.source === source);
    expect(own).toHaveLength(1);
    expect(own[0].headers).toEqual([{ key: "Referrer-Policy", value: "no-referrer" }]);
  });
  it("the catch-all baseline stays the default for everything else", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const all = rules.find((r) => r.source === "/:path*");
    expect(all?.headers).toContainEqual({ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" });
  });
});

describe("the accept-invitation page and form", () => {
  const files = ["app/accept-invitation/page.tsx", "components/auth/accept-invitation-form.tsx"];
  it("never touch storage, cookies or the console, and read no tenant data", () => {
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB|console\./);
      expect(src, f).not.toMatch(/tenantDb|@\/lib\/db/);
    }
  });
  it("the form removes the token from the address bar and ends on a full page load", () => {
    const src = read("components/auth/accept-invitation-form.tsx");
    expect(src).toMatch(/history\.replaceState\(null, "", "\/accept-invitation"\)/);
    expect(src).toMatch(/window\.location\.assign\(INVITED_PATH\)/);
    expect(src).not.toMatch(/router\.(push|replace)/);
  });
  it("the token travels in the request body only, never in a URL", () => {
    const src = read("components/auth/accept-invitation-form.tsx");
    expect(src).toMatch(/callAdminApi\("\/api\/invitations\/accept", "POST", \{ token: heldToken,/);
    expect(src).not.toMatch(/\/api\/invitations\/accept\?/);
  });
  it("the page checks the token's shape before handing it on", () => {
    expect(read("app/accept-invitation/page.tsx")).toMatch(/INVITATION_TOKEN_PATTERN\.test\(token\)/);
  });
});
