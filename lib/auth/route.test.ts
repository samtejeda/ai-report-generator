import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/auth/[...all]/route";

// The route's two collaborators, replaced: the address limit on the reset link (tested in
// reset-link-limit.test.ts, and for real in auth.integration.test.ts) and Better Auth itself.
const mocks = vi.hoisted(() => ({ limitResetLink: vi.fn(), authHandler: vi.fn() }));
vi.mock("@/lib/auth/reset-link-guard", () => ({ limitResetLink: mocks.limitResetLink }));
vi.mock("@/lib/auth/server", () => ({ getAuth: () => ({ handler: mocks.authHandler }) }));

beforeEach(() => {
  mocks.limitResetLink.mockReset().mockResolvedValue(null);
  mocks.authHandler.mockReset().mockResolvedValue(new Response("from better auth", { status: 200 }));
});

// Requests outside the allow-list are answered before Better Auth (and so before any
// environment or database) is touched.
const call = (method: "GET" | "POST", path: string) =>
  (method === "GET" ? GET : POST)(new Request(`http://localhost:3000/api/auth${path}`, { method }));

describe("/api/auth route", () => {
  it.each([
    ["POST", "/sign-up/email"],
    ["GET", "/get-session"],
    ["GET", "/list-sessions"],
    ["POST", "/update-user"],
    ["POST", "/two-factor/disable"],
    ["POST", "/two-factor/get-totp-uri"],
    ["POST", "/two-factor/send-otp"],
    ["POST", "/two-factor/verify-otp"],
    ["GET", "/ok"],
    ["GET", "/"],
  ] as const)("answers 404 with a generic body for %s %s", async (method, path) => {
    const res = await call(method, path);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
  });

  it("hands an allowed request to the reset-link address limit first, and a refusal never reaches Better Auth", async () => {
    mocks.limitResetLink.mockResolvedValueOnce(new Response("{}", { status: 429 }));
    const refused = await call("GET", "/reset-password/some-token");
    expect(refused.status).toBe(429);
    expect(mocks.limitResetLink).toHaveBeenCalledTimes(1);
    expect(mocks.limitResetLink.mock.calls[0][1]).toBe("/reset-password/some-token");
    expect(mocks.authHandler).not.toHaveBeenCalled();

    const allowed = await call("GET", "/reset-password/another-token");
    expect(allowed.status).toBe(200);
    expect(mocks.authHandler).toHaveBeenCalledTimes(1);
  });

  it("shows Better Auth the address our proxy appended in a private header, and drops one the caller sent", async () => {
    await POST(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.5", "x-resolved-client-ip": "9.9.9.9" },
      }),
    );
    expect(mocks.authHandler).toHaveBeenCalledTimes(1);
    const seen = mocks.authHandler.mock.calls[0][0] as Request;
    expect(seen.headers.get("x-resolved-client-ip")).toBe("203.0.113.5");

    mocks.authHandler.mockClear();
    await POST(new Request("http://localhost:3000/api/auth/sign-in/email", { method: "POST", headers: { "x-resolved-client-ip": "9.9.9.9" } }));
    expect((mocks.authHandler.mock.calls[0][0] as Request).headers.has("x-resolved-client-ip")).toBe(false);
  });

  it("answers 404 for a path outside the allow-list without consulting the limit or Better Auth", async () => {
    expect((await call("GET", "/reset-password/a/b")).status).toBe(404);
    expect(mocks.limitResetLink).not.toHaveBeenCalled();
    expect(mocks.authHandler).not.toHaveBeenCalled();
  });

  it("exports only GET and POST, so every other method is 405", async () => {
    const mod = await import("@/app/api/auth/[...all]/route");
    expect(Object.keys(mod).sort()).toEqual(["GET", "POST"]);
  });
});
