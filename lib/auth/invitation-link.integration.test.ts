import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import * as schema from "@/lib/db/schema";
import { hashInvitationToken, newInvitationToken } from "./invitation-token";
import { ENABLED, GOOD_PASSWORD, startHarness, type Handler, type Person } from "./integration-harness";

// The accept-invitation page's up-front link check (U1) against the REAL database and roles: the real
// gate component, the real invitation_link_usable() function (migration 0018), the real invitation and
// accept routes. Only the two Next-specific edges are stubbed: the request headers (the client address)
// and "is the visitor signed in" (not what is tested here). Synthetic data only.
//
// NOT RUN YET when written: it needs migration 0018 on the scratch database (database-builder's PR).
// Needs the TEST_* variables (see lib/auth/integration-harness.ts); skipped when absent.
vi.setConfig({ testTimeout: 120_000 });

const request = vi.hoisted(() => ({ ip: "203.0.113.1" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": request.ip }) }));
vi.mock("@/lib/auth/visitor", () => ({ leaveIfSignedIn: async () => {} }));

describe.skipIf(!ENABLED)("the accept page's link check through the real stack", () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let invitations: { POST: Handler };
  let revokeRoute: { POST: Handler };
  let resendRoute: { POST: Handler };
  let acceptRoute: { POST: Handler };
  let Gate: (props: { searchParams: Promise<{ token?: string }> }) => Promise<React.ReactElement>;

  let orgA: string;
  let orgB: string;
  let ownerA: Person;

  let printed: string[] = [];
  const logged: string[] = [];
  const minted: string[] = [];
  const fresh = (label: string) => `${label}-${crypto.randomUUID()}@example.test`;
  const tokenFor = (email: string) => {
    const match = printed.filter((l) => l.includes(`to=${email} `)).at(-1)?.match(/accept-invitation\?token=([A-Za-z0-9_-]+)/);
    if (!match) throw new Error(`no invitation mail for ${email}`);
    minted.push(match[1]);
    return match[1];
  };
  const runOctet = Math.floor(Math.random() * 256);
  let ipCounter = 0;
  const nextIp = () => `198.51.${runOctet}.${(ipCounter++ % 250) + 1}`;

  /** What the visitor's browser would be served for this address (the page's markup), from a given client address. */
  const page = async (token: string | undefined, ip: string = nextIp()) => {
    request.ip = ip;
    return renderToStaticMarkup(await Gate({ searchParams: Promise.resolve({ token }) }));
  };
  const mint = async () => {
    await h.signedInAgo(ownerA, 5);
    const email = fresh("link");
    const r = await h.call(ownerA, invitations.POST, { method: "POST", path: "/api/admin/invitations", body: { email } });
    expect(r.status).toBe(201);
    return { id: (r.json.data as { id: string }).id, email, token: tokenFor(email) };
  };
  const accept = (token: string) =>
    h.call({ label: "visitor", orgId: "none" }, acceptRoute.POST, { method: "POST", path: "/api/invitations/accept", body: { token, name: "Synthetic Invitee", password: GOOD_PASSWORD }, headers: { "x-forwarded-for": nextIp() } });
  const row = async (id: string) => (await h.owner.select().from(schema.invitations).where(eq(schema.invitations.id, id)))[0];
  const auditCount = async (orgId: string) => Number((await h.owner.execute(sql`select count(*)::int as n from audit_log where organization_id = ${orgId}`)).rows[0].n);

  beforeAll(async () => {
    h = await startHarness({ appRole: "app_runtime_linkcheck", authRole: "auth_runtime_linkcheck", secret: "link-check-test-secret-".padEnd(48, "x") });
    vi.mocked(console.info).mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    for (const level of ["warn", "error", "log"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    invitations = (await import("@/app/api/admin/invitations/route")) as unknown as { POST: Handler };
    revokeRoute = (await import("@/app/api/admin/invitations/[id]/revoke/route")) as unknown as { POST: Handler };
    resendRoute = (await import("@/app/api/admin/invitations/[id]/resend/route")) as unknown as { POST: Handler };
    acceptRoute = (await import("@/app/api/invitations/accept/route")) as unknown as { POST: Handler };
    Gate = (await import("@/components/auth/accept-invitation-gate")).AcceptInvitationGate as typeof Gate;
    orgA = await h.seedOrg("link-A");
    orgB = await h.seedOrg("link-B");
    ownerA = await h.makePerson(orgA, "owner-a", "owner");
  }, 300_000);

  beforeEach(() => {
    printed = [];
  });
  afterAll(async () => {
    await h?.stop();
  });

  it("a usable link shows the form", async () => {
    const { token } = await mint();
    const html = await page(token);
    expect(html).toContain("<form");
    expect(html).toMatch(/name="password"/);
    expect(html).not.toContain("This invitation link is not valid");
    expect(html).not.toContain(token);
  });

  it("used, revoked, expired, replaced, address-taken and random links all show the SAME page as a missing or malformed token, byte for byte, and never a form", async () => {
    const notValid = await page(undefined);
    expect(notValid).not.toContain("<form");
    expect(notValid).toContain("This invitation link is not valid");

    const used = await mint();
    expect((await accept(used.token)).status).toBe(201);

    const revoked = await mint();
    await h.signedInAgo(ownerA, 5);
    expect((await h.call(ownerA, revokeRoute.POST, { method: "POST", path: `/api/admin/invitations/${revoked.id}/revoke`, params: { id: revoked.id } })).status).toBe(200);

    const expired = await mint();
    await h.owner.update(schema.invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.invitations.id, expired.id));

    const replaced = await mint();
    expect((await h.call(ownerA, resendRoute.POST, { method: "POST", path: `/api/admin/invitations/${replaced.id}/resend`, params: { id: replaced.id } })).status).toBe(200);
    const replacement = tokenFor(replaced.email);
    expect(replacement).not.toBe(replaced.token);

    const taken = await mint();
    await h.owner.insert(schema.users).values({ organizationId: orgB, email: taken.email, displayName: "Synthetic Earlier", role: "associate", emailVerified: true });

    const cases: [string, string][] = [
      ["used", used.token],
      ["revoked", revoked.token],
      ["expired", expired.token],
      ["replaced", replaced.token],
      ["address taken", taken.token],
      ["random", newInvitationToken().token],
      ["malformed", "not-a-token"],
    ];
    for (const [label, token] of cases) expect(await page(token), label).toBe(notValid);
    // The replacement link itself is usable.
    expect(await page(replacement)).toContain("<form");
  });

  it("checking consumes nothing: the invitation row and the audit log are untouched after many views, and the link still works", async () => {
    const { id, token } = await mint();
    const before = await row(id);
    const auditBefore = await auditCount(orgA);
    for (let i = 0; i < 5; i++) expect(await page(token)).toContain("<form");
    const after = await row(id);
    expect(after).toEqual(before);
    expect(await auditCount(orgA)).toBe(auditBefore);
    expect((await accept(token)).status).toBe(201);
  });

  it("limits checks per client address (IPv6 per /64, only well-formed tokens count); over the limit the page falls back to the form for EVERY token, so being limited tells nobody anything", async () => {
    const a = Math.floor(Math.random() * 65_536).toString(16);
    const b = Math.floor(Math.random() * 65_536).toString(16);
    const first = `2001:db8:${a}:${b}::1`;
    const sameSubnet = `2001:db8:${a}:${b}:aaaa::2`;
    // Malformed tokens never count.
    for (let i = 0; i < 40; i++) expect(await page("nope", first)).not.toContain("<form");
    for (let i = 0; i < 30; i++) expect(await page(newInvitationToken().token, i % 2 ? first : sameSubnet), `check ${i + 1}`).not.toContain("<form");
    const { token } = await mint();
    // The 31st check from the /64: no lookup, the form, for a made-up link and a real one alike.
    const randomLimited = await page(newInvitationToken().token, first);
    const realLimited = await page(token, sameSubnet);
    expect(randomLimited).toContain("<form");
    expect(realLimited).toBe(randomLimited);
    // Another address is unaffected.
    expect(await page(newInvitationToken().token, nextIp())).not.toContain("<form");
  });

  it("the database function: executable by auth_runtime only, read-only (STABLE, no audit row), false for a bad hash, and answers a bare boolean", async () => {
    const { id, token } = await mint();
    const hash = hashInvitationToken(token);
    const auditBefore = await auditCount(orgA);
    const ask = async (value: string) => (await h.asRole("auth", "select invitation_link_usable($1) as u", [value])).rows[0].u;
    expect(await ask(hash)).toBe(true);
    expect(await ask("0".repeat(64))).toBe(false);
    expect(await ask("not-hex")).toBe(false);
    expect(await auditCount(orgA)).toBe(auditBefore);
    expect(await row(id)).toMatchObject({ acceptedAt: null, revokedAt: null });
    const meta = (await h.owner.execute(sql`select provolatile::text as v, prosecdef as d from pg_proc where proname = 'invitation_link_usable'`)).rows[0];
    expect(meta).toEqual({ v: "s", d: true });
    await expect(h.asRole("app", "select invitation_link_usable($1)", [hash])).rejects.toMatchObject({ code: "42501" });
    // It follows the same rules as accept_invitation(): once accepted, the same hash is no longer usable.
    expect((await accept(token)).status).toBe(201);
    expect(await ask(hash)).toBe(false);
  });

  it("no token or hash appears in any log line or audit row written by any of this", async () => {
    expect(minted.length).toBeGreaterThan(5);
    const rows = await h.owner.execute(sql`select metadata::text as m, resource_id::text as r from audit_log where organization_id in (${orgA}, ${orgB})`);
    const everything = JSON.stringify(rows.rows) + logged.join("\n");
    for (const token of minted) {
      expect(everything).not.toContain(token);
      expect(everything).not.toContain(hashInvitationToken(token));
    }
  });
});
