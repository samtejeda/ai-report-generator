import { describe, expect, it, vi } from "vitest";
import { createGuard, type GuardDeps } from "./guard-core";
import type { SessionContext } from "./session";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "https://app.example.test";

function make(session: SessionContext | null, overrides: Partial<GuardDeps> = {}) {
  const audit = vi.fn(async () => true);
  const resolve = vi.fn(async () => session);
  const guard = createGuard({ resolve, allowedOrigin: () => ORIGIN, audit, ...overrides });
  return { guard, audit, resolve };
}

const as = (role: SessionContext["role"]): SessionContext => ({ userId: USER, organizationId: ORG, role });
const get = (headers: Record<string, string> = {}) => new Request("https://app.example.test/api/x", { headers });
const post = (headers: Record<string, string> = {}) => new Request("https://app.example.test/api/x", { method: "POST", headers });

describe("guardedRoute: identity", () => {
  it("answers 401 with the fixed error shape and never runs the handler without a session", async () => {
    const { guard, audit } = make(null);
    const handler = vi.fn(async () => Response.json({ secret: "client data" }));
    const res = await guard({ roles: ["owner"], resource: "client", handler })(get());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue." } });
    expect(handler).not.toHaveBeenCalled();
    // No session means no known organization, so there is nothing to audit against.
    expect(audit).not.toHaveBeenCalled();
  });

  it("hands the handler the session from the database, never anything from the request", async () => {
    const { guard } = make(as("associate"));
    let seen: unknown;
    const res = await guard({
      roles: ["owner", "associate"],
      resource: "client",
      handler: async ({ session }) => {
        seen = session;
        return Response.json({ ok: true });
      },
    })(get({ "x-organization-id": "99999999-9999-4999-8999-999999999999", "x-role": "owner" }));
    expect(res.status).toBe(200);
    expect(seen).toEqual({ userId: USER, organizationId: ORG, role: "associate" });
  });
});

describe("guardedRoute: role", () => {
  it.each([["admin"], ["associate"]] as const)("%s is refused on an owner-only route with 403, and the denial is audited without PHI", async (role) => {
    const { guard, audit } = make(as(role));
    const handler = vi.fn(async () => Response.json({}));
    const res = await guard({ roles: ["owner"], resource: "client", handler })(get());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
    expect(handler).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      { organizationId: ORG, actorUserId: USER },
      { action: "authz.denied", resourceType: "client", outcome: "denied", metadata: { role, reason: "role_not_allowed" } },
    );
  });

  it("refuses to build a route that allows no role (it would be a route nobody can reach, or a typo)", () => {
    const { guard } = make(as("owner"));
    expect(() => guard({ roles: [], resource: "client", handler: async () => Response.json({}) })).toThrow(/at least one/);
  });
});

describe("guardedRoute: origin (CSRF) on state-changing methods", () => {
  it.each([["POST"], ["PATCH"], ["PUT"], ["DELETE"]])("%s without the app's own origin is 403, before any session lookup", async (method) => {
    const { guard, resolve } = make(as("owner"));
    const handler = vi.fn(async () => Response.json({}));
    const route = guard({ roles: ["owner"], resource: "client", handler });
    const forged: Record<string, string>[] = [{}, { origin: "https://evil.example.test" }, { origin: "null" }, { origin: ORIGIN + ".evil.test" }];
    for (const headers of forged) {
      const res = await route(new Request("https://app.example.test/api/x", { method, headers }));
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("forbidden_origin");
    }
    expect(handler).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("a POST from the app's own origin goes through", async () => {
    const { guard } = make(as("owner"));
    const res = await guard({ roles: ["owner"], resource: "client", handler: async () => Response.json({ ok: 1 }) })(post({ origin: ORIGIN }));
    expect(res.status).toBe(200);
  });

  it("reads are not origin-checked (they change nothing, and browsers omit Origin on same-site GETs)", async () => {
    const { guard } = make(as("owner"));
    const res = await guard({ roles: ["owner"], resource: "client", handler: async () => Response.json({}) })(get());
    expect(res.status).toBe(200);
  });
});

describe("guardedRoute: failures stay opaque", () => {
  it("a throwing handler becomes a fixed 500 with no message, and the log carries no error text", async () => {
    const { guard } = make(as("owner"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await guard({
      roles: ["owner"],
      resource: "client",
      handler: async () => {
        throw new Error("select * from clients where display_name = 'Synthetic Child'");
      },
    })(get());
    expect(res.status).toBe(500);
    const body = JSON.stringify(await res.json());
    expect(body).not.toMatch(/select|Synthetic/);
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).not.toMatch(/select|Synthetic|clients where/);
    expect(logged).toContain("route_error");
    log.mockRestore();
  });

  it("a failing session lookup is a 500, not a pass", async () => {
    const { guard } = make(null, { resolve: async () => Promise.reject(new Error("db down")) });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = vi.fn(async () => Response.json({}));
    const res = await guard({ roles: ["owner"], resource: "client", handler })(get());
    expect(res.status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("every response is private, no-store", async () => {
    const { guard } = make(null);
    const res = await guard({ roles: ["owner"], resource: "client", handler: async () => Response.json({}) })(get());
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("guardedRoute: route parameters", () => {
  it("passes the resolved params to the handler", async () => {
    const { guard } = make(as("owner"));
    let seen: unknown;
    await guard<{ id: string }>({
      roles: ["owner"],
      resource: "client",
      handler: async ({ params }) => {
        seen = params;
        return Response.json({});
      },
    })(get(), { params: Promise.resolve({ id: "abc" }) });
    expect(seen).toEqual({ id: "abc" });
  });
});
