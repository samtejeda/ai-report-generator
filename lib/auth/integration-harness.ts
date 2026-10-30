import { expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client, Pool } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import * as schema from "@/lib/db/schema";

/**
 * Shared plumbing for the integration suites that call the REAL route modules with REAL sessions
 * (lib/auth/admin.integration.test.ts and later ones): the app's own configuration pointed at the
 * scratch database with the two real least-privilege roles, real Better Auth sign-in (password,
 * authenticator enrollment, first code), and a request helper. Nothing is mocked.
 *
 * Test-only: it reads the TEST_* variables from the gitignored .env.test.local (and sets the
 * runtime variables the route modules read), which is why it is listed in PROCESS_ENV_ALLOWED and
 * in the own-pool exemption in eslint.config.mjs. Synthetic data only.
 */

try {
  process.loadEnvFile(".env.test.local");
} catch {}

export const OWNER_URL = process.env.TEST_DATABASE_URL;
export const PASSWORD = process.env.TEST_APP_ROLE_PASSWORD;
export const ENABLED = Boolean(OWNER_URL && PASSWORD && /^[a-f0-9]{32,}$/.test(PASSWORD));
export const BASE = "http://localhost:3000";
export const GOOD_PASSWORD = "correct horse battery staple 1";

export type Role = "owner" | "associate" | "admin";
export type Db = NeonDatabase<typeof schema> & { $client: Pool };
export type Handler = (request: Request, ctx?: { params?: Promise<Record<string, string>> }) => Promise<Response>;
export type Person = { label: string; userId: string; orgId: string; email: string; secret?: string; cookie: string };
export type Reply = { status: number; text: string; json: Record<string, unknown> & { data?: unknown; error?: { code: string; message: string } }; headers: Headers };

// RFC 6238 TOTP, what an authenticator app does, so the sign-in is the real one.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function totpCode(secret: string, at = Date.now()): string {
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

export async function startHarness(options: { appRole: string; authRole: string; secret: string }) {
  const ownerPool = new Pool({ connectionString: OWNER_URL });
  const owner = drizzle(ownerPool, { schema }) as Db;

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
  // Set BEFORE any route module is imported: the environment is read once, on first use.
  process.env.DATABASE_URL = await loginUrl(options.appRole, "app_runtime");
  process.env.AUTH_DATABASE_URL = await loginUrl(options.authRole, "auth_runtime");
  process.env.BETTER_AUTH_SECRET = options.secret;
  process.env.BETTER_AUTH_URL = BASE;
  process.env.EMAIL_TRANSPORT = "console";
  // The console mail transport prints notices; keep the test output readable.
  vi.spyOn(console, "info").mockImplementation(() => {});

  const server = await import("./server");
  const handle = (request: Request) => server.getAuth().handler(request);
  const hashPassword = (await server.getAuth().$context).password.hash;

  const runOctets = crypto.getRandomValues(new Uint8Array(2)).join(".");
  let ipCounter = 1;
  const nextIp = () => `10.${runOctets}.${ipCounter++ % 250}`;

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
  const cookieFrom = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !/=$/.test(c)).join("; ");

  async function seedOrg(label: string): Promise<string> {
    const [org] = await owner.insert(schema.organizations).values({ name: `Synthetic Org ${label}` }).returning();
    return org.id;
  }

  async function seedUser(orgId: string, label: string, role: Role): Promise<Omit<Person, "cookie">> {
    const email = `${label}-${crypto.randomUUID()}@example.test`;
    const [u] = await owner.insert(schema.users).values({ organizationId: orgId, email, displayName: `Synthetic ${label}`, role, emailVerified: true }).returning();
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

  const makePerson = async (orgId: string, label: string, role: Role) => enroll(await seedUser(orgId, label, role));

  /** Everything every caller ever received, so a suite can scan it for another practice's data. */
  const seen: { caller: string; orgId: string; text: string }[] = [];

  /**
   * One request through a real route module. State-changing methods carry the app's own Origin
   * unless the caller overrides it (pass `origin: null` to send none).
   */
  async function call(
    who: { label: string; orgId: string; cookie?: string },
    handler: Handler,
    o: { method?: string; path: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; origin?: string | null; params?: Record<string, string> },
  ): Promise<Reply> {
    const method = o.method ?? "GET";
    const headers = new Headers({ "user-agent": "vitest", ...o.headers });
    if (who.cookie) headers.set("cookie", who.cookie);
    if (method !== "GET" && o.origin !== null) headers.set("origin", o.origin ?? BASE);
    const payload = o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    if (payload !== undefined) headers.set("content-type", "application/json");
    const res = await handler(new Request(`${BASE}${o.path}`, { method, headers, body: payload }), o.params ? { params: Promise.resolve(o.params) } : undefined);
    const text = await res.text();
    seen.push({ caller: who.label, orgId: who.orgId, text });
    return { status: res.status, text, json: text ? JSON.parse(text) : {}, headers: res.headers };
  }

  /** Make a person's sign-in `secondsAgo` old (the session's created_at), to test the fresh gate. */
  async function signedInAgo(p: Pick<Person, "userId">, secondsAgo: number) {
    await owner.execute(sql`update auth_sessions set created_at = now() - make_interval(secs => ${secondsAgo}) where user_id = ${p.userId}`);
  }

  /**
   * The SQL text of every statement sent to the database while `run` executes (the app's own
   * pool and this one share the driver), so a test can count queries, e.g. to prove there is no
   * N+1. Text only; parameters are not recorded.
   */
  async function statementsOf(run: () => Promise<unknown>): Promise<string[]> {
    const sent: string[] = [];
    const original = Client.prototype.query;
    const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function (this: unknown, ...args: unknown[]) {
      const first = args[0] as string | { text?: string };
      sent.push(typeof first === "string" ? first : (first.text ?? ""));
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return sent;
  }

  async function stop() {
    await ownerPool.end();
  }

  return { owner, handle, authCall, cookieFrom, seedOrg, seedUser, enroll, makePerson, call, seen, signedInAgo, statementsOf, stop };
}
