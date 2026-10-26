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
  let resetRoute: { POST: Handler };
  let assignmentsRoute: { GET: Handler; POST: Handler };
  let assignmentRoute: { DELETE: Handler };
  let clientsRoute: { GET: Handler };
  let clientRoute: { GET: Handler };

  let orgA: string;
  let orgB: string;
  let ownerA: Person, adminA: Person, assocA: Person, subject1: Person, subject2: Person, ownerA2: Person;
  let ownerB: Person, adminB: Person, assocB: Person;
  let resetA: Person, resetAdminA: Person, resetB: Person; // people whose authenticator is reset (a reset ends their sessions)
  let deactivatedFixtureId = ""; // a deactivated person the assignment tests add to practice A

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
  // The query has no ORDER BY and Postgres returns heap order, which is not insertion order on a table
  // that autovacuum has recycled (measured on the test branch). So a test never slices by a count taken
  // earlier: it remembers the ids it has seen and looks at the rows that are not among them.
  const seenDenied = async () => new Set((await auditRows(orgA, "authz.denied")).map((r) => r.id));
  const newDenied = async (seen: Set<string>) => (await auditRows(orgA, "authz.denied")).filter((r) => !seen.has(r.id));

  beforeAll(async () => {
    h = await startHarness({ appRole: "app_runtime_admin", authRole: "auth_runtime_admin", secret: "admin-test-secret-".padEnd(48, "x") });
    endpointRoute = (await import("@/app/api/admin/inference-endpoint/route")) as unknown as { GET: Handler; PUT: Handler };
    usersRoute = (await import("@/app/api/admin/users/route")) as unknown as { GET: Handler };
    userRoute = (await import("@/app/api/admin/users/[id]/route")) as unknown as { PATCH: Handler };
    deactivateRoute = (await import("@/app/api/admin/users/[id]/deactivate/route")) as unknown as { POST: Handler };
    reactivateRoute = (await import("@/app/api/admin/users/[id]/reactivate/route")) as unknown as { POST: Handler };
    meRoute = (await import("@/app/api/me/route")) as unknown as { GET: Handler };
    resetRoute = (await import("@/app/api/admin/users/[id]/reset-mfa/route")) as unknown as { POST: Handler };
    assignmentsRoute = (await import("@/app/api/admin/assignments/route")) as unknown as { GET: Handler; POST: Handler };
    assignmentRoute = (await import("@/app/api/admin/assignments/[id]/route")) as unknown as { DELETE: Handler };
    clientsRoute = (await import("@/app/api/clients/route")) as unknown as { GET: Handler };
    clientRoute = (await import("@/app/api/clients/[id]/route")) as unknown as { GET: Handler };

    orgA = await h.seedOrg("admin-A");
    orgB = await h.seedOrg("admin-B");
    [ownerA, adminA, assocA, subject1, subject2, ownerA2, ownerB, adminB, assocB, resetA, resetAdminA, resetB] = await Promise.all([
      h.makePerson(orgA, "owner-a", "owner"),
      h.makePerson(orgA, "admin-a", "admin"),
      h.makePerson(orgA, "assoc-a", "associate"),
      h.makePerson(orgA, "subject-1", "associate"),
      h.makePerson(orgA, "subject-2", "associate"),
      h.makePerson(orgA, "owner-a2", "owner"),
      h.makePerson(orgB, "owner-b", "owner"),
      h.makePerson(orgB, "admin-b", "admin"),
      h.makePerson(orgB, "assoc-b", "associate"),
      h.makePerson(orgA, "reset-a", "associate"),
      h.makePerson(orgA, "reset-admin-a", "admin"),
      h.makePerson(orgB, "reset-b", "associate"),
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
  describe("assignments and the admin grant (owner only)", () => {
    type Who = Pick<Person, "label" | "orgId"> & { cookie?: string };
    const NAME = (s: string) => `Synthetic Child ${s}`;
    const listA = (who: Who, qs = "") => h.call(who, assignmentsRoute.GET, { path: `/api/admin/assignments${qs}` });
    const grant = (who: Who, body: unknown, o: { origin?: string | null; rawBody?: string; headers?: Record<string, string> } = {}) =>
      h.call(who, assignmentsRoute.POST, { method: "POST", path: "/api/admin/assignments", body, ...o });
    const end = (who: Who, id: string) => h.call(who, assignmentRoute.DELETE, { method: "DELETE", path: `/api/admin/assignments/${id}`, params: { id } });
    const clientList = (who: Who) => h.call(who, clientsRoute.GET, { path: "/api/clients" });
    const clientOne = (who: Who, id: string) => h.call(who, clientRoute.GET, { path: `/api/clients/${id}`, params: { id } });
    const clientIds = (r: { json: { data?: unknown } }) => (r.json.data as { id: string }[]).map((c) => c.id).sort();
    const rowsFor = (clientId: string) => h.owner.select().from(schema.clientAssignments).where(eq(schema.clientAssignments.clientId, clientId));
    const MISSING = "00000000-0000-4000-8000-00000000beef";

    async function addClient(orgId: string, label: string, deleted = false): Promise<string> {
      const [row] = await h.owner.insert(schema.clients).values({ organizationId: orgId, displayName: NAME(label), gradeLevel: "3", deletedAt: deleted ? new Date() : null }).returning();
      return row.id;
    }

    let c1: string, c2: string, c3: string, cGone: string, b1: string, b2: string;
    let grantC1Admin: string;

    beforeAll(async () => {
      [c1, c2, c3, cGone] = [await addClient(orgA, "A1"), await addClient(orgA, "A2"), await addClient(orgA, "A3"), await addClient(orgA, "A-gone", true)];
      [b1, b2] = [await addClient(orgB, "B1"), await addClient(orgB, "B2")];
    });

    it("no session is 401; an associate and an admin are 403 and audited; nothing is created or ended", async () => {
      const nobody = { label: "nobody", orgId: "none" };
      expect((await listA(nobody)).status).toBe(401);
      expect((await grant(nobody, { clientId: c1, userId: adminA.userId })).status).toBe(401);
      expect((await end(nobody, MISSING)).status).toBe(401);
      for (const who of [assocA, adminA]) {
        for (const r of [await listA(who), await grant(who, { clientId: c1, userId: who.userId }), await end(who, MISSING)]) {
          expect(r.status, who.label).toBe(403);
          expect(r.json.error?.code).toBe("forbidden");
        }
      }
      expect(await rowsFor(c1)).toHaveLength(0);
      const denied = (await auditRows(orgA, "authz.denied")).filter((x) => x.resourceType === "client_assignment");
      expect(denied.filter((d) => d.actorUserId === adminA.userId)).toHaveLength(3);
      expect(denied.filter((d) => d.actorUserId === assocA.userId)).toHaveLength(3);
    });

    it("before any grant, an admin and an associate see nothing: an empty list and the same 404 for every id", async () => {
      for (const who of [adminA, assocA]) {
        const l = await clientList(who);
        expect(l.status, who.label).toBe(200);
        expect(l.json.data).toEqual([]);
        const real = await clientOne(who, c1);
        expect(real.status).toBe(404);
        for (const id of [b1, MISSING, cGone]) expect((await clientOne(who, id)).json).toEqual(real.json);
        expect(real.text).not.toContain(NAME("A1"));
      }
      expect(clientIds(await clientList(ownerA))).toEqual([c1, c2, c3].sort()); // the owner sees the practice
    });

    it("the owner grants a client to an admin: 201, ids only, audited; the admin then sees exactly that client", async () => {
      const r = await grant(ownerA, { clientId: c1, userId: adminA.userId });
      expect(r.status).toBe(201);
      const data = r.json.data as Record<string, unknown>;
      expect(Object.keys(data).sort()).toEqual(["assignedByUserId", "clientId", "createdAt", "id", "userId"]);
      expect(data).toMatchObject({ clientId: c1, userId: adminA.userId, assignedByUserId: ownerA.userId });
      expect(r.text).not.toContain("Synthetic");
      grantC1Admin = data.id as string;
      const rows = await auditRows(orgA, "assignment.created");
      const mine = rows.filter((x) => x.resourceId === grantC1Admin);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ actorUserId: ownerA.userId, resourceType: "client_assignment", metadata: { role: "admin" } });
      expect(JSON.stringify(mine[0])).not.toMatch(/Synthetic|example\.test/);

      // The grant applies on the very next request, with the same cookie, and reaches nothing else.
      expect(clientIds(await clientList(adminA))).toEqual([c1]);
      const one = await clientOne(adminA, c1);
      expect(one.status).toBe(200);
      expect((one.json.data as { displayName: string }).displayName).toBe(NAME("A1"));
      expect((await clientOne(adminA, c2)).status).toBe(404);
      expect((await clientOne(adminA, b1)).status).toBe(404);
    });

    it("the same assignment works for an associate, and each sees only their own", async () => {
      expect((await grant(ownerA, { clientId: c2, userId: assocA.userId })).status).toBe(201);
      expect(clientIds(await clientList(assocA))).toEqual([c2]);
      expect(clientIds(await clientList(adminA))).toEqual([c1]);
    });

    it("an existing active assignment is a 409 and creates no second row", async () => {
      const r = await grant(ownerA, { clientId: c1, userId: adminA.userId });
      expect(r.status).toBe(409);
      expect(r.json.error?.code).toBe("conflict");
      expect(await rowsFor(c1)).toHaveLength(1);
    });

    it("refuses targets that make no sense: an owner (400), a deactivated person, a deleted client and made-up ids (404)", async () => {
      expect((await grant(ownerA, { clientId: c3, userId: ownerA2.userId })).status).toBe(400);
      const gone = await h.seedUser(orgA, "gone-user", "associate");
      deactivatedFixtureId = gone.userId;
      await h.owner.update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, gone.userId));
      expect((await grant(ownerA, { clientId: c3, userId: gone.userId })).status).toBe(404);
      expect((await grant(ownerA, { clientId: cGone, userId: assocA.userId })).status).toBe(404);
      expect((await grant(ownerA, { clientId: MISSING, userId: assocA.userId })).status).toBe(404);
      expect((await grant(ownerA, { clientId: c3, userId: MISSING })).status).toBe(404);
      expect(await rowsFor(c3)).toHaveLength(0);
      expect(await rowsFor(cGone)).toHaveLength(0);
    });

    it("malformed requests are 400 and create nothing", async () => {
      for (const [label, body, rawBody] of [
        ["a bad client id", { clientId: "nope", userId: assocA.userId }, undefined],
        ["a bad user id", { clientId: c3, userId: "1; drop table users" }, undefined],
        ["a missing field", { clientId: c3 }, undefined],
        ["an extra field", { clientId: c3, userId: assocA.userId, organizationId: orgB }, undefined],
        ["a field that would name who assigned it", { clientId: c3, userId: assocA.userId, assignedByUserId: assocA.userId }, undefined],
        ["an array", [c3, assocA.userId], undefined],
        ["not JSON", undefined, "clientId=x"],
        ["a huge body", undefined, JSON.stringify({ clientId: c3, userId: assocA.userId, pad: "x".repeat(5000) })],
      ] as const) {
        expect((await grant(ownerA, body, { rawBody })).status, label).toBe(400);
      }
      expect(await rowsFor(c3)).toHaveLength(0);
      for (const id of ["not-a-uuid", "1;drop", "..%2F"]) expect((await end(ownerA, id)).status, id).toBe(400);
    });

    it("a cross-site or missing Origin is 403 even for the owner, on create and on end", async () => {
      for (const origin of ["https://evil.example", "null", null]) {
        const r = await grant(ownerA, { clientId: c3, userId: assocA.userId }, { origin });
        expect(r.status, String(origin)).toBe(403);
        expect(r.json.error?.code).toBe("forbidden_origin");
      }
      const del = await h.call(ownerA, assignmentRoute.DELETE, { method: "DELETE", path: `/api/admin/assignments/${grantC1Admin}`, params: { id: grantC1Admin }, origin: "https://evil.example" });
      expect(del.status).toBe(403);
      expect(await rowsFor(c3)).toHaveLength(0);
      expect(clientIds(await clientList(adminA))).toEqual([c1]);
    });

    it("the owner lists assignments (ids only), filtered by client or person; bad filters are 400", async () => {
      const all = await listA(ownerA);
      expect(all.status).toBe(200);
      const ids = (all.json.data as { id: string }[]).map((a) => a.id);
      expect(ids).toContain(grantC1Admin);
      expect(all.text).not.toContain("Synthetic");
      const byClient = (await listA(ownerA, `?clientId=${c1}`)).json.data as { clientId: string; userId: string }[];
      expect(byClient.every((a) => a.clientId === c1)).toBe(true);
      expect(byClient.map((a) => a.userId)).toEqual([adminA.userId]);
      const byUser = (await listA(ownerA, `?userId=${assocA.userId}`)).json.data as { userId: string }[];
      expect(byUser.every((a) => a.userId === assocA.userId)).toBe(true);
      for (const qs of ["?clientId=x", "?userId=1", "?limit=0", "?limit=101", "?offset=-1", "?foo=1", `?organizationId=${orgB}`]) expect((await listA(ownerA, qs)).status, qs).toBe(400);
    });

    it("ending a grant takes effect on the next request; ending twice is a 404; re-granting makes a new row", async () => {
      const r = await end(ownerA, grantC1Admin);
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ data: { id: grantC1Admin, ended: true } });
      expect((await clientList(adminA)).json.data).toEqual([]);
      expect((await clientOne(adminA, c1)).status).toBe(404);
      expect((await end(ownerA, grantC1Admin)).status).toBe(404);
      const ended = await auditRows(orgA, "assignment.ended");
      expect(ended.filter((x) => x.resourceId === grantC1Admin)).toHaveLength(1);
      // The row is kept, marked ended; an ended grant is not listed.
      const [row] = await h.owner.select().from(schema.clientAssignments).where(eq(schema.clientAssignments.id, grantC1Admin));
      expect(row.deletedAt).not.toBeNull();
      expect(((await listA(ownerA)).json.data as { id: string }[]).map((a) => a.id)).not.toContain(grantC1Admin);

      const again = await grant(ownerA, { clientId: c1, userId: adminA.userId });
      expect(again.status).toBe(201);
      expect((again.json.data as { id: string }).id).not.toBe(grantC1Admin);
      expect(clientIds(await clientList(adminA))).toEqual([c1]);
      grantC1Admin = (again.json.data as { id: string }).id;
    });

    it("a deleted client drops out of an existing grant", async () => {
      const [extra] = [await addClient(orgA, "A-soon-gone")];
      const g = await grant(ownerA, { clientId: extra, userId: adminA.userId });
      expect(g.status).toBe(201);
      expect(clientIds(await clientList(adminA))).toEqual([c1, extra].sort());
      await h.owner.update(schema.clients).set({ deletedAt: new Date() }).where(eq(schema.clients.id, extra));
      expect(clientIds(await clientList(adminA))).toEqual([c1]);
      expect((await clientOne(adminA, extra)).status).toBe(404);
    });

    it("cross-tenant: nothing links across practices, in either direction, by id, body or header", async () => {
      const missing = await grant(ownerA, { clientId: MISSING, userId: assocA.userId });
      expect(missing.status).toBe(404);
      // practice A's owner, practice B's client and/or person
      for (const body of [{ clientId: b1, userId: assocA.userId }, { clientId: c1, userId: assocB.userId }, { clientId: b1, userId: assocB.userId }, { clientId: b2, userId: adminB.userId }]) {
        const r = await grant(ownerA, body);
        expect(r.status, JSON.stringify(Object.keys(body))).toBe(404);
        expect(r.json).toEqual(missing.json);
      }
      expect(await rowsFor(b1)).toHaveLength(0);
      expect(await rowsFor(b2)).toHaveLength(0);
      expect((await h.owner.select().from(schema.clientAssignments).where(eq(schema.clientAssignments.userId, assocB.userId)))).toHaveLength(0);
      // and the mirror image
      for (const body of [{ clientId: c1, userId: assocB.userId }, { clientId: b1, userId: assocA.userId }, { clientId: c2, userId: adminB.userId }]) {
        expect((await grant(ownerB, body)).status).toBe(404);
      }
      expect(await rowsFor(c2)).toHaveLength(1); // only the one practice A gave itself
      // the organization cannot be moved by body or header
      expect((await grant(ownerB, { clientId: b1, userId: assocB.userId, organizationId: orgA })).status).toBe(400);
      const spoofed = await grant(ownerB, { clientId: c1, userId: assocB.userId }, { headers: { "x-organization-id": orgA, "x-org-id": orgA } });
      expect(spoofed.status).toBe(404);

      // practice B grants its own, ends it, and A can neither see nor end it
      const mine = await grant(ownerB, { clientId: b1, userId: assocB.userId });
      expect(mine.status).toBe(201);
      const bId = (mine.json.data as { id: string }).id;
      expect(clientIds(await clientList(assocB))).toEqual([b1]);
      expect((await end(ownerA, bId)).status).toBe(404);
      expect((await end(ownerA, bId)).json).toEqual(missing.json);
      const [still] = await h.owner.select().from(schema.clientAssignments).where(eq(schema.clientAssignments.id, bId));
      expect(still.deletedAt).toBeNull();
      expect(((await listA(ownerA)).json.data as { id: string }[]).map((a) => a.id)).not.toContain(bId);
      expect(((await listA(ownerB)).json.data as { id: string }[]).map((a) => a.id)).toEqual([bId]);
      expect((await listA(ownerA, `?clientId=${b1}`)).json.data).toEqual([]);
      expect((await listA(ownerA, `?userId=${assocB.userId}`)).json.data).toEqual([]);
      expect(clientIds(await clientList(assocB))).toEqual([b1]);
      // B's admin has no grant, so sees nothing, and A's grants do not reach B
      expect((await clientList(adminB)).json.data).toEqual([]);
      expect((await end(ownerB, grantC1Admin)).status).toBe(404);
      expect(clientIds(await clientList(adminA))).toEqual([c1]);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("owner MFA reset (fresh sign-in, owner only)", () => {
    type Who = Pick<Person, "label" | "orgId"> & { cookie?: string };
    const reset = (who: Who, id: string, o: { origin?: string | null } = {}) =>
      h.call(who, resetRoute.POST, { method: "POST", path: `/api/admin/users/${id}/reset-mfa`, params: { id }, ...o });
    const me = (who: Who) => h.call(who, meRoute.GET, { path: "/api/me" });
    const enrollments = async (userId: string) => (await h.owner.select().from(schema.authTwoFactors).where(eq(schema.authTwoFactors.userId, userId))).length;
    const flag = async (userId: string) => (await h.owner.select().from(schema.users).where(eq(schema.users.id, userId)))[0].twoFactorEnabled;
    const resetRows = (orgId: string) => auditRows(orgId, "auth.mfa_reset");
    const MISSING = "00000000-0000-4000-8000-00000000c0de";

    it("no session is 401; an associate and an admin are 403 and audited; nothing is reset", async () => {
      expect((await reset({ label: "nobody", orgId: "none" }, resetA.userId)).status).toBe(401);
      const roleDenials = async (p: Person) =>
        (await auditRows(orgA, "authz.denied")).filter((d) => d.actorUserId === p.userId && d.resourceType === "user" && (d.metadata as { reason?: string }).reason === "role_not_allowed").length;
      for (const who of [assocA, adminA]) {
        const before = await roleDenials(who);
        const r = await reset(who, resetA.userId);
        expect(r.status, who.label).toBe(403);
        expect(r.json.error?.code).toBe("forbidden");
        // Refused by the route's own role list (not merely by the later rule): the guard audited it.
        expect(await roleDenials(who), `${who.label} audited by the guard`).toBe(before + 1);
      }
      expect(await enrollments(resetA.userId)).toBe(1);
      expect(await flag(resetA.userId)).toBe(true);
      expect((await me(resetA)).status).toBe(200);
      expect(await resetRows(orgA)).toHaveLength(0);
    });

    it("a stale sign-in is 403 reauth_required and nothing is reset; a cross-site or missing Origin is 403", async () => {
      await h.signedInAgo(ownerA, 10 * 60);
      const stale = await reset(ownerA, resetA.userId);
      expect(stale.status).toBe(403);
      expect(stale.json.error?.code).toBe("reauth_required");
      await h.signedInAgo(ownerA, 5);
      for (const origin of ["https://evil.example", "null", null]) {
        const r = await reset(ownerA, resetA.userId, { origin });
        expect(r.status, String(origin)).toBe(403);
        expect(r.json.error?.code).toBe("forbidden_origin");
      }
      expect(await enrollments(resetA.userId)).toBe(1);
      expect((await me(resetA)).status).toBe(200);
    });

    it("malformed ids are 400", async () => {
      await h.signedInAgo(ownerA, 5);
      for (const id of ["nope", "1; drop table users", "..%2F"]) expect((await reset(ownerA, id)).status, id).toBe(400);
    });

    it("refuses oneself and another owner (the break-glass script is for those), audited with a fixed reason", async () => {
      await h.signedInAgo(ownerA, 5);
      const seen = await seenDenied();
      expect((await reset(ownerA, ownerA.userId)).status).toBe(403);
      expect((await reset(ownerA, ownerA2.userId)).status).toBe(403);
      expect(await enrollments(ownerA.userId)).toBe(1);
      expect(await enrollments(ownerA2.userId)).toBe(1);
      expect((await me(ownerA2)).status).toBe(200);
      const mine = (await newDenied(seen)).filter((d) => d.actorUserId === ownerA.userId && [ownerA.userId, ownerA2.userId].includes(d.resourceId ?? ""));
      expect(mine.map((d) => (d.metadata as { reason?: string }).reason).sort()).toEqual(["owner_break_glass", "self_change"]);
    });

    it("cross-tenant: another practice's person is the same 404 as a made-up id, and nothing is reset", async () => {
      await h.signedInAgo(ownerA, 5);
      await h.signedInAgo(ownerB, 5);
      const missing = await reset(ownerA, MISSING);
      expect(missing.status).toBe(404);
      for (const target of [resetB, assocB, adminB, ownerB]) {
        const r = await reset(ownerA, target.userId);
        expect(r.status, target.label).toBe(404);
        expect(r.json).toEqual(missing.json);
      }
      for (const target of [resetA, subject1, ownerA, adminA]) expect((await reset(ownerB, target.userId)).status, target.label).toBe(404);
      for (const p of [resetA, subject1, resetB, assocB]) {
        expect(await enrollments(p.userId), p.label).toBe(1);
        expect(await flag(p.userId), p.label).toBe(true);
      }
      expect((await me(resetB)).status).toBe(200);
      expect((await me(resetA)).status).toBe(200);
      expect(await resetRows(orgA)).toHaveLength(0);
      expect(await resetRows(orgB)).toHaveLength(0);
    });

    it("the owner resets an associate: enrollment gone, flag off, signed out everywhere, audited by the database function, the person told by email, password kept", async () => {
      await h.signedInAgo(ownerA, 5);
      const info = vi.mocked(console.info);
      info.mockClear();
      expect((await me(resetA)).status).toBe(200);
      const r = await reset(ownerA, resetA.userId);
      expect(r.status).toBe(200);
      expect(r.json.data).toMatchObject({ id: resetA.userId, role: "associate", active: true, mfaEnabled: false });
      expect(r.headers.get("cache-control")).toBe("private, no-store");

      expect(await enrollments(resetA.userId)).toBe(0);
      expect(await flag(resetA.userId)).toBe(false);
      expect((await me(resetA)).status).toBe(401); // the same cookie is dead
      expect(await h.owner.select().from(schema.authSessions).where(eq(schema.authSessions.userId, resetA.userId))).toHaveLength(0);

      const rows = await resetRows(orgA);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorUserId: ownerA.userId, resourceType: "users", resourceId: resetA.userId, outcome: "success", metadata: { method: "owner_reset" } });
      expect(JSON.stringify(rows[0])).not.toMatch(/example\.test|Synthetic|@/);

      await vi.waitFor(() => {
        const sent = info.mock.calls.map((c) => String(c[0])).filter((line) => line.includes(`to=${resetA.email}`));
        expect(sent.length).toBe(1);
        expect(sent[0]).toContain("Your two-step sign-in was reset");
      });

      // Their password still works, but a password alone gets no session until a new phone is set up.
      const again = await h.authCall("/sign-in/email", { body: { email: resetA.email, password: "correct horse battery staple 1" } });
      expect(again.status).toBe(200);
      expect(((await again.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBeUndefined();
      expect((await me({ label: "reset-a-new", orgId: orgA, cookie: h.cookieFrom(again) })).status).toBe(401);
    });

    it("the owner resets an admin too, and nobody else's authenticator changes", async () => {
      await h.signedInAgo(ownerA, 5);
      const r = await reset(ownerA, resetAdminA.userId);
      expect(r.status).toBe(200);
      expect(r.json.data).toMatchObject({ id: resetAdminA.userId, role: "admin", mfaEnabled: false });
      expect((await me(resetAdminA)).status).toBe(401);
      for (const p of [ownerA, ownerA2, adminA, assocA, subject1]) expect(await enrollments(p.userId), p.label).toBe(1);
      expect((await resetRows(orgA)).map((x) => x.resourceId).sort()).toEqual([resetA.userId, resetAdminA.userId].sort());
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
      const deniedBefore = (await auditRows(orgA, "authz.denied")).filter((x) => x.resourceType === "user" && x.actorUserId === assocA.userId).length;
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
      expect(denied.length - deniedBefore).toBe(4);
    });

    it("the owner and the admin list exactly their own practice, deactivated people included, with allow-listed fields only", async () => {
      const expected = [...[ownerA, adminA, assocA, subject1, subject2, ownerA2, resetA, resetAdminA].map((p) => p.userId), deactivatedFixtureId].sort();
      for (const who of [ownerA, adminA]) {
        const r = await list(who);
        expect(r.status, who.label).toBe(200);
        expect(ids(r)).toEqual(expected);
        for (const u of r.json.data as Record<string, unknown>[]) {
          expect(Object.keys(u).sort()).toEqual(["active", "createdAt", "displayName", "email", "id", "mfaEnabled", "role"]);
          const resetAlready = [resetA.userId, resetAdminA.userId].includes(u.id as string); // their authenticator was reset above
          expect(u.mfaEnabled).toBe(u.id !== deactivatedFixtureId && !resetAlready); // everyone signed in with a code, except the fixture that never did
          expect(u.active).toBe(u.id !== deactivatedFixtureId);
        }
        expect(r.headers.get("cache-control")).toBe("private, no-store");
      }
      const b = await list(ownerB);
      expect(ids(b)).toEqual([ownerB, adminB, assocB, resetB].map((p) => p.userId).sort());
      for (const p of [ownerA, adminA, assocA, subject1, subject2, ownerA2, resetA, resetAdminA]) expect(b.text).not.toContain(p.userId);
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
      const seen = await seenDenied();
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
      const denied = (await newDenied(seen)).filter((d) => d.actorUserId === d.resourceId && [ownerA.userId, adminA.userId].includes(d.actorUserId ?? ""));
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
  describe("no cross-origin access (audit 04 item 5)", () => {
    it("none of the admin routes sends CORS headers, even to a cross-site Origin, and a cross-site write is refused", async () => {
      const cross = { origin: "https://evil.example" };
      const replies = [
        await h.call(ownerA, usersRoute.GET, { path: "/api/admin/users", headers: cross }),
        await h.call(ownerA, assignmentsRoute.GET, { path: "/api/admin/assignments", headers: cross }),
        await h.call(ownerA, endpointRoute.GET, { path: "/api/admin/inference-endpoint", headers: cross }),
        await h.call(adminA, usersRoute.GET, { path: "/api/admin/users", headers: cross }),
        await h.call({ label: "nobody", orgId: "none" }, usersRoute.GET, { path: "/api/admin/users", headers: cross }),
        await h.call(ownerA, endpointRoute.PUT, { method: "PUT", path: "/api/admin/inference-endpoint", body: { endpoint: null }, origin: "https://evil.example" }),
      ];
      for (const r of replies) {
        for (const name of ["access-control-allow-origin", "access-control-allow-credentials", "access-control-allow-methods", "access-control-allow-headers"]) expect(r.headers.get(name), name).toBeNull();
      }
      expect(replies[5].status).toBe(403);
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
