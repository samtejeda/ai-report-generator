import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { BASE, ENABLED, startHarness, type Handler, type Person } from "./integration-harness";

// The admin routes (feat/auth-admin) end to end: the REAL route modules, the REAL Better Auth
// instance (every caller holds a cookie from a real password + authenticator sign-in), and the REAL
// auth_runtime / app_runtime roles with row-level security, on the scratch database (the Neon
// `test` branch locally, the CI-only project in CI). Nothing is mocked. Synthetic data only.
//
// Needs the TEST_* variables (see lib/auth/integration-harness.ts); skipped when absent.
vi.setConfig({ testTimeout: 120_000 });

describe.skipIf(!ENABLED)("admin routes through the real stack", () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let endpointRoute: { GET: Handler; PUT: Handler };
  let usersRoute: { GET: Handler };
  let userRoute: { PATCH: Handler };
  let deactivateRoute: { POST: Handler };
  let reactivateRoute: { POST: Handler };
  let meRoute: { GET: Handler };

  let orgA: string;
  let orgB: string;
  let ownerA: Person, adminA: Person, assocA: Person, subject1: Person, subject2: Person, ownerA2: Person;
  let ownerB: Person, adminB: Person, assocB: Person;

  const GOOD = "https://studio-mac.tail1234.ts.net/v1";
  const GOOD_B = "https://office-pc.tail9999.ts.net";

  const readEndpoint = async (orgId: string) => {
    const [row] = await h.owner.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    return row.inferenceEndpoint;
  };
  const putEndpoint = (who: Person, body: unknown, o: { origin?: string | null; headers?: Record<string, string>; rawBody?: string } = {}) =>
    h.call(who, endpointRoute.PUT, { method: "PUT", path: "/api/admin/inference-endpoint", body, ...o });
  const getEndpoint = (who: Person) => h.call(who, endpointRoute.GET, { path: "/api/admin/inference-endpoint" });
  const auditRows = (orgId: string, action: string) =>
    h.owner.select().from(schema.auditLog).where(and(eq(schema.auditLog.organizationId, orgId), eq(schema.auditLog.action, action)));

  beforeAll(async () => {
    h = await startHarness({ appRole: "app_runtime_admin", authRole: "auth_runtime_admin", secret: "admin-test-secret-".padEnd(48, "x") });
    endpointRoute = (await import("@/app/api/admin/inference-endpoint/route")) as unknown as { GET: Handler; PUT: Handler };
    usersRoute = (await import("@/app/api/admin/users/route")) as unknown as { GET: Handler };
    userRoute = (await import("@/app/api/admin/users/[id]/route")) as unknown as { PATCH: Handler };
    deactivateRoute = (await import("@/app/api/admin/users/[id]/deactivate/route")) as unknown as { POST: Handler };
    reactivateRoute = (await import("@/app/api/admin/users/[id]/reactivate/route")) as unknown as { POST: Handler };
    meRoute = (await import("@/app/api/me/route")) as unknown as { GET: Handler };

    orgA = await h.seedOrg("admin-A");
    orgB = await h.seedOrg("admin-B");
    [ownerA, adminA, assocA, subject1, subject2, ownerA2, ownerB, adminB, assocB] = await Promise.all([
      h.makePerson(orgA, "owner-a", "owner"),
      h.makePerson(orgA, "admin-a", "admin"),
      h.makePerson(orgA, "assoc-a", "associate"),
      h.makePerson(orgA, "subject-1", "associate"),
      h.makePerson(orgA, "subject-2", "associate"),
      h.makePerson(orgA, "owner-a2", "owner"),
      h.makePerson(orgB, "owner-b", "owner"),
      h.makePerson(orgB, "admin-b", "admin"),
      h.makePerson(orgB, "assoc-b", "associate"),
    ]);
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
  });

  // ---------------------------------------------------------------------------------------
  describe("inference endpoint (audit 04 item 8)", () => {
    it("no session is 401, and nothing changes", async () => {
      const nobody = { label: "nobody", orgId: "none" };
      expect((await h.call(nobody, endpointRoute.GET, { path: "/api/admin/inference-endpoint" })).status).toBe(401);
      expect((await h.call(nobody, endpointRoute.PUT, { method: "PUT", path: "/api/admin/inference-endpoint", body: { endpoint: GOOD } })).status).toBe(401);
      expect(await readEndpoint(orgA)).toBeNull();
    });

    it("the owner, signed in just now, sets the endpoint; it is stored and audited without the URL", async () => {
      await h.signedInAgo(ownerA, 5);
      const r = await putEndpoint(ownerA, { endpoint: GOOD });
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ data: { inferenceEndpoint: GOOD } });
      expect(r.headers.get("cache-control")).toBe("private, no-store");
      expect(await readEndpoint(orgA)).toBe(GOOD);

      const rows = await auditRows(orgA, "org.inference_endpoint_set");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorUserId: ownerA.userId, resourceType: "organization", resourceId: orgA, outcome: "success", metadata: { reason: "set" } });
      expect(JSON.stringify(rows[0])).not.toContain("ts.net");
    });

    it("owner and admin can read it; the associate cannot", async () => {
      const own = await getEndpoint(ownerA);
      expect(own.status).toBe(200);
      expect(own.json).toEqual({ data: { inferenceEndpoint: GOOD } });
      expect((await getEndpoint(adminA)).json).toEqual({ data: { inferenceEndpoint: GOOD } });
      const refused = await getEndpoint(assocA);
      expect(refused.status).toBe(403);
      expect(refused.json.error?.code).toBe("forbidden");
      expect(refused.text).not.toContain("ts.net");
    });

    it("admin and associate cannot change it: 403, audited with role and reason only, endpoint unchanged", async () => {
      for (const who of [adminA, assocA]) {
        const r = await putEndpoint(who, { endpoint: GOOD_B });
        expect(r.status, who.label).toBe(403);
        expect(r.json.error?.code).toBe("forbidden");
      }
      expect(await readEndpoint(orgA)).toBe(GOOD);
      const denied = (await auditRows(orgA, "authz.denied")).filter((x) => x.resourceType === "organization");
      expect(denied.map((d) => d.actorUserId).sort()).toEqual([adminA.userId, assocA.userId, assocA.userId].sort());
      expect(denied.every((d) => d.outcome === "denied")).toBe(true);
      expect(JSON.stringify(denied)).not.toContain("ts.net");
    });

    it.each([
      ["plain http", "http://studio-mac.tail1234.ts.net/v1"],
      ["localhost", "http://localhost:11434/v1"],
      ["loopback", "https://127.0.0.1"],
      ["cloud metadata address", "http://169.254.169.254/latest/meta-data"],
      ["suffix attack", "https://studio-mac.tail1234.ts.net.evil.example"],
      ["suffix as a path", "https://evil.example/.ts.net"],
      ["user info trick", "https://evil.example@studio-mac.tail1234.ts.net"],
      ["upper case", "https://Studio-Mac.tail1234.ts.net"],
      ["punycode", "https://xn--studio.tail1234.ts.net"],
      ["other port", "https://studio-mac.tail1234.ts.net:11434"],
      ["other path", "https://studio-mac.tail1234.ts.net/admin"],
      ["query string", "https://studio-mac.tail1234.ts.net/v1?x=1"],
      ["empty", ""],
    ])("refuses %s with a 400 that does not echo the value, and nothing changes", async (_label, value) => {
      await h.signedInAgo(ownerA, 5);
      const r = await putEndpoint(ownerA, { endpoint: value });
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ error: { code: "validation_failed", message: "The request is not valid." } });
      if (value) expect(r.text).not.toContain(value);
      expect(await readEndpoint(orgA)).toBe(GOOD);
    });

    it.each([
      ["not JSON", { rawBody: "endpoint=https://a.b.ts.net" }],
      ["an empty body", { rawBody: "" }],
      ["an array", { body: [GOOD_B] }],
      ["a missing field", { body: {} }],
      ["a number", { body: { endpoint: 5 } }],
      ["an undeclared field", { body: { endpoint: GOOD_B, organizationId: "00000000-0000-4000-8000-000000000000" } }],
      ["an organization id naming the other practice", { body: { endpoint: GOOD_B, organization_id: "x" } }],
      ["a very large body", { rawBody: JSON.stringify({ endpoint: "https://" + "a".repeat(5000) + ".b.ts.net" }) }],
    ])("refuses %s with a 400", async (_label, input) => {
      await h.signedInAgo(ownerA, 5);
      const r = await putEndpoint(ownerA, (input as { body?: unknown }).body, { rawBody: (input as { rawBody?: string }).rawBody });
      expect(r.status).toBe(400);
      expect(await readEndpoint(orgA)).toBe(GOOD);
    });

    it("a stale sign-in is 403 reauth_required, audited, and nothing changes; a read still works", async () => {
      await h.signedInAgo(ownerA, 10 * 60);
      const r = await putEndpoint(ownerA, { endpoint: GOOD_B });
      expect(r.status).toBe(403);
      expect(r.json).toEqual({ error: { code: "reauth_required", message: "Sign in again to do this." } });
      expect(await readEndpoint(orgA)).toBe(GOOD);
      const denied = await auditRows(orgA, "authz.denied");
      expect(denied.some((d) => d.actorUserId === ownerA.userId && (d.metadata as { reason?: string }).reason === "sign_in_not_recent")).toBe(true);
      expect((await getEndpoint(ownerA)).status).toBe(200);
      // Signing in again (a new session) makes it work again.
      await h.signedInAgo(ownerA, 5);
      expect((await putEndpoint(ownerA, { endpoint: GOOD })).status).toBe(200);
    });

    it("a cross-site or missing Origin is 403 even for a fresh owner", async () => {
      await h.signedInAgo(ownerA, 5);
      for (const origin of ["https://evil.example", "null", "http://localhost:3001", null]) {
        const r = await putEndpoint(ownerA, { endpoint: GOOD_B }, { origin });
        expect(r.status, String(origin)).toBe(403);
        expect(r.json.error?.code).toBe("forbidden_origin");
      }
      expect(await readEndpoint(orgA)).toBe(GOOD);
      expect((await putEndpoint(ownerA, { endpoint: GOOD }, { origin: BASE })).status).toBe(200);
    });

    it("cross-tenant: practice B's owner changes only practice B; practice A cannot be reached by id, body or header", async () => {
      await h.signedInAgo(ownerB, 5);
      const spoof = { "x-organization-id": orgA, "x-org-id": orgA };
      const r = await putEndpoint(ownerB, { endpoint: GOOD_B }, { headers: spoof });
      expect(r.status).toBe(200);
      expect(await readEndpoint(orgB)).toBe(GOOD_B);
      expect(await readEndpoint(orgA)).toBe(GOOD);
      // Each practice reads only its own value.
      expect((await getEndpoint(ownerA)).json).toEqual({ data: { inferenceEndpoint: GOOD } });
      expect((await getEndpoint(ownerB)).json).toEqual({ data: { inferenceEndpoint: GOOD_B }});
      expect((await getEndpoint(adminB)).json).toEqual({ data: { inferenceEndpoint: GOOD_B } });
      // Practice B's admin cannot change it; A's value is still untouched.
      expect((await putEndpoint(adminB, { endpoint: GOOD })).status).toBe(403);
      expect(await readEndpoint(orgA)).toBe(GOOD);
      // No audit row of A's names B and vice versa.
      expect((await auditRows(orgB, "org.inference_endpoint_set")).every((x) => x.organizationId === orgB && x.resourceId === orgB)).toBe(true);
    });

    it("the owner can clear it; audited as cleared", async () => {
      await h.signedInAgo(ownerA, 5);
      const r = await putEndpoint(ownerA, { endpoint: null });
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ data: { inferenceEndpoint: null } });
      expect(await readEndpoint(orgA)).toBeNull();
      const rows = await auditRows(orgA, "org.inference_endpoint_set");
      expect(rows.some((x) => (x.metadata as { reason?: string }).reason === "cleared")).toBe(true);
      expect(await readEndpoint(orgB)).toBe(GOOD_B);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("user management (owner and admin)", () => {
    type Who = Pick<Person, "label" | "orgId"> & { cookie?: string };
    const list = (who: Who, qs = "") => h.call(who, usersRoute.GET, { path: `/api/admin/users${qs}` });
    const patch = (who: Who, id: string, body: unknown, o: { origin?: string | null; rawBody?: string } = {}) =>
      h.call(who, userRoute.PATCH, { method: "PATCH", path: `/api/admin/users/${id}`, body, params: { id }, ...o });
    const deactivate = (who: Who, id: string) => h.call(who, deactivateRoute.POST, { method: "POST", path: `/api/admin/users/${id}/deactivate`, params: { id } });
    const reactivate = (who: Who, id: string) => h.call(who, reactivateRoute.POST, { method: "POST", path: `/api/admin/users/${id}/reactivate`, params: { id } });
    const me = (who: Who) => h.call(who, meRoute.GET, { path: "/api/me" });
    const dbUser = async (id: string) => (await h.owner.select().from(schema.users).where(eq(schema.users.id, id)))[0];
    const ids = (r: { json: { data?: unknown } }) => (r.json.data as { id: string }[]).map((u) => u.id).sort();
    const userAudit = (orgId: string, action: string, targetId?: string) =>
      auditRows(orgId, action).then((rows) => rows.filter((x) => !targetId || x.resourceId === targetId));
    const MISSING = "00000000-0000-4000-8000-00000000dead";

    it("no session is 401; an associate is 403 and audited; both without any user data", async () => {
      const nobody = { label: "nobody", orgId: "none" };
      expect((await list(nobody)).status).toBe(401);
      expect((await patch(nobody, subject1.userId, { role: "admin" })).status).toBe(401);
      expect((await deactivate(nobody, subject1.userId)).status).toBe(401);
      for (const r of [await list(assocA), await patch(assocA, subject1.userId, { role: "admin" }), await deactivate(assocA, subject1.userId), await reactivate(assocA, subject1.userId)]) {
        expect(r.status).toBe(403);
        expect(r.json.error?.code).toBe("forbidden");
        expect(r.text).not.toContain("example.test");
      }
      expect((await dbUser(subject1.userId)).role).toBe("associate");
      const denied = (await auditRows(orgA, "authz.denied")).filter((x) => x.resourceType === "user" && x.actorUserId === assocA.userId);
      expect(denied).toHaveLength(4);
    });

    it("the owner and the admin list exactly their own practice, deactivated people included, with allow-listed fields only", async () => {
      const expected = [ownerA, adminA, assocA, subject1, subject2, ownerA2].map((p) => p.userId).sort();
      for (const who of [ownerA, adminA]) {
        const r = await list(who);
        expect(r.status, who.label).toBe(200);
        expect(ids(r)).toEqual(expected);
        for (const u of r.json.data as Record<string, unknown>[]) {
          expect(Object.keys(u).sort()).toEqual(["active", "createdAt", "displayName", "email", "id", "mfaEnabled", "role"]);
          expect(u.mfaEnabled).toBe(true);
        }
        expect(r.headers.get("cache-control")).toBe("private, no-store");
      }
      const b = await list(ownerB);
      expect(ids(b)).toEqual([ownerB, adminB, assocB].map((p) => p.userId).sort());
      for (const p of [ownerA, adminA, assocA, subject1, subject2, ownerA2]) expect(b.text).not.toContain(p.userId);
    });

    it("paging is capped and strict: bad values are 400, unknown parameters are 400, a practice cannot be named", async () => {
      expect(ids(await list(ownerA, "?limit=2"))).toHaveLength(2);
      expect(((await list(ownerA, "?offset=1000")).json.data as unknown[])).toEqual([]);
      for (const qs of ["?limit=0", "?limit=101", "?limit=abc", "?offset=-1", "?offset=10001", "?foo=1", `?organizationId=${orgB}`, "?role=owner"]) {
        expect((await list(ownerA, qs)).status, qs).toBe(400);
      }
    });

    it("a role change applies on the person's very next request, with the same cookie; the audit row has ids and role names only", async () => {
      expect((await me(subject1)).json).toEqual({ id: subject1.userId, role: "associate" });
      expect((await list(subject1)).status).toBe(403);
      const r = await patch(ownerA, subject1.userId, { role: "admin" });
      expect(r.status).toBe(200);
      expect(r.json.data).toMatchObject({ id: subject1.userId, role: "admin", active: true });
      expect((await me(subject1)).json).toEqual({ id: subject1.userId, role: "admin" });
      expect((await list(subject1)).status).toBe(200); // an admin now
      const rows = await userAudit(orgA, "user.role_changed", subject1.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorUserId: ownerA.userId, resourceType: "user", outcome: "success", metadata: { role: "admin", previous_role: "associate" } });
      expect(JSON.stringify(rows[0])).not.toMatch(/example\.test|Synthetic/);
      expect((await patch(ownerA, subject1.userId, { role: "associate" })).status).toBe(200);
      expect((await list(subject1)).status).toBe(403);
    });

    it("the same role again is a 200 with no change and no new audit row", async () => {
      const before = (await userAudit(orgA, "user.role_changed", subject1.userId)).length;
      const r = await patch(ownerA, subject1.userId, { role: "associate" });
      expect(r.status).toBe(200);
      expect((await userAudit(orgA, "user.role_changed", subject1.userId)).length).toBe(before);
    });

    it("malformed requests are 400 and change nothing", async () => {
      for (const id of ["not-a-uuid", "1; drop table users", "..%2F"]) {
        expect((await patch(ownerA, id, { role: "admin" })).status, id).toBe(400);
        expect((await deactivate(ownerA, id)).status, id).toBe(400);
      }
      for (const [label, body, rawBody] of [
        ["an unknown role", { role: "superuser" }, undefined],
        ["a missing role", {}, undefined],
        ["an extra field", { role: "admin", organizationId: orgB }, undefined],
        ["a field that would change the email", { role: "admin", email: "x@example.test" }, undefined],
        ["an array", ["admin"], undefined],
        ["not JSON", undefined, "role=admin"],
        ["a huge body", undefined, JSON.stringify({ role: "admin", pad: "x".repeat(5000) })],
      ] as const) {
        expect((await patch(ownerA, subject1.userId, body, { rawBody })).status, label).toBe(400);
      }
      expect((await dbUser(subject1.userId)).role).toBe("associate");
    });

    it("a cross-site or missing Origin is 403 even for the owner", async () => {
      for (const origin of ["https://evil.example", "null", null]) {
        const r = await patch(ownerA, subject1.userId, { role: "admin" }, { origin });
        expect(r.status, String(origin)).toBe(403);
        expect(r.json.error?.code).toBe("forbidden_origin");
      }
      expect((await dbUser(subject1.userId)).role).toBe("associate");
    });

    it("nobody changes themselves: 403, audited as self_change, nothing changes", async () => {
      const before = (await auditRows(orgA, "authz.denied")).length;
      for (const [who, r] of [
        [ownerA, await patch(ownerA, ownerA.userId, { role: "associate" })],
        [adminA, await patch(adminA, adminA.userId, { role: "associate" })],
        [adminA, await deactivate(adminA, adminA.userId)],
        [ownerA, await deactivate(ownerA, ownerA.userId)],
      ] as const) {
        expect(r.status, who.label).toBe(403);
      }
      expect((await dbUser(ownerA.userId)).role).toBe("owner");
      expect((await dbUser(adminA.userId)).role).toBe("admin");
      expect((await dbUser(ownerA.userId)).deletedAt).toBeNull();
      const denied = (await auditRows(orgA, "authz.denied")).slice(before);
      expect(denied.filter((d) => (d.metadata as { reason?: string }).reason === "self_change")).toHaveLength(4);
    });

    it("an admin manages associates and fellow admins but never touches an owner and never makes one", async () => {
      // allowed: promote and demote below owner
      expect((await patch(adminA, subject1.userId, { role: "admin" })).status).toBe(200);
      expect((await patch(adminA, subject1.userId, { role: "associate" })).status).toBe(200);
      // refused, each audited with the reason, each unchanged in the database
      const touch = await patch(adminA, ownerA2.userId, { role: "associate" });
      expect(touch.status).toBe(403);
      expect((await deactivate(adminA, ownerA2.userId)).status).toBe(403);
      expect((await reactivate(adminA, ownerA2.userId)).status).toBe(403);
      const grant = await patch(adminA, subject1.userId, { role: "owner" });
      expect(grant.status).toBe(403);
      expect((await dbUser(ownerA2.userId)).role).toBe("owner");
      expect((await dbUser(ownerA2.userId)).deletedAt).toBeNull();
      expect((await dbUser(subject1.userId)).role).toBe("associate");
      const reasons = (await auditRows(orgA, "authz.denied")).filter((d) => d.actorUserId === adminA.userId).map((d) => (d.metadata as { reason?: string }).reason);
      expect(reasons).toEqual(expect.arrayContaining(["admin_cannot_touch_owner", "admin_cannot_grant_owner"]));
    });

    it("an owner may promote to owner and demote another owner, and the practice never ends up without one", async () => {
      expect((await patch(ownerA, ownerA2.userId, { role: "admin" })).status).toBe(200);
      expect((await patch(ownerA, ownerA2.userId, { role: "owner" })).status).toBe(200);
      expect((await h.owner.select().from(schema.users).where(and(eq(schema.users.organizationId, orgA), eq(schema.users.role, "owner")))).length).toBeGreaterThanOrEqual(2);
    });

    it("deactivating takes effect on the next request; sign-in is refused; idempotent; a deactivated user cannot be re-roled", async () => {
      expect((await me(subject2)).status).toBe(200);
      const r = await deactivate(ownerA, subject2.userId);
      expect(r.status).toBe(200);
      expect(r.json.data).toMatchObject({ id: subject2.userId, active: false });
      expect((await me(subject2)).status).toBe(401);
      expect((await list(subject2)).status).toBe(401);
      expect((await h.authCall("/sign-in/email", { body: { email: subject2.email, password: "correct horse battery staple 1" } })).status).toBeGreaterThanOrEqual(400);
      // listed, flagged inactive
      const listed = (await list(ownerA)).json.data as { id: string; active: boolean }[];
      expect(listed.find((u) => u.id === subject2.userId)?.active).toBe(false);
      // idempotent: no second audit row
      expect((await deactivate(ownerA, subject2.userId)).status).toBe(200);
      expect(await userAudit(orgA, "user.deactivated", subject2.userId)).toHaveLength(1);
      // cannot be given a new role while inactive
      const conflict = await patch(ownerA, subject2.userId, { role: "admin" });
      expect(conflict.status).toBe(409);
      expect(conflict.json.error?.code).toBe("conflict");
    });

    it("reactivating restores the ability to sign in, is idempotent, and is audited", async () => {
      const r = await reactivate(ownerA, subject2.userId);
      expect(r.status).toBe(200);
      expect(r.json.data).toMatchObject({ id: subject2.userId, active: true });
      const signIn = await h.authCall("/sign-in/email", { body: { email: subject2.email, password: "correct horse battery staple 1" } });
      expect(signIn.status).toBe(200);
      expect(((await signIn.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
      expect((await reactivate(ownerA, subject2.userId)).status).toBe(200);
      expect(await userAudit(orgA, "user.reactivated", subject2.userId)).toHaveLength(1);
    });

    it("cross-tenant: another practice's user, owner or admin is the same 404 as an id that does not exist, and nothing changes", async () => {
      const missing = await patch(ownerA, MISSING, { role: "admin" });
      expect(missing.status).toBe(404);
      for (const target of [assocB, adminB, ownerB]) {
        for (const who of [ownerA, adminA]) {
          const a = await patch(who, target.userId, { role: "admin" });
          const b = await deactivate(who, target.userId);
          const c = await reactivate(who, target.userId);
          for (const r of [a, b, c]) {
            expect(r.status, `${who.label} → ${target.label}`).toBe(404);
            expect(r.json).toEqual(missing.json);
            expect(r.text).not.toContain(target.email);
          }
        }
      }
      // and the mirror image, for practice B's owner against practice A's people
      for (const target of [ownerA, adminA, assocA, subject1]) {
        expect((await patch(ownerB, target.userId, { role: "associate" })).status).toBe(404);
        expect((await deactivate(ownerB, target.userId)).status).toBe(404);
      }
      expect((await dbUser(assocB.userId)).role).toBe("associate");
      expect((await dbUser(adminB.userId)).role).toBe("admin");
      expect((await dbUser(ownerB.userId)).role).toBe("owner");
      for (const p of [assocB, adminB, ownerB]) expect((await dbUser(p.userId)).deletedAt).toBeNull();
      expect((await dbUser(ownerA.userId)).role).toBe("owner");
    });

    it("the organization comes from the session: body and header cannot move a change to another practice", async () => {
      const r = await patch(ownerB, assocB.userId, { role: "admin" }, {});
      expect(r.status).toBe(200);
      const spoofed = await h.call(ownerB, userRoute.PATCH, {
        method: "PATCH",
        path: `/api/admin/users/${subject1.userId}`,
        body: { role: "admin" },
        params: { id: subject1.userId },
        headers: { "x-organization-id": orgA, "x-org-id": orgA },
      });
      expect(spoofed.status).toBe(404);
      expect((await dbUser(subject1.userId)).role).toBe("associate");
      expect((await patch(ownerB, assocB.userId, { role: "associate" })).status).toBe(200);
    });

    it("handing the practice over: the new owner demotes the old one, the practice always has an owner, and the old owner loses access at once", async () => {
      await h.signedInAgo(ownerB, 5);
      expect((await patch(ownerB, adminB.userId, { role: "owner" })).status).toBe(200);
      expect((await patch(adminB, ownerB.userId, { role: "associate" })).status).toBe(200); // adminB is an owner now
      expect((await list(ownerB)).status).toBe(403); // ownerB is an associate now, same cookie
      expect((await patch(adminB, adminB.userId, { role: "associate" })).status).toBe(403); // cannot step down alone
      const owners = await h.owner.select().from(schema.users).where(and(eq(schema.users.organizationId, orgB), eq(schema.users.role, "owner")));
      expect(owners.map((o) => o.id)).toEqual([adminB.userId]);
    });

    it("every user audit row has ids and role names only, no email or name", async () => {
      for (const action of ["user.role_changed", "user.deactivated", "user.reactivated"]) {
        for (const row of await auditRows(orgA, action)) expect(JSON.stringify(row), action).not.toMatch(/example\.test|Synthetic|@/);
      }
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("nothing leaks across practices (scan of every response any caller received)", () => {
    it("no response to a practice-B caller names a practice-A id, and vice versa", () => {
      for (const s of h.seen) {
        const other = s.orgId === orgA ? orgB : s.orgId === orgB ? orgA : null;
        if (other) expect(s.text, `${s.caller} received ${other}`).not.toContain(other);
      }
      // The endpoint values themselves are private to each practice.
      for (const s of h.seen.filter((x) => x.orgId === orgB)) expect(s.text).not.toContain("studio-mac");
    });
  });
});
