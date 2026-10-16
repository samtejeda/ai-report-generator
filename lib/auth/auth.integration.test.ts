import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
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

  const session = (cookie: string) => resolveSession(new Headers({ cookie }), { auth, authDb, now });

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
      expect(ctx).toEqual({ userId: u.userId, organizationId: orgId, role: "owner" });
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
      expect(await session(u.cookie)).toEqual({ userId: u.userId, organizationId: u.orgId, role: "associate" });
      await owner.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, u.userId));
      expect(await session(u.cookie)).toEqual({ userId: u.userId, organizationId: u.orgId, role: "admin" });
    });

    it("a user deactivated mid-session loses the session and all others", async () => {
      const u = await login("deactivate-midway");
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

    it.each(["clients", "client_history", "reports", "report_sections", "report_versions", "report_templates", "methodology_prompts", "rag_documents", "rag_chunks", "rag_embeddings", "jobs", "organizations", "audit_log"])(
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
      const u = await seedUser(orgA, "uniq");
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
        expect(text.replace('"method":"password"', "")).not.toMatch(/@example\.test|passphrase|password|token|Synthetic/i);
      }
    });

    it("the audit log is append-only even for the roles that write it", async () => {
      const [row] = await owner.select().from(schema.auditLog).where(inArray(schema.auditLog.organizationId, seededOrgs)).limit(1);
      await expectPgError(app.execute(sql`update audit_log set action = 'x' where id = ${row.id}`), INSUFFICIENT_PRIVILEGE);
      await expectPgError(app.execute(sql`delete from audit_log where id = ${row.id}`), INSUFFICIENT_PRIVILEGE);
    });
  });
});
