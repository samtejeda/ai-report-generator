import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { Pool } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import * as schema from "@/lib/db/schema";

// Authorization end to end, through the REAL route modules (app/api/me, app/api/clients,
// app/api/clients/[id]), the REAL Better Auth instance (sign-in, authenticator code, session
// cookie), and the REAL database roles (auth_runtime for sessions, app_runtime for data, with
// row-level security) on the scratch `test` branch. Nothing here is mocked: a "caller" below holds
// a cookie obtained by signing in and verifying a real authenticator code.
//
// Needs TEST_* variables from .env.test.local (gitignored); skipped when absent. Synthetic data
// only: fresh random organizations, example.test addresses, "Synthetic ..." names. audit_log rows
// cannot be deleted by design, so runs accumulate; reset the test branch from dev when heavy.
// Run this file on its own on an idle machine (every request is a round trip to Neon).
try {
  process.loadEnvFile(".env.test.local");
} catch {}

vi.setConfig({ testTimeout: 120_000 });

const OWNER_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = process.env.TEST_APP_ROLE_PASSWORD;
const ENABLED = Boolean(OWNER_URL && PASSWORD && /^[a-f0-9]{32,}$/.test(PASSWORD));
const APP_ROLE = "app_runtime_authz";
const AUTH_ROLE = "auth_runtime_authz";
const BASE = "http://localhost:3000";
const SECRET = "authz-test-secret-".padEnd(48, "x");
const GOOD_PASSWORD = "correct horse battery staple 1";

type Db = NeonDatabase<typeof schema> & { $client: Pool };
type Handler = (request: Request, ctx?: { params?: Promise<{ id: string }> }) => Promise<Response>;
type ClientJson = { id: string; displayName: string; dateOfBirth: string | null; gradeLevel: string | null; externalId: string | null; createdAt: string };
type Body = { data?: ClientJson | ClientJson[]; error?: { code: string; message: string }; id?: string; role?: string; limit?: number; offset?: number };

// ---- RFC 6238 TOTP (what an authenticator app does), so the sign-in is the real one.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function totpCode(secret: string, at = Date.now()): string {
  let bits = "";
  for (const ch of secret.replace(/=+$/, "")) bits += B32.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < key.length; i++) key[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac("sha1", key).update(counter).digest();
  const off = h[h.length - 1] & 0xf;
  const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

describe.skipIf(!ENABLED)("authorization through the real routes (Neon test branch)", () => {
  let ownerPool: Pool;
  let owner: Db;
  let handle: (request: Request) => Promise<Response>; // the real Better Auth handler
  let clientsGET: Handler;
  let clientGET: Handler;
  let meGET: Handler;
  let guardedRoute: typeof import("./guard").guardedRoute;
  let hashPassword: (password: string) => Promise<string>;

  const runOctets = crypto.getRandomValues(new Uint8Array(2)).join(".");
  let ipCounter = 1;
  const nextIp = () => `10.${runOctets}.${ipCounter++ % 250}`;

  // Everything every caller ever received, to scan at the end for another practice's data.
  const seen: { caller: string; orgId: string; text: string }[] = [];

  // ---- auth plumbing (real sign-in) ------------------------------------------------------
  async function authCall(path: string, o: { body?: unknown; cookie?: string } = {}): Promise<Response> {
    const headers = new Headers({ "content-type": "application/json", "x-forwarded-for": nextIp(), origin: BASE, "user-agent": "vitest" });
    if (o.cookie) headers.set("cookie", o.cookie);
    return handle(
      new Request(`${BASE}/api/auth${path}`, {
        method: o.body === undefined ? "GET" : "POST",
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        redirect: "manual",
      }),
    );
  }
  const cookieFrom = (res: Response) =>
    res.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !/=$/.test(c)).join("; ");

  type Person = { label: string; userId: string; orgId: string; email: string; secret?: string; cookie: string };

  async function seedOrg(label: string): Promise<string> {
    const [org] = await owner.insert(schema.organizations).values({ name: `Synthetic Org ${label}` }).returning();
    return org.id;
  }

  async function seedUser(orgId: string, label: string, role: "owner" | "associate" | "admin"): Promise<Omit<Person, "cookie">> {
    const email = `${label}-${crypto.randomUUID()}@example.test`;
    const [u] = await owner
      .insert(schema.users)
      .values({ organizationId: orgId, email, displayName: `Synthetic ${label}`, role, emailVerified: true })
      .returning();
    await owner.insert(schema.authAccounts).values({ userId: u.id, accountId: u.id, providerId: "credential", password: await hashPassword(GOOD_PASSWORD) });
    return { label, userId: u.id, orgId, email };
  }

  /** Password sign-in, authenticator enrollment, first code: the cookie of a complete session. */
  async function enroll(u: Omit<Person, "cookie">): Promise<Person> {
    const first = await authCall("/sign-in/email", { body: { email: u.email, password: GOOD_PASSWORD } });
    expect(first.status, `${u.label}: password step`).toBe(200);
    const firstCookie = cookieFrom(first);
    const en = await authCall("/two-factor/enable", { body: { password: GOOD_PASSWORD }, cookie: firstCookie });
    expect(en.status, `${u.label}: enable`).toBe(200);
    const secret = new URL(((await en.json()) as { totpURI: string }).totpURI).searchParams.get("secret")!;
    const verified = await authCall("/two-factor/verify-totp", { body: { code: totpCode(secret) }, cookie: firstCookie });
    expect(verified.status, `${u.label}: first code`).toBe(200);
    return { ...u, secret, cookie: cookieFrom(verified) };
  }

  const makePerson = async (orgId: string, label: string, role: "owner" | "associate" | "admin") => enroll(await seedUser(orgId, label, role));

  // ---- requests through the real route modules --------------------------------------------
  type Hdrs = Record<string, string>;
  async function get(who: { label: string; orgId: string; cookie?: string }, handler: Handler, path: string, extra: Hdrs = {}, ctx?: { id: string }) {
    const headers = new Headers({ "user-agent": "vitest", ...extra });
    if (who.cookie) headers.set("cookie", who.cookie);
    const res = await handler(new Request(`${BASE}${path}`, { headers }), ctx ? { params: Promise.resolve(ctx) } : undefined);
    const text = await res.text();
    seen.push({ caller: who.label, orgId: who.orgId, text });
    return { status: res.status, text, json: (text ? JSON.parse(text) : {}) as Body, headers: res.headers };
  }
  const list = (who: Parameters<typeof get>[0], qs = "", extra: Hdrs = {}) => get(who, clientsGET, `/api/clients${qs}`, extra);
  const one = (who: Parameters<typeof get>[0], id: string, extra: Hdrs = {}) => get(who, clientGET, `/api/clients/${id}`, extra, { id });
  const ids = (r: { json: Body }) => (r.json.data as ClientJson[]).map((c) => c.id).sort();

  async function auditRows(orgId: string, action: string) {
    return owner.select().from(schema.auditLog).where(and(eq(schema.auditLog.organizationId, orgId), eq(schema.auditLog.action, action)));
  }

  // ---- fixtures ----------------------------------------------------------------------------
  let orgA: string;
  let orgB: string;
  let ownerA: Person, assoc1: Person, assoc2: Person, adminA: Person, flipper: Person, leaver: Person, grantee: Person;
  let ownerB: Person, assocB: Person;
  let c1: string, c2: string, c3: string, c4: string, c5: string; // org A
  let b1: string, b2: string; // org B
  const NAME = (s: string) => `Synthetic Child ${s}`;

  async function addClient(orgId: string, label: string, opts: { deleted?: boolean } = {}): Promise<string> {
    const [row] = await owner
      .insert(schema.clients)
      .values({ organizationId: orgId, displayName: NAME(label), gradeLevel: "3", deletedAt: opts.deleted ? new Date() : null })
      .returning();
    return row.id;
  }
  async function assign(orgId: string, clientId: string, userId: string, byUserId: string, ended = false): Promise<string> {
    const [row] = await owner
      .insert(schema.clientAssignments)
      .values({ organizationId: orgId, clientId, userId, assignedByUserId: byUserId, deletedAt: ended ? new Date() : null })
      .returning();
    return row.id;
  }

  beforeAll(async () => {
    ownerPool = new Pool({ connectionString: OWNER_URL });
    owner = drizzle(ownerPool, { schema }) as Db;

    async function loginUrl(name: string, group: string): Promise<string> {
      const exists = await owner.execute(sql`select 1 from pg_roles where rolname = ${name}`);
      const stmt = exists.rows.length ? "ALTER ROLE" : "CREATE ROLE";
      const tail = exists.rows.length ? "" : ` IN ROLE ${group}`;
      await owner.execute(sql.raw(`${stmt} ${name} LOGIN PASSWORD '${PASSWORD}'${tail}`));
      const url = new URL(OWNER_URL!);
      url.username = name;
      url.password = PASSWORD!;
      return url.toString();
    }
    // The app's own configuration, pointed at the scratch branch with the two real least-privilege
    // roles. Set BEFORE the route modules are imported: the environment is read once, on first use.
    process.env.DATABASE_URL = await loginUrl(APP_ROLE, "app_runtime");
    process.env.AUTH_DATABASE_URL = await loginUrl(AUTH_ROLE, "auth_runtime");
    process.env.BETTER_AUTH_SECRET = SECRET;
    process.env.BETTER_AUTH_URL = BASE;
    process.env.EMAIL_TRANSPORT = "console";
    // The console mail transport prints enrollment notices; keep the test output readable.
    vi.spyOn(console, "info").mockImplementation(() => {});

    const server = await import("./server");
    handle = (request) => server.getAuth().handler(request);
    hashPassword = (await server.getAuth().$context).password.hash;
    clientsGET = (await import("@/app/api/clients/route")).GET as Handler;
    clientGET = (await import("@/app/api/clients/[id]/route")).GET as Handler;
    meGET = (await import("@/app/api/me/route")).GET as Handler;
    guardedRoute = (await import("./guard")).guardedRoute;

    orgA = await seedOrg("authz-A");
    orgB = await seedOrg("authz-B");
    // Sign-ins are the slow part (several round trips each); run the people in parallel.
    [ownerA, assoc1, assoc2, adminA, flipper, leaver, grantee, ownerB, assocB] = await Promise.all([
      makePerson(orgA, "owner-a", "owner"),
      makePerson(orgA, "assoc-1", "associate"),
      makePerson(orgA, "assoc-2", "associate"),
      makePerson(orgA, "admin-a", "admin"),
      makePerson(orgA, "flipper", "associate"),
      makePerson(orgA, "leaver", "associate"),
      makePerson(orgA, "grantee", "associate"),
      makePerson(orgB, "owner-b", "owner"),
      makePerson(orgB, "assoc-b", "associate"),
    ]);

    // Org A: c1 (assoc1 and flipper), c2 (assoc2), c3 (nobody), c4 (assoc1, assignment ended),
    // c5 (assoc1, but the client is soft-deleted).
    [c1, c2, c3, c4, c5] = [
      await addClient(orgA, "A1"),
      await addClient(orgA, "A2"),
      await addClient(orgA, "A3"),
      await addClient(orgA, "A4"),
      await addClient(orgA, "A5", { deleted: true }),
    ];
    await assign(orgA, c1, assoc1.userId, ownerA.userId);
    await assign(orgA, c1, flipper.userId, ownerA.userId);
    await assign(orgA, c2, assoc2.userId, ownerA.userId);
    await assign(orgA, c4, assoc1.userId, ownerA.userId, true);
    await assign(orgA, c5, assoc1.userId, ownerA.userId);
    await assign(orgA, c1, leaver.userId, ownerA.userId);
    // Org B: b1 (assocB), b2 (nobody).
    [b1, b2] = [await addClient(orgB, "B1"), await addClient(orgB, "B2")];
    await assign(orgB, b1, assocB.userId, ownerB.userId);
  }, 300_000);

  afterAll(async () => {
    await ownerPool?.end();
  });

  // ---------------------------------------------------------------------------------------
  describe("no valid session, no data (audit 03 item 4; 04 item 6)", () => {
    it("no cookie: 401 in the standard shape on every route, and the handlers never touch the database", async () => {
      const nobody = { label: "nobody", orgId: "none" };
      for (const r of [await get(nobody, meGET, "/api/me"), await list(nobody), await one(nobody, c1)]) {
        expect(r.status).toBe(401);
        expect(r.json).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue." } });
      }
    });

    it("forged, truncated and borrowed-name cookies are all 401", async () => {
      for (const cookie of ["rg.session_token=forged.value", "rg.session_token=", `rg.session_token=${assoc1.cookie.split("=")[1]?.split(".")[0]}`, "better-auth.session_token=x"]) {
        const r = await list({ label: "forger", orgId: "none", cookie });
        expect(r.status, cookie).toBe(401);
      }
    });

    it("a password-only session (sign-in step done, no authenticator code yet) is 401", async () => {
      const u = await seedUser(orgA, "no-mfa", "owner"); // never enrolled
      const res = await authCall("/sign-in/email", { body: { email: u.email, password: GOOD_PASSWORD } });
      const cookie = cookieFrom(res);
      expect(cookie).not.toBe("");
      expect((await list({ label: "no-mfa", orgId: orgA, cookie })).status).toBe(401);
      expect((await get({ label: "no-mfa", orgId: orgA, cookie }, meGET, "/api/me")).status).toBe(401);
    });

    it("the half-finished sign-in of an enrolled user (code step pending) is 401", async () => {
      const res = await authCall("/sign-in/email", { body: { email: assoc1.email, password: GOOD_PASSWORD } });
      expect(((await res.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
      const cookie = cookieFrom(res);
      expect(cookie).not.toBe("");
      expect((await list({ label: "half", orgId: orgA, cookie })).status).toBe(401);
    });

    it("a deactivated user is 401 on the very next request, and their sessions are gone", async () => {
      expect((await list(leaver)).status).toBe(200);
      await owner.update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, leaver.userId));
      expect((await list(leaver)).status).toBe(401);
      expect((await one(leaver, c1)).status).toBe(401);
      const left = await owner.select().from(schema.authSessions).where(eq(schema.authSessions.userId, leaver.userId));
      expect(left).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("owner: the whole practice, and only the practice (audit 03 item 3)", () => {
    it("lists every live client of its organization, none soft-deleted, none of another practice", async () => {
      const r = await list(ownerA);
      expect(r.status).toBe(200);
      expect(ids(r)).toEqual([c1, c2, c3, c4].sort());
      expect(r.text).not.toContain(c5);
      expect(r.text).not.toContain(b1);
      expect(r.text).not.toContain(NAME("B1"));
    });

    it("reads each of its clients by id", async () => {
      for (const id of [c1, c2, c3, c4]) {
        const r = await one(ownerA, id);
        expect(r.status, id).toBe(200);
        expect((r.json.data as ClientJson).id).toBe(id);
      }
    });

    it("cannot read another practice's client by id: 404, identical to an id that does not exist", async () => {
      const foreign = await one(ownerA, b1);
      const missing = await one(ownerA, crypto.randomUUID());
      expect(foreign.status).toBe(404);
      expect(foreign.json).toEqual(missing.json);
      expect(foreign.text).not.toContain(NAME("B1"));
      expect((await one(ownerA, b2)).status).toBe(404);
      // and the soft-deleted client of its own practice
      expect((await one(ownerA, c5)).status).toBe(404);
    });

    it("the other practice's owner has the mirror-image view", async () => {
      expect(ids(await list(ownerB))).toEqual([b1, b2].sort());
      for (const id of [c1, c2, c3, c4, c5]) expect((await one(ownerB, id)).status, id).toBe(404);
    });

    it("the organization comes from the session, never from the request", async () => {
      const spoofed = { "x-organization-id": orgB, "x-org-id": orgB, "x-role": "owner", "x-user-id": ownerB.userId };
      expect(ids(await list(assoc1, "", spoofed))).toEqual([c1]);
      expect((await one(assoc1, b1, spoofed)).status).toBe(404);
      // as query parameters they are not accepted at all
      expect((await list(ownerA, `?organizationId=${orgB}`)).status).toBe(400);
      expect((await list(ownerA, "?role=owner")).status).toBe(400);
    });

    it("the owner's own call returns the role the database holds", async () => {
      const r = await get(ownerA, meGET, "/api/me");
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ id: ownerA.userId, role: "owner" });
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("associate: assigned clients only (audit 03 item 3)", () => {
    it("sees exactly the clients with an active assignment, and no other client of the same practice", async () => {
      expect(ids(await list(assoc1))).toEqual([c1]); // not c2, c3, the ended c4, or the deleted c5
      expect(ids(await list(assoc2))).toEqual([c2]);
    });

    it("reads an assigned client, and gets the same 404 for every client it may not see", async () => {
      expect((await one(assoc1, c1)).status).toBe(200);
      const missing = await one(assoc1, crypto.randomUUID());
      for (const [name, id] of [["someone else's", c2], ["unassigned", c3], ["assignment ended", c4], ["client deleted", c5], ["other practice", b1]] as const) {
        const r = await one(assoc1, id);
        expect(r.status, name).toBe(404);
        expect(r.json, name).toEqual(missing.json);
      }
      expect((await one(assoc2, c1)).status).toBe(404);
    });

    it("an associate of the other practice sees only its own assignment, and none of org A's", async () => {
      expect(ids(await list(assocB))).toEqual([b1]);
      for (const id of [c1, c2, c3, c4]) expect((await one(assocB, id)).status, id).toBe(404);
      expect((await one(assocB, b2)).status).toBe(404); // own practice, not assigned
    });

    it("a new assignment applies on the next request, and ending it applies just as fast", async () => {
      expect(ids(await list(grantee))).toEqual([]);
      expect((await one(grantee, c3)).status).toBe(404);
      const id = await assign(orgA, c3, grantee.userId, ownerA.userId);
      expect((await one(grantee, c3)).status).toBe(200);
      expect(ids(await list(grantee))).toEqual([c3]);
      await owner.update(schema.clientAssignments).set({ deletedAt: new Date() }).where(eq(schema.clientAssignments.id, id));
      expect((await one(grantee, c3)).status).toBe(404);
      expect(ids(await list(grantee))).toEqual([]);
      // granted again later: a fresh row, visible again
      await assign(orgA, c3, grantee.userId, ownerA.userId);
      expect((await one(grantee, c3)).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("role is read from the database on every request (audit 03 item 2)", () => {
    it("demotion and promotion apply on the next request with the same cookie", async () => {
      expect(ids(await list(flipper))).toEqual([c1]); // associate
      await owner.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, flipper.userId));
      expect((await list(flipper)).status).toBe(403);
      expect((await one(flipper, c1)).status).toBe(403);
      expect((await get(flipper, meGET, "/api/me")).json.role).toBe("admin");
      await owner.update(schema.users).set({ role: "owner" }).where(eq(schema.users.id, flipper.userId));
      expect(ids(await list(flipper))).toEqual([c1, c2, c3, c4].sort()); // owner: the whole practice
      await owner.update(schema.users).set({ role: "associate" }).where(eq(schema.users.id, flipper.userId));
      expect(ids(await list(flipper))).toEqual([c1]);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("admin: no clinical content (option A)", () => {
    it("is refused on the client routes with 403 and no client data in the response", async () => {
      const l = await list(adminA);
      const o = await one(adminA, c1);
      for (const r of [l, o]) {
        expect(r.status).toBe(403);
        expect(r.json).toEqual({ error: { code: "forbidden", message: "You do not have access to this." } });
        expect(r.text).not.toContain("Synthetic Child");
        expect(r.text).not.toContain(c1);
      }
    });

    it("is not told whether a client exists: the same 403 for a real id, another practice's id and a made-up one", async () => {
      const real = await one(adminA, c1);
      for (const id of [b1, crypto.randomUUID()]) expect((await one(adminA, id)).json).toEqual(real.json);
    });

    it("can still ask who it is", async () => {
      expect((await get(adminA, meGET, "/api/me")).json).toEqual({ id: adminA.userId, role: "admin" });
    });

    it("each refusal is audited with the role and a fixed reason, and no client data", async () => {
      const rows = await auditRows(orgA, "authz.denied");
      const mine = rows.filter((r) => r.actorUserId === adminA.userId);
      expect(mine.length).toBeGreaterThanOrEqual(3);
      for (const row of mine) {
        expect(row).toMatchObject({ outcome: "denied", resourceType: "client" });
        expect(row.metadata).toEqual({ role: "admin", reason: "role_not_allowed" });
      }
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("what comes back", () => {
    const KEYS = ["createdAt", "dateOfBirth", "displayName", "externalId", "gradeLevel", "id"];

    it("only the allow-listed client fields: no organization id, no deletion state, no internals", async () => {
      const r = await list(ownerA);
      for (const c of r.json.data as Record<string, unknown>[]) expect(Object.keys(c).sort()).toEqual(KEYS);
      const one1 = await one(ownerA, c1);
      expect(Object.keys(one1.json.data as ClientJson).sort()).toEqual(KEYS);
      expect(JSON.stringify([r.json, one1.json])).not.toMatch(new RegExp(`${orgA}|organization|deleted|updated`, "i"));
    });

    it("every response is private, no-store", async () => {
      for (const r of [await list(ownerA), await one(ownerA, c1), await one(ownerA, b1), await list({ label: "x", orgId: "none" })]) {
        expect(r.headers.get("cache-control")).toBe("private, no-store");
      }
    });

    it("no CORS headers are ever sent, even to a cross-site Origin (audit 04 item 5)", async () => {
      const cross = { origin: "https://evil.example.test" };
      for (const r of [await get(ownerA, clientsGET, "/api/clients", cross), await get(ownerA, clientGET, `/api/clients/${c1}`, cross, { id: c1 }), await get(adminA, clientsGET, "/api/clients", cross), await get({ label: "x", orgId: "none" }, clientsGET, "/api/clients", cross)]) {
        for (const name of ["access-control-allow-origin", "access-control-allow-credentials", "access-control-allow-methods"]) expect(r.headers.get(name), name).toBeNull();
      }
    });

    it("paging: a page is capped, pages do not overlap, and bad values are rejected", async () => {
      const p1 = await list(ownerA, "?limit=2");
      const p2 = await list(ownerA, "?limit=2&offset=2");
      expect(p1.json.data).toHaveLength(2);
      expect(p2.json.data).toHaveLength(2);
      expect(new Set([...ids(p1), ...ids(p2)]).size).toBe(4);
      expect(p1.json).toMatchObject({ limit: 2, offset: 0 });
      for (const qs of ["?limit=0", "?limit=101", "?limit=abc", "?limit=1.5", "?offset=-1", "?offset=10001", "?limit=1&limit=2&x=1", "?limit=1;drop%20table%20clients"]) {
        expect((await list(ownerA, qs)).status, qs).toBe(400);
      }
    });

    it("a malformed id is a 400 and never reaches SQL", async () => {
      for (const id of ["not-a-uuid", "1", "' or 1=1 --", "33333333-3333-4333-8333-33333333333", "%00"]) {
        const r = await one(ownerA, id);
        expect(r.status, id).toBe(400);
        expect(r.json.error?.code).toBe("validation_failed");
      }
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("sensitive reads are audited, with ids and not names (audit 03 item 7; 04 item 9)", () => {
    it("listing writes client.listed and viewing writes client.viewed with the client id", async () => {
      await list(ownerA);
      await one(ownerA, c2);
      const listed = await auditRows(orgA, "client.listed");
      expect(listed.some((r) => r.actorUserId === ownerA.userId && (r.metadata as Record<string, unknown>).role === "owner")).toBe(true);
      const viewed = await auditRows(orgA, "client.viewed");
      expect(viewed.some((r) => r.actorUserId === ownerA.userId && r.resourceId === c2 && r.resourceType === "client")).toBe(true);
    });

    it("a view of a client the caller may not see writes no client.viewed row", async () => {
      const before = (await auditRows(orgA, "client.viewed")).filter((r) => r.resourceId === c3 && r.actorUserId === assoc1.userId).length;
      expect((await one(assoc1, c3)).status).toBe(404);
      const after = (await auditRows(orgA, "client.viewed")).filter((r) => r.resourceId === c3 && r.actorUserId === assoc1.userId).length;
      expect(after).toBe(before);
    });

    it("audit rows are scoped to the actor's practice and carry no client name or content", async () => {
      await list(ownerB);
      for (const action of ["client.listed", "client.viewed", "authz.denied"]) {
        for (const [org, other] of [[orgA, orgB], [orgB, orgA]] as const) {
          const rows = await auditRows(org, action);
          for (const row of rows) {
            expect(row.organizationId).toBe(org);
            expect(JSON.stringify(row)).not.toMatch(/Synthetic Child|display_?name|date_?of_?birth/i);
            expect(JSON.stringify(row)).not.toContain(other);
          }
        }
      }
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("state-changing requests must come from the app's own origin (CSRF)", () => {
    // No client route changes anything yet, so the guard is exercised through a handler built in
    // this test with the production guardedRoute: the same code every future POST will use.
    const probe = () =>
      guardedRoute({ roles: ["owner"], resource: "client", handler: async ({ session }) => Response.json({ ok: true, role: session.role }) });
    const post = (who: Person | { cookie?: string }, origin: string | null, method = "POST") => {
      const headers = new Headers();
      if (who.cookie) headers.set("cookie", who.cookie);
      if (origin !== null) headers.set("origin", origin);
      return probe()(new Request(`${BASE}/api/probe`, { method, headers }));
    };

    it("a cross-site or missing Origin is 403 even with a valid owner session", async () => {
      for (const origin of ["https://evil.example.test", "null", `${BASE}.evil.test`, null]) {
        for (const method of ["POST", "PATCH", "DELETE"]) {
          const res = await post(ownerA, origin, method);
          expect(res.status, `${method} from ${origin}`).toBe(403);
          expect((await res.json()).error.code).toBe("forbidden_origin");
        }
      }
    });

    it("the app's own origin passes the origin check; then session and role still apply", async () => {
      expect((await post(ownerA, BASE)).status).toBe(200);
      expect((await post({}, BASE)).status).toBe(401); // right origin, no session
      expect((await post(assoc1, BASE)).status).toBe(403); // right origin, wrong role
      expect((await post(adminA, BASE)).status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("nothing from one practice reached the other (the whole run)", () => {
    it("no response a practice B caller received contains any practice A id or name, and vice versa", () => {
      const idsA = [orgA, ownerA.userId, assoc1.userId, assoc2.userId, adminA.userId, c1, c2, c3, c4, c5];
      const idsB = [orgB, ownerB.userId, assocB.userId, b1, b2];
      const namesA = ["A1", "A2", "A3", "A4", "A5"].map(NAME);
      const namesB = ["B1", "B2"].map(NAME);
      const fromB = seen.filter((s) => s.orgId === orgB);
      const fromA = seen.filter((s) => s.orgId === orgA);
      expect(fromB.length).toBeGreaterThan(5);
      expect(fromA.length).toBeGreaterThan(20);
      for (const s of fromB) for (const needle of [...idsA, ...namesA]) expect(s.text, `${s.caller} saw ${needle}`).not.toContain(needle);
      for (const s of fromA) for (const needle of [...idsB, ...namesB]) expect(s.text, `${s.caller} saw ${needle}`).not.toContain(needle);
    });

    it("an associate never received a client it is not assigned to", () => {
      const forbidden: Record<string, string[]> = {
        "assoc-1": [NAME("A2"), NAME("A3"), NAME("A4"), NAME("A5")],
        "assoc-2": [NAME("A1"), NAME("A4"), NAME("A5")],
        "assoc-b": [NAME("B2")],
      };
      for (const s of seen) for (const needle of forbidden[s.caller] ?? []) expect(s.text, `${s.caller} saw ${needle}`).not.toContain(needle);
    });
  });
});
