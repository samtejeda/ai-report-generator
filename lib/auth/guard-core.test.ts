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

const NOW = new Date("2026-10-20T12:00:00.000Z");
const as = (role: SessionContext["role"], signedInAt: Date = NOW): SessionContext => ({ userId: USER, organizationId: ORG, role, signedInAt });
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
    expect(seen).toEqual(as("associate"));
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

  it("lets Next.js control-flow errors (they carry a digest) through instead of turning them into a 500", async () => {
    const signal = Object.assign(new Error("Dynamic server usage"), { digest: "DYNAMIC_SERVER_USAGE" });
    const { guard } = make(null, { resolve: async () => Promise.reject(signal) });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(guard({ roles: ["owner"], resource: "client", handler: async () => Response.json({}) })(get())).rejects.toBe(signal);
    expect(log).not.toHaveBeenCalled();
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

describe("guardedRoute: fresh sign-in on sensitive routes", () => {
  const at = (secondsAgo: number) => as("owner", new Date(NOW.getTime() - secondsAgo * 1000));
  const sensitive = (handler = vi.fn(async () => Response.json({ done: true }))) => ({
    options: { roles: ["owner"] as const, resource: "organization", fresh: true, handler },
    handler,
  });
  const withClock = (session: SessionContext | null) => make(session, { now: () => NOW, freshSeconds: 300 });

  it("lets a sign-in from a moment ago through", async () => {
    const { guard } = withClock(at(10));
    const { options, handler } = sensitive();
    const res = await guard(options)(get());
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("accepts exactly the limit and refuses one second past it", async () => {
    const ok = withClock(at(300));
    expect((await ok.guard(sensitive().options)(get())).status).toBe(200);
    const stale = withClock(at(301));
    const { options, handler } = sensitive();
    const res = await stale.guard(options)(get());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "reauth_required", message: "Sign in again to do this." } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a sign-in dated in the future (a clock or data problem is not a fresh sign-in)", async () => {
    const { guard } = withClock(at(-60));
    const { options, handler } = sensitive();
    expect((await guard(options)(get())).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("audits the refusal with the reason and the role only", async () => {
    const { guard, audit } = withClock(at(4000));
    await guard(sensitive().options)(get());
    expect(audit).toHaveBeenCalledWith(
      { organizationId: ORG, actorUserId: USER },
      { action: "authz.denied", resourceType: "organization", outcome: "denied", metadata: { role: "owner", reason: "sign_in_not_recent" } },
    );
  });

  it("checks the role first: a role that may not call the route is told 403 forbidden, not about freshness", async () => {
    const { guard, audit } = withClock(as("admin", new Date(NOW.getTime() - 4000 * 1000)));
    const res = await guard(sensitive().options)(get());
    expect((await res.json()).error.code).toBe("forbidden");
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]).toEqual([expect.anything(), expect.objectContaining({ metadata: { role: "admin", reason: "role_not_allowed" } })]);
  });

  it("a route that is not marked fresh ignores how old the sign-in is", async () => {
    const { guard } = withClock(at(100_000));
    const res = await guard({ roles: ["owner"], resource: "organization", handler: async () => Response.json({}) })(get());
    expect(res.status).toBe(200);
  });

  it("the default limit is the 5 minutes in lib/auth/config.ts", async () => {
    const { guard } = make(at(299), { now: () => NOW });
    expect((await guard(sensitive().options)(get())).status).toBe(200);
    const stale = make(at(301), { now: () => NOW });
    expect((await stale.guard(sensitive().options)(get())).status).toBe(403);
  });
});
