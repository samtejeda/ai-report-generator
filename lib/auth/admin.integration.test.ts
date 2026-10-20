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

  let orgA: string;
  let orgB: string;
  let ownerA: Person, adminA: Person, assocA: Person;
  let ownerB: Person, adminB: Person;

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

    orgA = await h.seedOrg("admin-A");
    orgB = await h.seedOrg("admin-B");
    [ownerA, adminA, assocA, ownerB, adminB] = await Promise.all([
      h.makePerson(orgA, "owner-a", "owner"),
      h.makePerson(orgA, "admin-a", "admin"),
      h.makePerson(orgA, "assoc-a", "associate"),
      h.makePerson(orgB, "owner-b", "owner"),
      h.makePerson(orgB, "admin-b", "admin"),
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
