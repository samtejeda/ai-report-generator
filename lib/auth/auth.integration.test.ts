import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { Pool } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import { audit } from "@/lib/audit";
import * as schema from "@/lib/db/schema";
import type { Mail } from "@/lib/email";
import { createAuth, type Auth } from "./auth";
import { resolveSession } from "./session";

// Auth flows against a scratch Neon branch (the `test` branch of the dev project), through the
// REAL Better Auth handler and the REAL database roles: auth_runtime for Better Auth,
// app_runtime for audit writes and the cross-role checks. Needs TEST_* variables from
// .env.test.local (gitignored); skipped when absent. Synthetic data only: every fixture is a
// fresh random organization at example.test addresses. audit_log rows cannot be deleted by
// design, so runs accumulate; reset the test branch from dev when it gets heavy.
try {
  process.loadEnvFile(".env.test.local");
} catch {}

vi.setConfig({ testTimeout: 60_000 });

const OWNER_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = process.env.TEST_APP_ROLE_PASSWORD;
const ENABLED = Boolean(OWNER_URL && PASSWORD && /^[a-f0-9]{32,}$/.test(PASSWORD));
const APP_ROLE = "app_runtime_authtest";
const AUTH_ROLE = "auth_runtime_test";

const INSUFFICIENT_PRIVILEGE = "42501";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

function pgCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const rec = cur as { code?: unknown; cause?: unknown };
    if (typeof rec.code === "string" && /^[0-9A-Z]{5}$/.test(rec.code)) return rec.code;
    cur = rec.cause;
  }
  return undefined;
}

async function expectPgError(p: PromiseLike<unknown>, code: string) {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, "expected the statement to fail").toBeDefined();
  expect(pgCode(err), String((err as Error)?.message)).toBe(code);
}

async function expectPgErrorLabelled(label: string, p: PromiseLike<unknown>, code: string) {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, `${label}: expected the statement to fail`).toBeDefined();
  expect(pgCode(err), `${label}: ${String((err as Error)?.message)}`).toBe(code);
}

type Db = NeonDatabase<typeof schema> & { $client: Pool };
const BASE = "http://localhost:3000";
const SECRET = "test-secret-".padEnd(48, "x");
const GOOD_PASSWORD = "correct horse battery staple 1";

describe.skipIf(!ENABLED)("authentication (Neon test branch)", () => {
  let ownerPool: Pool;
  let appPool: Pool;
  let authPool: Pool;
  let owner: Db; // table owner: fixtures and direct inspection only
  let app: Db; // app_runtime member
  let authDb: Db; // auth_runtime member
  let auth: Auth;
  const outbox: Mail[] = [];
  let hash: (password: string) => Promise<string>;
  // Rate-limit counters persist in the test database for 15 minutes, so every run (and every
  // call) uses addresses no earlier run used.
  const runOctets = `${crypto.getRandomValues(new Uint8Array(2)).join(".")}`;
  let ipCounter = 1;
  const nextIp = () => `10.${runOctets}.${ipCounter++ % 250}`;
  const now = () => new Date();
  const seededOrgs: string[] = [];

  const emailFor = (label: string) => `${label}-${crypto.randomUUID()}@example.test`;

  type Fx = { orgId: string; userId: string; email: string };

  async function seedUser(
    orgId: string,
    label: string,
    opts: { verified?: boolean; deleted?: boolean; role?: "owner" | "associate" | "admin"; password?: string | null } = {},
  ): Promise<Fx> {
    const email = emailFor(label);
    const [u] = await owner
      .insert(schema.users)
      .values({
        organizationId: orgId,
        email,
        displayName: `Synthetic ${label}`,
        role: opts.role ?? "owner",
        emailVerified: opts.verified ?? true,
        deletedAt: opts.deleted ? new Date() : null,
      })
      .returning();
    if (opts.password !== null) {
      await owner.insert(schema.authAccounts).values({
        userId: u.id,
        accountId: u.id,
        providerId: "credential",
        password: await hash(opts.password ?? GOOD_PASSWORD),
      });
    }
    return { orgId, userId: u.id, email };
  }

  async function seedOrg(label: string): Promise<string> {
    const [org] = await owner.insert(schema.organizations).values({ name: `Synthetic Org ${label}` }).returning();
    seededOrgs.push(org.id);
    return org.id;
  }

  type CallOptions = { body?: unknown; cookie?: string; ip?: string; origin?: string | null; method?: string };
  async function call(path: string, o: CallOptions = {}): Promise<Response> {
    const headers = new Headers({ "content-type": "application/json", "x-forwarded-for": o.ip ?? nextIp(), "user-agent": "vitest" });
    if (o.origin !== null) headers.set("origin", o.origin ?? BASE);
    if (o.cookie) headers.set("cookie", o.cookie);
    return auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: o.method ?? (o.body === undefined ? "GET" : "POST"),
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        redirect: "manual",
      }),
    );
  }

  function cookieFrom(res: Response): string {
    return res
      .headers.getSetCookie()
      .map((c) => c.split(";")[0])
      .filter((c) => !/=$/.test(c))
      .join("; ");
  }

  async function signIn(email: string, password = GOOD_PASSWORD, ip?: string) {
    const res = await call("/sign-in/email", { body: { email, password }, ip });
    return { res, cookie: cookieFrom(res) };
  }

  // The older tests below use users without an authenticator, so they resolve with the enrollment
  // variant; the MFA block uses `strictSession`, which is what requireSession() really does.
  const session = (cookie: string) => resolveSession(new Headers({ cookie }), { auth, authDb, now, allowUnenrolled: true });
  const strictSession = (cookie: string) => resolveSession(new Headers({ cookie }), { auth, authDb, now });

  async function auditRows(orgId: string, action?: string) {
    const conds = [eq(schema.auditLog.organizationId, orgId)];
    if (action) conds.push(eq(schema.auditLog.action, action));
    return owner.select().from(schema.auditLog).where(and(...conds));
  }

  function tokenFromMail(mail: Mail): string {
    const url = mail.text.match(/https?:\/\/\S+/)![0];
    return new URL(url).pathname.split("/").pop()!;
  }

  async function mailTo(email: string, subject: RegExp): Promise<Mail[]> {
    // Reset and verification mail is sent after the response; give the handler a moment.
    for (let i = 0; i < 40; i++) {
      const found = outbox.filter((m) => m.to === email && subject.test(m.subject));
      if (found.length) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    return [];
  }

  beforeAll(async () => {
    ownerPool = new Pool({ connectionString: OWNER_URL });
    owner = drizzle(ownerPool, { schema });

    async function loginRole(name: string, group: string) {
      const exists = await owner.execute(sql`select 1 from pg_roles where rolname = ${name}`);
      const stmt = exists.rows.length ? "ALTER ROLE" : "CREATE ROLE";
      const tail = exists.rows.length ? "" : ` IN ROLE ${group}`;
      await owner.execute(sql.raw(`${stmt} ${name} LOGIN PASSWORD '${PASSWORD}'${tail}`));
      const url = new URL(OWNER_URL!);
      url.username = name;
      url.password = PASSWORD!;
      const pool = new Pool({ connectionString: url.toString() });
      return { pool, db: drizzle(pool, { schema }) as Db };
    }
    const a = await loginRole(APP_ROLE, "app_runtime");
    appPool = a.pool;
    app = a.db;
    const b = await loginRole(AUTH_ROLE, "auth_runtime");
    authPool = b.pool;
    authDb = b.db;

    auth = createAuth({
      authDb,
      audit: (actor, event) => audit(actor, event, app),
      mail: { send: async (m) => void outbox.push(m) },
      baseURL: BASE,
      secret: SECRET,
      production: false,
      now,
    });
    hash = (await auth.$context).password.hash;
  }, 180_000);

  afterAll(async () => {
    await Promise.all([appPool?.end(), authPool?.end(), ownerPool?.end()]);
  });

  describe("sign-in", () => {
    it("issues a session for a verified user with an httpOnly, SameSite=Lax cookie that lives as long as the absolute cap", async () => {
      const orgId = await seedOrg("signin");
      const u = await seedUser(orgId, "signin");
      const { res, cookie } = await signIn(u.email);
      expect(res.status).toBe(200);
      const setCookie = res.headers.getSetCookie().join("\n");
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Lax/i);
      expect(setCookie).toMatch(/Max-Age=43200/); // 12 h
      expect(setCookie).toMatch(/Path=\//);
      const ctx = await session(cookie);
      expect(ctx).toEqual({ userId: u.userId, organizationId: orgId, role: "owner", signedInAt: expect.any(Date) });
    });

    it("sets the idle deadline to 2 hours, not the 12 hour cap", async () => {
      const orgId = await seedOrg("idle");
      const u = await seedUser(orgId, "idle");
      await signIn(u.email);
      const [row] = await owner.select().from(schema.authSessions).where(eq(schema.authSessions.userId, u.userId));
      const hours = (row.expiresAt.getTime() - row.createdAt.getTime()) / 3_600_000;
      expect(hours).toBeGreaterThan(1.99);
      expect(hours).toBeLessThan(2.01);
    });

    it("never returns a password hash, and stores a scrypt hash rather than the password", async () => {
      const orgId = await seedOrg("hash");
      const u = await seedUser(orgId, "hash");
      const { res } = await signIn(u.email);
      const text = await res.text();
      expect(text).not.toMatch(/password|[0-9a-f]{64}/i);
      const [acct] = await owner.select().from(schema.authAccounts).where(eq(schema.authAccounts.userId, u.userId));
      expect(acct.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/); // salt:scrypt-derived-key
      expect(acct.password).not.toContain(GOOD_PASSWORD);
      expect(acct.password).not.toMatch(/^\$2[aby]\$/); // not bcrypt: scrypt, as approved
    });

    it("rejects a wrong password with the same answer as an unknown address, and records only the known user", async () => {
      const orgId = await seedOrg("fail");
      const u = await seedUser(orgId, "fail");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const unknownEmail = emailFor("nobody");
      const wrong = await signIn(u.email, "not the password at all");
      const unknown = await signIn(unknownEmail, "not the password at all");
      expect(wrong.res.status).toBe(401);
      expect(unknown.res.status).toBe(401);
      expect(await wrong.res.json()).toEqual(await unknown.res.json());
      expect(wrong.cookie).toBe("");

      const failures = await auditRows(orgId, "auth.login_failed");
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ actorUserId: u.userId, resourceType: "users", resourceId: u.userId, outcome: "failure" });
      expect(failures[0].metadata).toMatchObject({ reason: "bad_credentials" });

      // The unknown address is not recorded anywhere: application log only, and not the address.
      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("auth.login_failed_unknown_user");
      expect(logged).not.toContain(unknownEmail);
      expect(logged).not.toContain(u.email);
      warn.mockRestore();
      const sessions = await owner.select().from(schema.authSessions).where(eq(schema.authSessions.userId, u.userId));
      expect(sessions).toHaveLength(0);
    });

    it("writes login success to the audit log with ids and the client address only", async () => {
      const orgId = await seedOrg("audit-login");
      const u = await seedUser(orgId, "audit-login");
      const ip = nextIp();
      await signIn(u.email, GOOD_PASSWORD, ip);
      const rows = await auditRows(orgId, "auth.login");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorUserId: u.userId, resourceType: "users", resourceId: u.userId, outcome: "success" });
      expect(rows[0].metadata).toEqual({ ip, method: "password" });
    });

    it("refuses an unverified address even with the right password, sends a new link, and audits it", async () => {
      const orgId = await seedOrg("unverified");
      const u = await seedUser(orgId, "unverified", { verified: false });
      const { res, cookie } = await signIn(u.email);
      expect(res.status).toBe(403);
      expect(cookie).toBe("");
      expect((await owner.select().from(schema.authSessions).where(eq(schema.authSessions.userId, u.userId)))).toHaveLength(0);
      const mails = await mailTo(u.email, /verify/i);
      expect(mails.length).toBeGreaterThan(0);
      const failures = await auditRows(orgId, "auth.login_failed");
      expect(failures[0].metadata).toMatchObject({ reason: "email_not_verified" });
    });

    it("verifying the emailed link marks the address verified, audits it, and still issues no session by itself", async () => {
      const orgId = await seedOrg("verify");
      const u = await seedUser(orgId, "verify", { verified: false });
      await signIn(u.email);
      const [mail] = await mailTo(u.email, /verify/i);
      const url = new URL(mail.text.match(/https?:\/\/\S+/)![0]);
      const res = await call(`${url.pathname.replace("/api/auth", "")}${url.search}`, { method: "GET" });
      expect([200, 302]).toContain(res.status);
      expect(cookieFrom(res)).toBe(""); // autoSignInAfterVerification is off
      const [row] = await owner.select().from(schema.users).where(eq(schema.users.id, u.userId));
      expect(row.emailVerified).toBe(true);
      expect(await auditRows(orgId, "auth.email_verified")).toHaveLength(1);
      const { res: login } = await signIn(u.email);
      expect(login.status).toBe(200);
    });

    it("refuses a deactivated user, creates no session, and audits the refusal", async () => {
      const orgId = await seedOrg("deactivated");
      const u = await seedUser(orgId, "deactivated", { deleted: true });
      const { res, cookie } = await signIn(u.email);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(cookie).toBe("");
      expect((await owner.select().from(schema.authSessions).where(eq(schema.authSessions.userId, u.userId)))).toHaveLength(0);
      const failures = await auditRows(orgId, "auth.login_failed");
      expect(failures).toHaveLength(1);
      expect(failures[0].metadata).toMatchObject({ reason: "deactivated" });
    });

    it("has no self sign-up: the endpoint creates no user", async () => {
      const email = emailFor("selfreg");
      const res = await call("/sign-up/email", { body: { email, password: GOOD_PASSWORD, name: "Nobody" } });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await owner.select().from(schema.users).where(eq(schema.users.email, email))).toHaveLength(0);
    });
  });

  describe("session lifecycle", () => {
    const ago = (ms: number) => new Date(Date.now() - ms);
    const ahead = (ms: number) => new Date(Date.now() + ms);
    const H = 3_600_000;
    const M = 60_000;

    async function login(label: string, opts: Parameters<typeof seedUser>[2] = {}) {
      const orgId = await seedOrg(label);
      const u = await seedUser(orgId, label, opts);
      const { cookie } = await signIn(u.email);
      const [row] = await owner.select().from(schema.authSessions).where(eq(schema.authSessions.userId, u.userId));
      return { ...u, cookie, sessionId: row.id };
    }
    const sessionRow = async (id: string) => (await owner.select().from(schema.authSessions).where(eq(schema.authSessions.id, id)))[0];

    it("logout invalidates the session server-side, clears the cookie, and is audited", async () => {
      const u = await login("logout");
      expect(await session(u.cookie)).not.toBeNull();
      const res = await call("/sign-out", { body: {}, cookie: u.cookie });
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie().join("\n")).toMatch(/Max-Age=0/);
      expect(await sessionRow(u.sessionId)).toBeUndefined();
      // Replaying the old cookie after logout gets nothing.
      expect(await session(u.cookie)).toBeNull();
      const rows = await auditRows(u.orgId, "auth.logout");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorUserId: u.userId, outcome: "success" });
    });

    it("a session idle for more than 2 hours is rejected", async () => {
      const u = await login("idle-expired");
      await owner.update(schema.authSessions).set({ expiresAt: ago(1 * M) }).where(eq(schema.authSessions.id, u.sessionId));
      expect(await session(u.cookie)).toBeNull();
    });

    it("activity pushes the idle deadline out to 2 hours again", async () => {
      const u = await login("slide");
      await owner
        .update(schema.authSessions)
        .set({ updatedAt: ago(10 * M), expiresAt: ahead(30 * M) })
        .where(eq(schema.authSessions.id, u.sessionId));
      expect(await session(u.cookie)).not.toBeNull();
      const row = await sessionRow(u.sessionId);
      const left = row.expiresAt.getTime() - Date.now();
      expect(left).toBeGreaterThan(2 * H - 30_000);
      expect(left).toBeLessThanOrEqual(2 * H);
    });

    it("does not write on every request: a session touched a moment ago is left alone", async () => {
      const u = await login("throttle");
      const before = await sessionRow(u.sessionId);
      await session(u.cookie);
      await session(u.cookie);
      const after = await sessionRow(u.sessionId);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
    });

    it("never slides past the 12 hour absolute cap", async () => {
      const u = await login("cap-slide");
      await owner
        .update(schema.authSessions)
        .set({ createdAt: ago(11.5 * H), updatedAt: ago(10 * M), expiresAt: ahead(30 * M) })
        .where(eq(schema.authSessions.id, u.sessionId));
      expect(await session(u.cookie)).not.toBeNull();
      const row = await sessionRow(u.sessionId);
      // 30 minutes of the cap are left, so the deadline is the cap, not now + 2 h.
      const left = row.expiresAt.getTime() - Date.now();
      expect(left).toBeGreaterThan(29 * M);
      expect(left).toBeLessThan(31 * M);
    });

    it("a session older than 12 hours is rejected and deleted even though it was just active", async () => {
      const u = await login("cap-expired");
      await owner
        .update(schema.authSessions)
        .set({ createdAt: ago(12 * H + M), updatedAt: new Date(), expiresAt: ahead(2 * H) })
        .where(eq(schema.authSessions.id, u.sessionId));
      expect(await session(u.cookie)).toBeNull();
      expect(await sessionRow(u.sessionId)).toBeUndefined();
    });

    it("reads role and organization from the database on every request", async () => {
      const u = await login("role-change", { role: "associate" });
      expect(await session(u.cookie)).toEqual({ userId: u.userId, organizationId: u.orgId, role: "associate", signedInAt: expect.any(Date) });
      await owner.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, u.userId));
      expect(await session(u.cookie)).toEqual({ userId: u.userId, organizationId: u.orgId, role: "admin", signedInAt: expect.any(Date) });
    });

    it("a user deactivated mid-session loses the session and all others", async () => {
      const u = await login("deactivate-midway", { role: "associate" });
      const second = await signIn(u.email);
      expect(second.cookie).not.toBe("");
      await owner.update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, u.userId));
      expect(await session(u.cookie)).toBeNull();
      expect(await owner.select().from(schema.authSessions).where(eq(schema.authSessions.userId, u.userId))).toHaveLength(0);
      expect(await session(second.cookie)).toBeNull();
    });

    it("an address that stops being verified loses access", async () => {
      const u = await login("unverify");
      await owner.update(schema.users).set({ emailVerified: false }).where(eq(schema.users.id, u.userId));
      expect(await session(u.cookie)).toBeNull();
    });

    it("rejects a tampered or unsigned cookie", async () => {
      const u = await login("tamper");
      const name = u.cookie.split("=")[0];
      const value = u.cookie.slice(name.length + 1);
      expect(await session(`${name}=${value.slice(0, -2)}xx`)).toBeNull();
      const token = decodeURIComponent(value).split(".")[0];
      expect(await session(`${name}=${token}`)).toBeNull(); // the raw token without its signature
      expect(await session("")).toBeNull();
    });

    it("sessions cannot be created from request input: a forged organization changes nothing", async () => {
      const u = await login("forge");
      const other = await seedOrg("forge-other");
      const res = await call("/sign-in/email", { body: { email: u.email, password: GOOD_PASSWORD, organizationId: other, role: "owner" } });
      expect([200, 400]).toContain(res.status);
      expect(await session(cookieFrom(res) || u.cookie)).toMatchObject({ organizationId: u.orgId });
    });
  });

  describe("password reset (audit 03 item 5)", () => {
    const NEW_PASSWORD = "a brand new passphrase 99";

    async function requestReset(email: string, ip?: string) {
      return call("/request-password-reset", { body: { email, redirectTo: "/reset-password" }, ip });
    }
    async function resetLink(label: string) {
      const orgId = await seedOrg(label);
      const u = await seedUser(orgId, label);
      const before = outbox.length;
      const res = await requestReset(u.email);
      expect(res.status).toBe(200);
      const [mail] = await mailTo(u.email, /reset/i);
      expect(outbox.length).toBeGreaterThan(before);
      return { ...u, mail, token: tokenFromMail(mail) };
    }
    const verificationRows = () => owner.select().from(schema.authVerifications);

    it("answers identically for a known and an unknown address, and only a known one gets mail and an audit row", async () => {
      const orgId = await seedOrg("reset-enum");
      const u = await seedUser(orgId, "reset-enum");
      const unknown = emailFor("nobody");
      const known = await requestReset(u.email);
      const none = await requestReset(unknown);
      expect(known.status).toBe(200);
      expect(none.status).toBe(200);
      expect(await known.json()).toEqual(await none.json());
      expect((await mailTo(u.email, /reset/i)).length).toBe(1);
      await new Promise((r) => setTimeout(r, 300));
      expect(outbox.filter((m) => m.to === unknown)).toHaveLength(0);
      expect(await auditRows(orgId, "auth.password_reset_requested")).toHaveLength(1);
    });

    it("emails a link to the account's own address, stores the token hashed, and the mail carries no other detail", async () => {
      const r = await resetLink("reset-mail");
      expect(r.mail.to).toBe(r.email);
      expect(r.mail.text).toMatch(/works once/);
      expect(r.mail.text).not.toContain("Synthetic");
      const rows = await verificationRows();
      expect(rows.some((v) => v.identifier.includes(r.token))).toBe(false); // only a hash is stored
      expect(rows.some((v) => v.value === r.userId)).toBe(true);
    });

    it("the link works once: a second use of the same token is refused", async () => {
      const r = await resetLink("reset-once");
      const first = await call("/reset-password", { body: { token: r.token, newPassword: NEW_PASSWORD } });
      expect(first.status).toBe(200);
      const second = await call("/reset-password", { body: { token: r.token, newPassword: "yet another passphrase 1" } });
      expect(second.status).toBe(400);
      expect(await second.json()).toMatchObject({ code: "INVALID_TOKEN" });
      // The second attempt changed nothing: the first new password still signs in.
      expect((await signIn(r.email, NEW_PASSWORD)).res.status).toBe(200);
      expect((await signIn(r.email, "yet another passphrase 1")).res.status).toBe(401);
    });

    it("two simultaneous uses of one link: exactly one succeeds", async () => {
      const r = await resetLink("reset-race");
      const [a, b] = await Promise.all([
        call("/reset-password", { body: { token: r.token, newPassword: "first racing passphrase 1" } }),
        call("/reset-password", { body: { token: r.token, newPassword: "second racing passphrase 2" } }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 400]);
    });

    it("the link expires: an expired token is refused and the password is unchanged", async () => {
      const r = await resetLink("reset-expired");
      await owner.update(schema.authVerifications).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.authVerifications.value, r.userId));
      const res = await call("/reset-password", { body: { token: r.token, newPassword: NEW_PASSWORD } });
      expect(res.status).toBe(400);
      expect((await signIn(r.email)).res.status).toBe(200); // the old password still works
    });

    it("the link lifetime is 60 minutes", async () => {
      const r = await resetLink("reset-ttl");
      const [v] = await owner.select().from(schema.authVerifications).where(eq(schema.authVerifications.value, r.userId));
      const minutes = (v.expiresAt.getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(58);
      expect(minutes).toBeLessThanOrEqual(60);
    });

    it("a refused attempt (too-short password) does not spend the link", async () => {
      const r = await resetLink("reset-short");
      const bad = await call("/reset-password", { body: { token: r.token, newPassword: "short" } });
      expect(bad.status).toBe(400);
      const good = await call("/reset-password", { body: { token: r.token, newPassword: NEW_PASSWORD } });
      expect(good.status).toBe(200);
    });

    it("completing a reset signs out every session, notifies the owner of the account, and is audited", async () => {
      const r = await resetLink("reset-done");
      const { cookie } = await signIn(r.email);
      expect(await session(cookie)).not.toBeNull();
      outbox.length = 0;
      const res = await call("/reset-password", { body: { token: r.token, newPassword: NEW_PASSWORD } });
      expect(res.status).toBe(200);
      expect(await session(cookie)).toBeNull(); // revokeSessionsOnPasswordReset
      expect(await owner.select().from(schema.authSessions).where(eq(schema.authSessions.userId, r.userId))).toHaveLength(0);
      const [notice] = await mailTo(r.email, /password was changed/i);
      expect(notice).toBeDefined();
      expect(notice.text).not.toMatch(/https?:\/\//); // the notice has no link to click
      expect(await auditRows(r.orgId, "auth.password_reset_completed")).toHaveLength(1);
      expect((await signIn(r.email, GOOD_PASSWORD)).res.status).toBe(401);
      expect((await signIn(r.email, NEW_PASSWORD)).res.status).toBe(200);
    });

    it("a deactivated user cannot get a working reset link", async () => {
      const orgId = await seedOrg("reset-deactivated");
      const u = await seedUser(orgId, "reset-deactivated", { deleted: true });
      expect((await requestReset(u.email)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 300));
      expect(outbox.filter((m) => m.to === u.email)).toHaveLength(0);
      const denied = await auditRows(orgId, "auth.password_reset_requested");
      expect(denied[0]).toMatchObject({ outcome: "denied" });
    });
  });

  describe("change password", () => {
    it("changes the password, signs out the other sessions, notifies, and audits", async () => {
      const orgId = await seedOrg("chg-fresh");
      const u = await seedUser(orgId, "chg-fresh");
      const other = await signIn(u.email);
      const { cookie } = await signIn(u.email);
      outbox.length = 0;
      const res = await call("/change-password", { body: { currentPassword: GOOD_PASSWORD, newPassword: "changed passphrase 123", revokeOtherSessions: true }, cookie });
      expect(res.status).toBe(200);
      expect(await session(other.cookie)).toBeNull();
      expect((await mailTo(u.email, /password was changed/i)).length).toBe(1);
      const rows = await auditRows(orgId, "auth.password_changed");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorUserId: u.userId });
      expect((await signIn(u.email, "changed passphrase 123")).res.status).toBe(200);
    });

    it("a stolen session is not enough: the current password must be re-entered, and a wrong one changes nothing", async () => {
      const orgId = await seedOrg("chg-stolen");
      const u = await seedUser(orgId, "chg-stolen");
      const { cookie } = await signIn(u.email);
      await owner.update(schema.authSessions).set({ createdAt: new Date(Date.now() - 60 * 60_000) }).where(eq(schema.authSessions.userId, u.userId));
      const res = await call("/change-password", { body: { currentPassword: "guessed at random 1", newPassword: "changed passphrase 123" }, cookie });
      expect(res.status).toBe(400);
      expect((await signIn(u.email, GOOD_PASSWORD)).res.status).toBe(200);
    });

    it("refuses a wrong current password and does not audit a change", async () => {
      const orgId = await seedOrg("chg-wrong");
      const u = await seedUser(orgId, "chg-wrong");
      const { cookie } = await signIn(u.email);
      const res = await call("/change-password", { body: { currentPassword: "not my password", newPassword: "changed passphrase 123" }, cookie });
      expect(res.status).toBe(400);
      expect(await auditRows(orgId, "auth.password_changed")).toHaveLength(0);
    });

    it("requires a session at all", async () => {
      const res = await call("/change-password", { body: { currentPassword: GOOD_PASSWORD, newPassword: "changed passphrase 123" } });
      expect(res.status).toBe(401);
    });
  });

  describe("two-step sign-in (MFA)", () => {
    const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    function b32Bytes(secret: string): Buffer {
      let bits = "";
      for (const ch of secret.replace(/=+$/, "")) bits += B32.indexOf(ch).toString(2).padStart(5, "0");
      const bytes = Buffer.alloc(Math.floor(bits.length / 8));
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
      return bytes;
    }
    // RFC 6238, SHA-1, 6 digits, 30 s: what any authenticator app does.
    function totpCode(secret: string, at = Date.now()): string {
      const counter = Buffer.alloc(8);
      counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
      const h = createHmac("sha1", b32Bytes(secret)).update(counter).digest();
      const off = h[h.length - 1] & 0xf;
      const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
      return String(n % 1_000_000).padStart(6, "0");
    }
    const wrongCode = (secret: string) => String((Number(totpCode(secret)) + 1) % 1_000_000).padStart(6, "0");
    const named = (res: Response, name: string) => res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.includes(`${name}=`) && !/=$/.test(c));

    type Enrolled = Fx & { secret: string; backupCodes: string[]; cookie: string; firstCookie: string };
    async function enrolled(label: string, opts: Parameters<typeof seedUser>[2] = {}): Promise<Enrolled> {
      const orgId = await seedOrg(label);
      const u = await seedUser(orgId, label, opts);
      const first = await signIn(u.email);
      const en = await call("/two-factor/enable", { body: { password: GOOD_PASSWORD }, cookie: first.cookie });
      expect(en.status).toBe(200);
      const { totpURI, backupCodes } = (await en.json()) as { totpURI: string; backupCodes: string[] };
      const secret = new URL(totpURI).searchParams.get("secret")!;
      const verified = await call("/two-factor/verify-totp", { body: { code: totpCode(secret) }, cookie: first.cookie });
      expect(verified.status).toBe(200);
      return { ...u, secret, backupCodes, cookie: cookieFrom(verified), firstCookie: first.cookie };
    }
    // Password step for an enrolled user: returns the code-step cookie.
    async function challenge(email: string, extraCookie?: string) {
      const res = await call("/sign-in/email", { body: { email, password: GOOD_PASSWORD }, cookie: extraCookie });
      return { res, body: (await res.clone().json()) as { twoFactorRedirect?: boolean }, cookie: cookieFrom(res) };
    }
    const verifyCode = (cookie: string, code: string, extra: Record<string, unknown> = {}, path = "/two-factor/verify-totp") =>
      call(path, { body: { code, ...extra }, cookie });
    const sessionCount = async (userId: string) => (await owner.select().from(schema.authSessions).where(eq(schema.authSessions.userId, userId))).length;

    it("a password alone is never enough for a user without an authenticator: no session for requireSession, only for the enrollment page", async () => {
      const orgId = await seedOrg("mfa-gate");
      const u = await seedUser(orgId, "mfa-gate");
      const { res, cookie } = await signIn(u.email);
      expect(res.status).toBe(200);
      expect(await strictSession(cookie)).toBeNull();
      expect(await session(cookie)).toEqual({ userId: u.userId, organizationId: orgId, role: "owner", signedInAt: expect.any(Date) });
    });

    it("starting enrollment needs the password again, stores the secret and backup codes encrypted, and does not turn MFA on yet", async () => {
      const orgId = await seedOrg("mfa-start");
      const u = await seedUser(orgId, "mfa-start");
      const { cookie } = await signIn(u.email);
      const bad = await call("/two-factor/enable", { body: { password: "not the password at all" }, cookie });
      expect(bad.status).toBe(400);
      expect(await owner.select().from(schema.authTwoFactors).where(eq(schema.authTwoFactors.userId, u.userId))).toHaveLength(0);

      const res = await call("/two-factor/enable", { body: { password: GOOD_PASSWORD }, cookie });
      expect(res.status).toBe(200);
      const { totpURI, backupCodes } = (await res.json()) as { totpURI: string; backupCodes: string[] };
      const secret = new URL(totpURI).searchParams.get("secret")!;
      expect(backupCodes).toHaveLength(10);
      const [row] = await owner.select().from(schema.authTwoFactors).where(eq(schema.authTwoFactors.userId, u.userId));
      expect(row.verified).toBe(false);
      expect(row.secret).not.toContain(secret);
      expect(row.secret).not.toContain(b32Bytes(secret).toString("utf8"));
      for (const code of backupCodes) expect(row.backupCodes).not.toContain(code);
      const [user] = await owner.select().from(schema.users).where(eq(schema.users.id, u.userId));
      expect(user.twoFactorEnabled).toBe(false);
      // A wrong first code does not turn it on, and the user stays gated.
      expect((await verifyCode(cookie, wrongCode(secret))).status).toBe(401);
      const [still] = await owner.select().from(schema.users).where(eq(schema.users.id, u.userId));
      expect(still.twoFactorEnabled).toBe(false);
      expect(await strictSession(cookie)).toBeNull();
      expect(await auditRows(orgId, "auth.mfa_enrollment_started")).toHaveLength(1);
      expect(await auditRows(orgId, "auth.mfa_enrolled")).toHaveLength(0);
    });

    it("the first valid code turns MFA on, re-issues the session, emails a notice, and is audited without a false login", async () => {
      outbox.length = 0;
      const e = await enrolled("mfa-enroll");
      const [user] = await owner.select().from(schema.users).where(eq(schema.users.id, e.userId));
      expect(user.twoFactorEnabled).toBe(true);
      expect(await strictSession(e.cookie)).toEqual({ userId: e.userId, organizationId: e.orgId, role: "owner", signedInAt: expect.any(Date) });
      expect(await strictSession(e.firstCookie)).toBeNull(); // the pre-MFA session was replaced
      expect((await mailTo(e.email, /two-step sign-in was turned on/i)).length).toBe(1);
      expect(await auditRows(e.orgId, "auth.mfa_enrolled")).toHaveLength(1);
      expect(await auditRows(e.orgId, "auth.login")).toHaveLength(1); // the password sign-in only
    });

    it("re-issuing the session at enrollment does not restart the 12 hour clock", async () => {
      const orgId = await seedOrg("mfa-cap");
      const u = await seedUser(orgId, "mfa-cap");
      const first = await signIn(u.email);
      const old = new Date(Date.now() - 11 * 3_600_000);
      await owner.update(schema.authSessions).set({ createdAt: old }).where(eq(schema.authSessions.userId, u.userId));
      const en = await call("/two-factor/enable", { body: { password: GOOD_PASSWORD }, cookie: first.cookie });
      const secret = new URL(((await en.json()) as { totpURI: string }).totpURI).searchParams.get("secret")!;
      const v = await call("/two-factor/verify-totp", { body: { code: totpCode(secret) }, cookie: first.cookie });
      expect(v.status).toBe(200);
      const [row] = await owner.select().from(schema.authSessions).where(eq(schema.authSessions.userId, u.userId));
      expect(Math.abs(row.createdAt.getTime() - old.getTime()), "new session kept the original created_at").toBeLessThan(60_000);
    });

    it("sign-in with MFA on: the password gives a code step and NO session; a valid code completes it; audit shows challenge then login", async () => {
      const e = await enrolled("mfa-signin");
      const before = await sessionCount(e.userId);
      const c = await challenge(e.email);
      expect(c.body.twoFactorRedirect).toBe(true);
      expect(c.cookie).toMatch(/two_factor=/);
      expect(c.cookie).not.toMatch(/session_token/);
      expect(await sessionCount(e.userId)).toBe(before); // the pending session was deleted
      expect(await auditRows(e.orgId, "auth.mfa_challenge")).toHaveLength(1);
      const loginsBefore = (await auditRows(e.orgId, "auth.login")).length;

      const ok = await verifyCode(c.cookie, totpCode(e.secret));
      expect(ok.status).toBe(200);
      expect(await strictSession(cookieFrom(ok))).toEqual({ userId: e.userId, organizationId: e.orgId, role: "owner", signedInAt: expect.any(Date) });
      const logins = await auditRows(e.orgId, "auth.login");
      expect(logins).toHaveLength(loginsBefore + 1);
      expect(logins.filter((l) => (l.metadata as { method?: string }).method === "password+totp")).toHaveLength(1);
    });

    it("a wrong code gives no session and is audited; the challenge cannot be replayed after it succeeds", async () => {
      const e = await enrolled("mfa-wrong");
      const c = await challenge(e.email);
      const bad = await verifyCode(c.cookie, wrongCode(e.secret));
      expect(bad.status).toBe(401);
      expect(cookieFrom(bad)).not.toMatch(/session_token/);
      const failed = await auditRows(e.orgId, "auth.mfa_failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ actorUserId: e.userId, outcome: "failure" });
      expect(failed[0].metadata).toMatchObject({ method: "totp", reason: "invalid_code" });

      const ok = await verifyCode(c.cookie, totpCode(e.secret));
      expect(ok.status).toBe(200);
      const replay = await verifyCode(c.cookie, totpCode(e.secret));
      expect(replay.status).toBe(401);
      expect(cookieFrom(replay)).not.toMatch(/session_token/);
    });

    it("a code step left open past its time is refused", async () => {
      const e = await enrolled("mfa-expired");
      const c = await challenge(e.email);
      await owner.update(schema.authVerifications).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.authVerifications.value, e.userId));
      const res = await verifyCode(c.cookie, totpCode(e.secret));
      expect(res.status).toBe(401);
      expect(cookieFrom(res)).not.toMatch(/session_token/);
    });

    it("a code step cookie cannot be forged or borrowed from another user", async () => {
      const a = await enrolled("mfa-forge-a");
      const b = await enrolled("mfa-forge-b");
      const cb = await challenge(b.email);
      // B's challenge answered with A's valid code: refused (the code is checked against B's secret).
      expect((await verifyCode(cb.cookie, totpCode(a.secret))).status).toBe(401);
      expect((await verifyCode("rg.two_factor=forged.value", totpCode(a.secret))).status).toBe(401);
      expect((await verifyCode("", totpCode(a.secret))).status).toBe(401);
    });

    it("5 consecutive wrong codes lock the code step for 15 minutes even for the right code, and it clears when the lock passes", async () => {
      const e = await enrolled("mfa-lock");
      for (let i = 0; i < 5; i++) {
        const c = await challenge(e.email);
        expect((await verifyCode(c.cookie, wrongCode(e.secret))).status).toBe(401);
      }
      const c = await challenge(e.email);
      const locked = await verifyCode(c.cookie, totpCode(e.secret));
      expect(locked.status).toBe(429);
      expect(cookieFrom(locked)).not.toMatch(/session_token/);
      const [row] = await owner.select().from(schema.authTwoFactors).where(eq(schema.authTwoFactors.userId, e.userId));
      expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 13 * 60_000);
      expect((await auditRows(e.orgId, "auth.mfa_failed")).some((r) => (r.metadata as { reason?: string }).reason === "locked")).toBe(true);

      await owner.update(schema.authTwoFactors).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(schema.authTwoFactors.userId, e.userId));
      const c2 = await challenge(e.email);
      expect((await verifyCode(c2.cookie, totpCode(e.secret))).status).toBe(200);
    });

    it("code guessing is throttled per client address: the 11th attempt in 15 minutes gets 429", async () => {
      const ip = nextIp();
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) statuses.push((await call("/two-factor/verify-totp", { body: { code: "000000" }, ip })).status);
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
    });

    it("a backup code completes sign-in once and then never again; it is audited", async () => {
      const e = await enrolled("mfa-backup");
      const code = e.backupCodes[0];
      const c = await challenge(e.email);
      const ok = await verifyCode(c.cookie, code, {}, "/two-factor/verify-backup-code");
      expect(ok.status).toBe(200);
      expect(await strictSession(cookieFrom(ok))).not.toBeNull();
      expect(await auditRows(e.orgId, "auth.mfa_backup_code_used")).toHaveLength(1);
      const c2 = await challenge(e.email);
      expect((await verifyCode(c2.cookie, code, {}, "/two-factor/verify-backup-code")).status).toBe(401);
      const c3 = await challenge(e.email);
      expect((await verifyCode(c3.cookie, e.backupCodes[1], {}, "/two-factor/verify-backup-code")).status).toBe(200);
    });

    it("regenerating backup codes needs a session and the password, replaces the old codes, and is audited", async () => {
      const e = await enrolled("mfa-regen");
      expect((await call("/two-factor/generate-backup-codes", { body: { password: GOOD_PASSWORD } })).status).toBe(401);
      expect((await call("/two-factor/generate-backup-codes", { body: { password: "not the password at all" }, cookie: e.cookie })).status).toBe(400);
      const res = await call("/two-factor/generate-backup-codes", { body: { password: GOOD_PASSWORD }, cookie: e.cookie });
      expect(res.status).toBe(200);
      const fresh = ((await res.json()) as { backupCodes: string[] }).backupCodes;
      expect(fresh).toHaveLength(10);
      const c = await challenge(e.email);
      expect((await verifyCode(c.cookie, e.backupCodes[0], {}, "/two-factor/verify-backup-code")).status).toBe(401);
      const c2 = await challenge(e.email);
      expect((await verifyCode(c2.cookie, fresh[0], {}, "/two-factor/verify-backup-code")).status).toBe(200);
      expect(await auditRows(e.orgId, "auth.mfa_backup_codes_regenerated")).toHaveLength(1);
    });

    describe("trusted devices", () => {
      async function trusted(label: string) {
        const e = await enrolled(label);
        const c = await challenge(e.email);
        const ok = await verifyCode(c.cookie, totpCode(e.secret), { trustDevice: true });
        expect(ok.status).toBe(200);
        const trust = named(ok, "trust_device");
        expect(trust, "a trusted-device cookie was set").toBeDefined();
        return { ...e, trust: trust! };
      }

      it("only when asked: without the box the device is not trusted and every sign-in needs a code", async () => {
        const e = await enrolled("trust-off");
        const c = await challenge(e.email);
        const ok = await verifyCode(c.cookie, totpCode(e.secret));
        expect(named(ok, "trust_device")).toBeUndefined();
        expect((await challenge(e.email)).body.twoFactorRedirect).toBe(true);
      });

      it("a trusted device skips the code but still needs the password, and the sign-in is audited as such", async () => {
        const t = await trusted("trust-on");
        expect(await auditRows(t.orgId, "auth.mfa_device_trusted")).toHaveLength(1);
        const again = await challenge(t.email, t.trust);
        expect(again.body.twoFactorRedirect).toBeUndefined();
        expect(await strictSession(again.cookie)).toEqual({ userId: t.userId, organizationId: t.orgId, role: "owner", signedInAt: expect.any(Date) });
        const logins = await auditRows(t.orgId, "auth.login");
        expect(logins.filter((l) => (l.metadata as { method?: string }).method === "password+trusted_device")).toHaveLength(1);
        // The trust cookie is not a login: a wrong password with it gets nothing.
        const wrong = await call("/sign-in/email", { body: { email: t.email, password: "not the password at all" }, cookie: t.trust });
        expect(wrong.status).toBe(401);
        expect(cookieFrom(wrong)).not.toMatch(/session_token/);
      });

      it("is bound to the person: another user's trusted-device cookie still gets the code step", async () => {
        const a = await trusted("trust-bound-a");
        const b = await enrolled("trust-bound-b");
        expect((await challenge(b.email, a.trust)).body.twoFactorRedirect).toBe(true);
      });

      it("expires: a lapsed record is not honored", async () => {
        const t = await trusted("trust-expired");
        await owner.update(schema.authVerifications).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.authVerifications.value, t.userId));
        expect((await challenge(t.email, t.trust)).body.twoFactorRedirect).toBe(true);
      });

      it("lasts 14 days", async () => {
        const t = await trusted("trust-14d");
        const rows = await owner.select().from(schema.authVerifications).where(eq(schema.authVerifications.value, t.userId));
        const days = Math.max(...rows.map((r) => (r.expiresAt.getTime() - Date.now()) / 86_400_000));
        expect(days).toBeGreaterThan(13.9);
        expect(days).toBeLessThan(14.1);
      });

      it("is revoked by a password change", async () => {
        const t = await trusted("trust-chg");
        const { cookie } = await challenge(t.email, t.trust);
        const res = await call("/change-password", { body: { currentPassword: GOOD_PASSWORD, newPassword: "changed passphrase 123" }, cookie });
        expect(res.status).toBe(200);
        const next = await call("/sign-in/email", { body: { email: t.email, password: "changed passphrase 123" }, cookie: t.trust });
        expect(((await next.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
      });

      it("is revoked by a password reset, and the reset leaves MFA on (a stolen mailbox alone gets no session)", async () => {
        const t = await trusted("trust-reset");
        outbox.length = 0;
        await call("/request-password-reset", { body: { email: t.email, redirectTo: "/reset-password" } });
        const [mail] = await mailTo(t.email, /reset/i);
        const done = await call("/reset-password", { body: { token: tokenFromMail(mail), newPassword: "a brand new passphrase 99" } });
        expect(done.status).toBe(200);
        expect(cookieFrom(done)).not.toMatch(/session_token/);
        const next = await call("/sign-in/email", { body: { email: t.email, password: "a brand new passphrase 99" }, cookie: t.trust });
        expect(((await next.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
        const [user] = await owner.select().from(schema.users).where(eq(schema.users.id, t.userId));
        expect(user.twoFactorEnabled).toBe(true);
      });
    });

    describe("audit address (manual test finding 8)", () => {
      // Better Auth masks an IPv6 address to its /64 for the rate limiter and the session row (::1 becomes
      // 0000:0000:0000:0000:0000:0000:0000:0000). Every auth audit row must carry the address as received
      // instead. Fresh IPv6 addresses per test, because rate-limit counters persist for 15 minutes (so
      // ::1 itself is not used here; it masks the same way).
      const h16 = () => crypto.getRandomValues(new Uint16Array(1))[0].toString(16);
      const v6 = () => `2001:db8:${h16()}:${h16()}::17`;
      const EXPANDED = /^[0-9a-f]{4}(:[0-9a-f]{4}){7}$/;
      const seenIds = async (orgId: string) => new Set((await auditRows(orgId)).map((r) => r.id));
      // The rows written by the steps of one test (by id, never by position), each with its address.
      async function writtenSince(orgId: string, seen: Set<string>) {
        return (await auditRows(orgId)).filter((r) => !seen.has(r.id)).map((r) => ({ action: r.action, ip: (r.metadata as { ip?: string }).ip, reason: (r.metadata as { reason?: string }).reason }));
      }
      function expectAddress(rows: { action: string; ip?: string }[], ip: string, actions: string[]) {
        for (const a of actions) expect(rows.some((r) => r.action === a && r.ip === ip), `${a} carries the address as received`).toBe(true);
        for (const r of rows) {
          if (r.ip === undefined) continue;
          expect(r.ip, `${r.action} address`).toBe(ip);
          expect(r.ip, `${r.action} address is not the expanded, masked form`).not.toMatch(EXPANDED);
        }
      }

      it("a password-only sign-in, a refused sign-in and a sign-out all store the address as received", async () => {
        const orgId = await seedOrg("addr-plain");
        const u = await seedUser(orgId, "addr-plain");
        const ip = v6();
        const seen = await seenIds(orgId);
        const ok = await signIn(u.email, GOOD_PASSWORD, ip);
        expect(ok.res.status).toBe(200);
        expect((await signIn(u.email, "wrong password here 1", ip)).res.status).toBe(401);
        expect((await call("/sign-out", { body: {}, cookie: ok.cookie, ip })).status).toBe(200);
        expectAddress(await writtenSince(orgId, seen), ip, ["auth.login", "auth.login_failed", "auth.logout"]);
      });

      it("a code-step sign-in (challenge, wrong code, right code) stores the address as received on every row", async () => {
        const e = await enrolled("addr-totp");
        const ip = v6();
        const seen = await seenIds(e.orgId);
        const c = await call("/sign-in/email", { body: { email: e.email, password: GOOD_PASSWORD }, ip });
        const cookie = cookieFrom(c);
        expect((await call("/two-factor/verify-totp", { body: { code: wrongCode(e.secret) }, cookie, ip })).status).toBe(401);
        expect((await call("/two-factor/verify-totp", { body: { code: totpCode(e.secret) }, cookie, ip })).status).toBe(200);
        const rows = await writtenSince(e.orgId, seen);
        expectAddress(rows, ip, ["auth.mfa_challenge", "auth.mfa_failed", "auth.login"]);
      });

      it("a backup-code sign-in that trusts the device, and the later trusted-device sign-in, store the address as received", async () => {
        const e = await enrolled("addr-backup");
        const ip = v6();
        const seen = await seenIds(e.orgId);
        const c = await call("/sign-in/email", { body: { email: e.email, password: GOOD_PASSWORD }, ip });
        const ok = await call("/two-factor/verify-backup-code", { body: { code: e.backupCodes[0], trustDevice: true }, cookie: cookieFrom(c), ip });
        expect(ok.status).toBe(200);
        const trust = named(ok, "trust_device");
        expect(trust).toBeDefined();
        const again = await call("/sign-in/email", { body: { email: e.email, password: GOOD_PASSWORD }, cookie: trust, ip });
        expect(((await again.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBeUndefined();
        const rows = await writtenSince(e.orgId, seen);
        expectAddress(rows, ip, ["auth.login", "auth.mfa_backup_code_used", "auth.mfa_device_trusted"]);
        expect(rows.filter((r) => r.action === "auth.login")).toHaveLength(2);
      });

      it("the refusal of a deactivated user stores the address as received", async () => {
        const orgId = await seedOrg("addr-deactivated");
        const u = await seedUser(orgId, "addr-deactivated", { deleted: true });
        const ip = v6();
        const seen = await seenIds(orgId);
        expect((await signIn(u.email, GOOD_PASSWORD, ip)).res.status).toBeGreaterThanOrEqual(400);
        const rows = await writtenSince(orgId, seen);
        expectAddress(rows, ip, ["auth.login_failed"]);
        expect(rows.some((r) => r.reason === "deactivated")).toBe(true);
      });

      it("an IPv4 address is stored unchanged (the mask only ever differed for IPv6)", async () => {
        const orgId = await seedOrg("addr-v4");
        const u = await seedUser(orgId, "addr-v4");
        const ip = nextIp();
        const seen = await seenIds(orgId);
        expect((await signIn(u.email, GOOD_PASSWORD, ip)).res.status).toBe(200);
        expectAddress(await writtenSince(orgId, seen), ip, ["auth.login"]);
      });
    });

    describe("role separation for the MFA tables", () => {
      it("app_runtime cannot read the table or flip the MFA flag; auth_runtime cannot delete an enrollment", async () => {
        const e = await enrolled("mfa-roles");
        await expectPgError(app.execute(sql`select 1 from auth_two_factors limit 1`), INSUFFICIENT_PRIVILEGE);
        await expectPgError(app.execute(sql`update users set two_factor_enabled = false where id = ${e.userId}`), INSUFFICIENT_PRIVILEGE);
        await expectPgError(app.execute(sql`update users set two_factor_enabled = true where id = ${e.userId}`), INSUFFICIENT_PRIVILEGE);
        await expectPgError(authDb.execute(sql`delete from auth_two_factors where user_id = ${e.userId}`), INSUFFICIENT_PRIVILEGE);
        const [user] = await owner.select().from(schema.users).where(eq(schema.users.id, e.userId));
        expect(user.twoFactorEnabled).toBe(true);
      });
    });

    it("a cross-site request to the code endpoint is refused", async () => {
      const e = await enrolled("mfa-origin");
      const c = await challenge(e.email);
      const res = await call("/two-factor/verify-totp", { body: { code: totpCode(e.secret) }, cookie: c.cookie, origin: "https://evil.example" });
      expect(res.status).toBe(403);
    });

    it("no audit row for the MFA events carries a secret, a code, a backup code, an address or a device token", async () => {
      const e = await enrolled("mfa-audit");
      const c = await challenge(e.email);
      const code = totpCode(e.secret);
      await verifyCode(c.cookie, code, { trustDevice: true });
      const c2 = await challenge(e.email);
      await verifyCode(c2.cookie, wrongCode(e.secret));
      const text = JSON.stringify(await auditRows(e.orgId));
      for (const secretish of [e.secret, b32Bytes(e.secret).toString("utf8"), code, e.email, ...e.backupCodes]) expect(text).not.toContain(secretish);
      expect(text).not.toMatch(/otpauth|trust-device/i);
    });

    describe("break-glass reset (scripts/mfa-reset.mjs)", () => {
      async function reset(email: string, apply: boolean) {
        const { resetMfa } = await import("../../scripts/mfa-reset.mjs");
        return resetMfa(ownerPool, email, { apply });
      }

      it("a dry run shows who would be reset and changes nothing", async () => {
        const t = await enrolled("reset-dry");
        const r = await reset(t.email.toUpperCase(), false);
        expect(r).toMatchObject({ status: "dry_run", userId: t.userId, organizationId: t.orgId, mfaWasEnabled: true });
        const [user] = await owner.select().from(schema.users).where(eq(schema.users.id, t.userId));
        expect(user.twoFactorEnabled).toBe(true);
        expect(await strictSession(t.cookie)).not.toBeNull();
        expect(await auditRows(t.orgId, "auth.mfa_reset")).toHaveLength(0);
      });

      it("applying it removes the enrollment, signs out every session, revokes trusted devices, audits, and sends the person back to enrollment", async () => {
        const e = await enrolled("reset-apply");
        const c = await challenge(e.email);
        const ok = await verifyCode(c.cookie, totpCode(e.secret), { trustDevice: true });
        const trust = named(ok, "trust_device")!;
        const r = await reset(e.email, true);
        expect(r).toMatchObject({ status: "reset", userId: e.userId });
        expect(await owner.select().from(schema.authTwoFactors).where(eq(schema.authTwoFactors.userId, e.userId))).toHaveLength(0);
        const [user] = await owner.select().from(schema.users).where(eq(schema.users.id, e.userId));
        expect(user.twoFactorEnabled).toBe(false);
        expect(await sessionCount(e.userId)).toBe(0);
        expect(await strictSession(e.cookie)).toBeNull();
        const rows = await auditRows(e.orgId, "auth.mfa_reset");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ resourceId: e.userId, outcome: "success" });
        // The row obeys the same rules as every other audit event.
        const { buildAuditRow } = await import("@/lib/audit");
        expect(() => buildAuditRow({ action: rows[0].action as never, resourceType: rows[0].resourceType, metadata: rows[0].metadata as Record<string, string> })).not.toThrow();
        // Old trusted device is gone and so is the old authenticator: the password gives a gated session.
        const again = await call("/sign-in/email", { body: { email: e.email, password: GOOD_PASSWORD }, cookie: trust });
        const cookie = cookieFrom(again);
        expect(((await again.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBeUndefined();
        expect(await strictSession(cookie)).toBeNull();
        expect(await session(cookie)).not.toBeNull();
      });

      it("an unknown address resets nothing", async () => {
        expect(await reset(emailFor("nobody"), true)).toEqual({ status: "not_found" });
      });
    });

    describe("owner reset function (migration 0012)", () => {
      const NO_DATA_FOUND = "P0002";
      const NOT_IN_STATE = "55000";
      const reset = (actor: string, target: string) => authDb.execute(sql`select reset_user_mfa(${actor}::uuid, ${target}::uuid)`);
      async function practice(label: string) {
        const target = await enrolled(label, { role: "associate" });
        const actor = await seedUser(target.orgId, `${label}-owner`, { role: "owner" });
        return { target, actor };
      }
      const enrollmentRows = async (userId: string) => (await owner.select().from(schema.authTwoFactors).where(eq(schema.authTwoFactors.userId, userId))).length;
      const mfaFlag = async (userId: string) => (await owner.select().from(schema.users).where(eq(schema.users.id, userId)))[0].twoFactorEnabled;

      it("an active owner resets a colleague in the same practice: enrollment, sessions and trusted devices go, the audit row is written, nobody else is touched", async () => {
        const { target, actor } = await practice("fn-ok");
        const bystander = await enrolled("fn-bystander");
        const c = await challenge(target.email);
        const trusted = await verifyCode(c.cookie, totpCode(target.secret), { trustDevice: true });
        expect(named(trusted, "trust_device")).toBeDefined();
        await signIn(actor.email); // the actor has a session of their own

        await reset(actor.userId, target.userId);

        expect(await enrollmentRows(target.userId)).toBe(0);
        expect(await mfaFlag(target.userId)).toBe(false);
        expect(await sessionCount(target.userId)).toBe(0);
        expect(await strictSession(target.cookie)).toBeNull();
        const devices = await owner.select().from(schema.authVerifications).where(eq(schema.authVerifications.value, target.userId));
        expect(devices).toHaveLength(0);
        // Their password is untouched, so the next sign-in is gated and sends them to set up a new phone.
        const [account] = await owner.select().from(schema.authAccounts).where(eq(schema.authAccounts.userId, target.userId));
        expect(account.password).toBeTruthy();
        const again = await call("/sign-in/email", { body: { email: target.email, password: GOOD_PASSWORD }, cookie: named(trusted, "trust_device") });
        expect(await strictSession(cookieFrom(again))).toBeNull();
        expect(await session(cookieFrom(again))).not.toBeNull();

        const rows = await auditRows(target.orgId, "auth.mfa_reset");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ actorUserId: actor.userId, resourceType: "users", resourceId: target.userId, outcome: "success", metadata: { method: "owner_reset" } });
        // Not touched: the actor's session, another practice's enrollment, flag and sessions.
        expect(await sessionCount(actor.userId)).toBeGreaterThan(0);
        expect(await enrollmentRows(bystander.userId)).toBe(1);
        expect(await mfaFlag(bystander.userId)).toBe(true);
        expect(await strictSession(bystander.cookie)).not.toBeNull();
      });

      it("refuses everything but the exact case, each time leaving the target and the audit log untouched", async () => {
        const { target, actor } = await practice("fn-refuse");
        const stranger = await practice("fn-refuse-b"); // another practice, with its own owner
        const associateActor = await seedUser(target.orgId, "fn-assoc", { role: "associate" });
        const adminActor = await seedUser(target.orgId, "fn-admin", { role: "admin" });
        const goneOwner = await seedUser(target.orgId, "fn-gone-owner", { role: "owner", deleted: true });
        const otherOwner = await seedUser(target.orgId, "fn-other-owner", { role: "owner" });
        const goneTarget = await enrolled("fn-gone-target", { role: "associate" });
        await owner.update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, goneTarget.userId));
        const goneActor = await seedUser(goneTarget.orgId, "fn-gone-target-owner", { role: "owner" });

        const cases: [string, string, string, string][] = [
          ["an associate as actor", associateActor.userId, target.userId, INSUFFICIENT_PRIVILEGE],
          ["an admin as actor", adminActor.userId, target.userId, INSUFFICIENT_PRIVILEGE],
          ["a deactivated owner as actor", goneOwner.userId, target.userId, INSUFFICIENT_PRIVILEGE],
          ["an actor that does not exist", crypto.randomUUID(), target.userId, INSUFFICIENT_PRIVILEGE],
          ["an owner resetting themselves", actor.userId, actor.userId, INSUFFICIENT_PRIVILEGE],
          ["an owner resetting another owner", actor.userId, otherOwner.userId, INSUFFICIENT_PRIVILEGE],
          ["another practice's owner as actor (target not found there)", stranger.actor.userId, target.userId, NO_DATA_FOUND],
          ["a target that does not exist", actor.userId, crypto.randomUUID(), NO_DATA_FOUND],
          ["a deactivated target", goneActor.userId, goneTarget.userId, NOT_IN_STATE],
        ];
        for (const [label, a, t, code] of cases) await expectPgErrorLabelled(label, reset(a, t), code);

        expect(await enrollmentRows(target.userId)).toBe(1);
        expect(await mfaFlag(target.userId)).toBe(true);
        expect(await strictSession(target.cookie)).not.toBeNull();
        expect(await enrollmentRows(goneTarget.userId)).toBe(1);
        expect(await enrollmentRows(stranger.target.userId)).toBe(1);
        expect(await auditRows(target.orgId, "auth.mfa_reset")).toHaveLength(0);
        expect(await auditRows(goneTarget.orgId, "auth.mfa_reset")).toHaveLength(0);
      });

      it("only auth_runtime may call it: not the app role, not the table owner's group, not PUBLIC", async () => {
        const { target, actor } = await practice("fn-rights");
        await expectPgError(appPool.query("select reset_user_mfa($1::uuid, $2::uuid)", [actor.userId, target.userId]), INSUFFICIENT_PRIVILEGE);
        const r = await owner.execute(sql`
          select has_function_privilege('auth_runtime', 'reset_user_mfa(uuid,uuid)', 'EXECUTE') as auth,
                 has_function_privilege('app_runtime', 'reset_user_mfa(uuid,uuid)', 'EXECUTE') as app,
                 exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where p.proname = 'reset_user_mfa' and a.grantee = 0) as public_can`);
        expect(r.rows[0]).toEqual({ auth: true, app: false, public_can: false });
        expect(await enrollmentRows(target.userId)).toBe(1);
      });
    });

    describe("owner bootstrap script (scripts/bootstrap-owner.mjs)", () => {
      async function run(input: { org?: string; email?: string; name?: string; state?: string }, apply: boolean, pool: unknown = ownerPool) {
        const { bootstrapOwner } = await import("../../scripts/bootstrap-owner.mjs");
        return bootstrapOwner(pool as never, input, { apply });
      }
      const counts = async (email: string, org: string) => ({
        users: (await owner.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase()))).length,
        orgs: (await owner.select().from(schema.organizations).where(eq(schema.organizations.name, org))).length,
      });
      const fresh = () => ({ org: `Synthetic Bootstrap ${crypto.randomUUID()}`, email: emailFor("bootstrap"), name: "Synthetic Bootstrap Owner" });

      it("a dry run reports what it would create and changes nothing", async () => {
        const input = fresh();
        const r = await run(input, false);
        expect(r).toMatchObject({ status: "dry_run", wouldCreate: { organization: input.org, ownerEmail: input.email, ownerName: input.name } });
        expect(JSON.stringify(r)).not.toMatch(/password/i);
        expect(await counts(input.email, input.org)).toEqual({ users: 0, orgs: 0 });
      });

      it("applying creates the practice, a verified owner and a hashed one-time password, and audits both, without storing the password", async () => {
        const input = { ...fresh(), email: emailFor("Bootstrap").toUpperCase().replace("@EXAMPLE.TEST", "@Example.Test"), state: "ri", org: `  ${fresh().org}  ` };
        const r = await run(input, true);
        expect(r.status).toBe("created");
        if (r.status !== "created") return;
        expect(r.temporaryPassword).toMatch(/^([a-z2-9]{5}-){4}[a-z2-9]{5}$/);

        const [org] = await owner.select().from(schema.organizations).where(eq(schema.organizations.id, r.organizationId));
        expect(org).toMatchObject({ name: input.org.trim(), state: "RI" });
        const [user] = await owner.select().from(schema.users).where(eq(schema.users.id, r.userId));
        expect(user).toMatchObject({ organizationId: r.organizationId, role: "owner", emailVerified: true, twoFactorEnabled: false, email: input.email.trim().toLowerCase(), deletedAt: null });
        const [account] = await owner.select().from(schema.authAccounts).where(eq(schema.authAccounts.userId, r.userId));
        expect(account.providerId).toBe("credential");
        expect(account.password).toBeTruthy();
        expect(account.password).not.toContain(r.temporaryPassword);

        const rows = await auditRows(r.organizationId);
        expect(rows.map((x) => x.action).sort()).toEqual(["org.created", "user.created"]);
        for (const row of rows) {
          expect(row).toMatchObject({ outcome: "success", actorUserId: null });
          expect(JSON.stringify(row)).not.toContain(r.temporaryPassword);
          expect(JSON.stringify(row)).not.toContain(input.email.trim().toLowerCase());
        }
        // The rows obey the same rules as every other audit event.
        const { buildAuditRow } = await import("@/lib/audit");
        for (const row of rows) expect(() => buildAuditRow({ action: row.action as never, resourceType: row.resourceType, metadata: row.metadata as Record<string, string> })).not.toThrow();
        expect(rows.find((x) => x.action === "user.created")?.metadata).toEqual({ method: "bootstrap_script", role: "owner" });
      });

      it("the new owner really can sign in with the one-time password, is held at the authenticator step, and ends up an owner of the new practice", async () => {
        const input = fresh();
        const r = await run(input, true);
        if (r.status !== "created") throw new Error("not created");
        const first = await signIn(input.email, r.temporaryPassword);
        expect(first.res.status).toBe(200);
        expect(((await first.res.clone().json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBeUndefined();
        expect(await strictSession(first.cookie)).toBeNull(); // a password alone is not enough: MFA is required
        const en = await call("/two-factor/enable", { body: { password: r.temporaryPassword }, cookie: first.cookie });
        expect(en.status).toBe(200);
        const secret = new URL(((await en.json()) as { totpURI: string }).totpURI).searchParams.get("secret")!;
        const verified = await verifyCode(first.cookie, totpCode(secret));
        expect(verified.status).toBe(200);
        expect(await strictSession(cookieFrom(verified))).toEqual({ userId: r.userId, organizationId: r.organizationId, role: "owner", signedInAt: expect.any(Date) });
        // And the wrong password does not work.
        const wrong = await call("/sign-in/email", { body: { email: input.email, password: "not the temporary password at all" } });
        expect(wrong.status).toBe(401);
      });

      it("every run makes a different password", async () => {
        const a = await run(fresh(), true);
        const b = await run(fresh(), true);
        if (a.status !== "created" || b.status !== "created") throw new Error("not created");
        expect(a.temporaryPassword).not.toBe(b.temporaryPassword);
        expect(a.organizationId).not.toBe(b.organizationId);
      });

      it("refuses an address that already has an account, and a practice name that already exists, creating nothing", async () => {
        const input = fresh();
        expect((await run(input, true)).status).toBe("created");
        const before = await counts(input.email, input.org);
        const sameEmail = await run({ ...fresh(), email: input.email.toUpperCase().replace("@EXAMPLE.TEST", "@Example.Test") }, true);
        expect(sameEmail).toEqual({ status: "email_exists" });
        const sameOrg = await run({ ...fresh(), org: input.org.toUpperCase() }, true);
        expect(sameOrg).toEqual({ status: "org_exists" });
        expect(await counts(input.email, input.org)).toEqual(before);
        // A dry run says the same, so Sam finds out before applying.
        expect(await run({ ...input }, false)).toEqual({ status: "email_exists" });
      });

      it("one transaction: a failure part-way leaves no practice, no owner and no audit row behind", async () => {
        const input = fresh();
        const failing = {
          connect: async () => {
            const c = await ownerPool.connect();
            return {
              query: (sqlText: string, params?: unknown[]) => (/insert into auth_accounts/.test(sqlText) ? Promise.reject(new Error("simulated failure")) : c.query(sqlText, params)),
              release: () => c.release(),
            };
          },
        };
        await expect(run(input, true, failing)).rejects.toThrow("simulated failure");
        expect(await counts(input.email, input.org)).toEqual({ users: 0, orgs: 0 });
        // And the next, healthy attempt works: nothing was half-created.
        expect((await run(input, true)).status).toBe("created");
      });
    });
  });

  describe("rate limits (audit 03 item 4)", () => {
    it("sign-in: the 6th attempt from one address in 15 minutes gets 429, even with the right password; another address is unaffected", async () => {
      const orgId = await seedOrg("rl-signin");
      const u = await seedUser(orgId, "rl-signin");
      const ip = nextIp();
      for (let i = 0; i < 5; i++) expect((await signIn(u.email, "wrong password here 1", ip)).res.status).toBe(401);
      const blocked = await signIn(u.email, GOOD_PASSWORD, ip);
      expect(blocked.res.status).toBe(429);
      expect(blocked.cookie).toBe("");
      expect(blocked.res.headers.get("x-retry-after")).toMatch(/^\d+$/);
      expect((await signIn(u.email, GOOD_PASSWORD, nextIp())).res.status).toBe(200);
      // A throttled attempt never reaches the password check, so it creates no session.
      expect((await owner.select().from(schema.authSessions).where(eq(schema.authSessions.userId, u.userId))).length).toBe(1);
    });

    it("password reset requests: the 4th from one address gets 429", async () => {
      const ip = nextIp();
      const email = emailFor("rl-reset");
      for (let i = 0; i < 3; i++) expect((await call("/request-password-reset", { body: { email }, ip })).status).toBe(200);
      expect((await call("/request-password-reset", { body: { email }, ip })).status).toBe(429);
    });

    it("password reset completion: guessing tokens is throttled after 5 tries", async () => {
      const ip = nextIp();
      for (let i = 0; i < 5; i++) {
        const res = await call("/reset-password", { body: { token: `guess-${i}`, newPassword: "a brand new passphrase 99" }, ip });
        expect(res.status).toBe(400);
      }
      expect((await call("/reset-password", { body: { token: "guess-6", newPassword: "a brand new passphrase 99" }, ip })).status).toBe(429);
    });

    it("counters live in the database, so they hold across server instances", async () => {
      const rows = await owner.select().from(schema.authRateLimits);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.key.length > 0 && r.count >= 1)).toBe(true);
    });
  });

  describe("role separation (audit 04 items 1, 6)", () => {
    it("auth_runtime is a plain group member: no superuser, no bypass, not app_runtime", async () => {
      const r = await owner.execute(sql`
        select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
               pg_has_role(${AUTH_ROLE}, 'auth_runtime', 'member') as is_auth,
               pg_has_role(${AUTH_ROLE}, 'app_runtime', 'member') as is_app
        from pg_roles where rolname = ${AUTH_ROLE}`);
      expect(r.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, is_auth: true, is_app: false });
    });

    it.each(["clients", "client_assignments", "client_history", "reports", "report_sections", "report_versions", "report_templates", "methodology_prompts", "rag_documents", "rag_chunks", "rag_embeddings", "jobs", "organizations", "audit_log"])(
      "auth_runtime cannot read %s",
      async (table) => {
        await expectPgError(authDb.execute(sql.raw(`select 1 from ${table} limit 1`)), INSUFFICIENT_PRIVILEGE);
      },
    );

    it("auth_runtime cannot create, delete or re-role users, or write the audit log, or purge a client", async () => {
      const orgId = await seedOrg("authrole");
      const u = await seedUser(orgId, "authrole");
      await expectPgError(authDb.insert(schema.users).values({ organizationId: orgId, email: emailFor("x"), displayName: "x", role: "owner" }), INSUFFICIENT_PRIVILEGE);
      await expectPgError(authDb.execute(sql`delete from users where id = ${u.userId}`), INSUFFICIENT_PRIVILEGE);
      await expectPgError(authDb.execute(sql`update users set role = 'owner' where id = ${u.userId}`), INSUFFICIENT_PRIVILEGE);
      await expectPgError(authDb.execute(sql`update users set organization_id = ${orgId} where id = ${u.userId}`), INSUFFICIENT_PRIVILEGE);
      await expectPgError(authDb.execute(sql`update users set email = 'x@example.test' where id = ${u.userId}`), INSUFFICIENT_PRIVILEGE);
      await expectPgError(authDb.execute(sql`insert into audit_log (organization_id, action, resource_type) values (${orgId}, 'auth.login', 'users')`), INSUFFICIENT_PRIVILEGE);
      await expectPgError(authDb.execute(sql`select purge_client(${orgId}::uuid, ${orgId}::uuid)`), INSUFFICIENT_PRIVILEGE);
    });

    it("auth_runtime can see the identity of any user (it must find them by email) and set only the verification flag", async () => {
      const orgId = await seedOrg("authrole2");
      const u = await seedUser(orgId, "authrole2", { verified: false });
      const seen = await authDb.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, u.email));
      expect(seen).toHaveLength(1);
      await authDb.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, u.userId));
      const [row] = await owner.select().from(schema.users).where(eq(schema.users.id, u.userId));
      expect(row.emailVerified).toBe(true);
    });

    it.each(["auth_accounts", "auth_sessions", "auth_verifications", "auth_rate_limits"])(
      "app_runtime has no access to %s (feature code can never read a hash, token or session)",
      async (table) => {
        await expectPgError(app.execute(sql.raw(`select 1 from ${table} limit 1`)), INSUFFICIENT_PRIVILEGE);
        await expectPgError(app.execute(sql.raw(`delete from ${table}`)), INSUFFICIENT_PRIVILEGE);
      },
    );

    it("app_runtime cannot mark an email verified, on insert or update, but can still manage the other user fields", async () => {
      const orgId = await seedOrg("approle");
      const u = await seedUser(orgId, "approle", { verified: false });
      const asOrg = <R>(fn: (tx: Db) => Promise<R>) =>
        app.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.organization_id', ${orgId}, true)`);
          return fn(tx as unknown as Db);
        });
      await expectPgError(asOrg((tx) => tx.execute(sql`update users set email_verified = true where id = ${u.userId}`)), INSUFFICIENT_PRIVILEGE);
      await expectPgError(
        asOrg((tx) => tx.execute(sql`insert into users (organization_id, email, display_name, role, email_verified) values (${orgId}, ${emailFor("v")}, 'x', 'associate', true)`)),
        INSUFFICIENT_PRIVILEGE,
      );
      await asOrg((tx) => tx.execute(sql`update users set display_name = 'Synthetic Renamed' where id = ${u.userId}`));
      const inserted = await asOrg((tx) => tx.execute(sql`insert into users (organization_id, email, display_name, role) values (${orgId}, ${emailFor("v2")}, 'x', 'associate') returning email_verified`));
      expect(inserted.rows[0]).toMatchObject({ email_verified: false });
    });

    it("email is unique across practices, case does not matter, and a deactivated user keeps their address", async () => {
      const orgA = await seedOrg("uniq-a");
      const orgB = await seedOrg("uniq-b");
      const u = await seedUser(orgA, "uniq", { role: "associate" }); // not the practice's only owner: it gets deactivated below
      await expectPgError(
        owner.insert(schema.users).values({ organizationId: orgB, email: u.email, displayName: "dup", role: "owner" }),
        UNIQUE_VIOLATION,
      );
      await expectPgError(
        owner.insert(schema.users).values({ organizationId: orgB, email: u.email.toUpperCase(), displayName: "dup", role: "owner" }),
        CHECK_VIOLATION,
      );
      await owner.update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, u.userId));
      await expectPgError(
        owner.insert(schema.users).values({ organizationId: orgB, email: u.email, displayName: "dup", role: "owner" }),
        UNIQUE_VIOLATION,
      );
    });

    it("deleting a user removes their credentials and sessions with them", async () => {
      const orgId = await seedOrg("cascade");
      const u = await seedUser(orgId, "cascade");
      await signIn(u.email);
      await owner.execute(sql`delete from users where id = ${u.userId}`);
      expect(await owner.select().from(schema.authAccounts).where(eq(schema.authAccounts.userId, u.userId))).toHaveLength(0);
      expect(await owner.select().from(schema.authSessions).where(eq(schema.authSessions.userId, u.userId))).toHaveLength(0);
    });
  });

  describe("request safety", () => {
    it("rejects a cross-site sign-in request (origin check)", async () => {
      const orgId = await seedOrg("origin");
      const u = await seedUser(orgId, "origin");
      const res = await call("/sign-in/email", { body: { email: u.email, password: GOOD_PASSWORD }, origin: "https://evil.example" });
      expect(res.status).toBe(403);
      expect(cookieFrom(res)).toBe("");
    });

    it("rejects a redirect target outside the app (open redirect)", async () => {
      const orgId = await seedOrg("redirect");
      const u = await seedUser(orgId, "redirect");
      const res = await call("/request-password-reset", { body: { email: u.email, redirectTo: "https://evil.example/steal" } });
      expect(res.status).toBe(403);
      expect(outbox.filter((m) => m.to === u.email)).toHaveLength(0);
    });
  });

  describe("audit log content (audit 03 item 7, 04 item 9)", () => {
    it("every auth event written in this run is ids and allow-listed metadata: no email, password, token or name", async () => {
      const rows = await owner.select().from(schema.auditLog).where(inArray(schema.auditLog.organizationId, seededOrgs));
      expect(rows.length).toBeGreaterThan(10);
      const actions = new Set(rows.map((r) => r.action));
      for (const wanted of ["auth.login", "auth.login_failed", "auth.logout", "auth.password_changed", "auth.password_reset_requested", "auth.password_reset_completed", "auth.email_verified"]) {
        expect(actions.has(wanted), wanted).toBe(true);
      }
      const allowed = new Set(["reason", "ip", "method", "role"]);
      for (const r of rows) {
        for (const key of Object.keys(r.metadata)) expect(allowed.has(key), `${r.action}: ${key}`).toBe(true);
        // The action name legitimately says "password_changed"; everything else is checked.
        const { action: _action, ...rest } = r;
        void _action;
        const text = JSON.stringify(rest);
        // "method":"password" is the sign-in method, not a password; nothing else may look like one.
        expect(text.replace(/"method":"password(\+[a-z_]+)?"/, "")).not.toMatch(/@example\.test|passphrase|password|token|Synthetic/i);
      }
    });

    it("the audit log is append-only even for the roles that write it", async () => {
      const [row] = await owner.select().from(schema.auditLog).where(inArray(schema.auditLog.organizationId, seededOrgs)).limit(1);
      await expectPgError(app.execute(sql`update audit_log set action = 'x' where id = ${row.id}`), INSUFFICIENT_PRIVILEGE);
      await expectPgError(app.execute(sql`delete from audit_log where id = ${row.id}`), INSUFFICIENT_PRIVILEGE);
    });
  });

  describe("input handling and CORS (audit 04 items 4, 5)", () => {
    it.each([
      ["a non-string email", { email: 12345, password: GOOD_PASSWORD }],
      ["a missing password", { email: "a@example.test" }],
      ["a malformed address", { email: "not-an-email", password: GOOD_PASSWORD }],
      ["an object where a string belongs", { email: { $ne: "" }, password: { $ne: "" } }],
      ["an over-long password", { email: "a@example.test", password: "x".repeat(5000) }],
    ])("sign-in rejects %s with a 4xx and no session", async (_name, body) => {
      const res = await call("/sign-in/email", { body });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(cookieFrom(res)).toBe("");
    });

    it("SQL metacharacters in the address are data, not SQL: no error, no match, nothing leaked", async () => {
      const orgId = await seedOrg("sqli");
      const u = await seedUser(orgId, "sqli");
      for (const email of [`${u.email}' OR '1'='1`, "x@example.test'; drop table users; --", `%@example.test`]) {
        const res = await call("/sign-in/email", { body: { email, password: GOOD_PASSWORD } });
        expect(res.status, email).toBeLessThan(500);
        expect(cookieFrom(res), email).toBe("");
      }
      // The table is intact and the real user still signs in.
      expect((await signIn(u.email)).res.status).toBe(200);
    });

    it("the reset endpoint treats a hostile token as an unknown token", async () => {
      const res = await call("/reset-password", { body: { token: "' OR 1=1 --", newPassword: "a brand new passphrase 99" } });
      expect(res.status).toBe(400);
    });

    it("sends no CORS headers: a browser on another origin cannot read these responses", async () => {
      const orgId = await seedOrg("cors");
      const u = await seedUser(orgId, "cors");
      const res = await call("/sign-in/email", { body: { email: u.email, password: GOOD_PASSWORD }, origin: BASE });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
      const evil = await call("/sign-in/email", { body: { email: u.email, password: GOOD_PASSWORD }, origin: "https://evil.example" });
      expect(evil.status).toBe(403);
      expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    });
  });
});
