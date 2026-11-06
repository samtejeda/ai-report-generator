import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { hashInvitationToken, INVITATION_TOKEN_PATTERN } from "./invitation-token";
import { BASE, ENABLED, GOOD_PASSWORD, startHarness, type Handler, type Person } from "./integration-harness";

// Invitations (feat/invitations) end to end: the REAL route modules, the REAL Better Auth instance
// (every caller holds a cookie from a real password + authenticator sign-in), and the REAL
// auth_runtime / app_runtime roles with row-level security, on the scratch database. The mail
// transport is the real console one; this suite reads the link out of what it prints, the way Sam
// does in the dev terminal. Synthetic data only.
//
// Needs the TEST_* variables (see lib/auth/integration-harness.ts); skipped when absent.
vi.setConfig({ testTimeout: 120_000 });

describe.skipIf(!ENABLED)("invitations through the real stack", () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let listRoute: { GET: Handler; POST: Handler };
  let revokeRoute: { POST: Handler };
  let resendRoute: { POST: Handler };
  let acceptRoute: { POST: Handler };
  let meRoute: { GET: Handler };
  let clientsRoute: { GET: Handler };
  let clientRoute: { GET: Handler };
  let assignmentsRoute: { POST: Handler };

  let orgA: string;
  let orgB: string;
  let orgC: string;
  let orgD: string;
  let orgE: string;
  let orgF: string;
  // Creating or re-sending is limited to 20 an hour per practice and audit rows cannot be deleted, so each group of
  // tests that creates many invitations uses its own practice: A (who may call, listing, cross-tenant), D (creating),
  // E (addresses that have an account), C (the limit itself).
  let ownerA: Person, ownerA2: Person, adminA: Person, assocA: Person;
  let ownerB: Person, assocB: Person;
  let ownerC: Person, ownerD: Person, ownerE: Person, ownerF: Person;
  let clientF: string;
  let deactivatedB: { userId: string; email: string };

  // Everything the console transport printed: the only place a raw token ever appears.
  let printed: string[] = [];
  const logged: string[] = [];

  const fresh = (label: string) => `${label}-${crypto.randomUUID()}@example.test`;
  const mailsTo = (email: string) => printed.filter((line) => line.includes(`to=${email} `));
  const tokenFor = (email: string): string => {
    const lines = mailsTo(email);
    const match = lines.at(-1)?.match(/accept-invitation\?token=([A-Za-z0-9_-]+)/);
    if (!match) throw new Error(`no invitation mail was printed for ${email}`);
    return match[1];
  };

  const invite = (who: Person, body: unknown, o: { origin?: string | null } = {}) =>
    h.call(who, listRoute.POST, { method: "POST", path: "/api/admin/invitations", body, ...o });
  const list = (who: Person, query = "") => h.call(who, listRoute.GET, { path: `/api/admin/invitations${query}` });
  const revoke = (who: Person, id: string) => h.call(who, revokeRoute.POST, { method: "POST", path: `/api/admin/invitations/${id}/revoke`, params: { id } });
  const resend = (who: Person, id: string) => h.call(who, resendRoute.POST, { method: "POST", path: `/api/admin/invitations/${id}/resend`, params: { id } });
  const stored = async (id: string) => (await h.owner.select().from(schema.invitations).where(eq(schema.invitations.id, id)))[0];
  const auditRows = (orgId: string, action: string) =>
    h.owner.select().from(schema.auditLog).where(and(eq(schema.auditLog.organizationId, orgId), eq(schema.auditLog.action, action)));
  const auditFor = async (action: string, resourceId: string) => (await h.owner.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.resourceId, resourceId))));
  // Same discipline as the admin suite: no slicing by an earlier count (heap order is not insertion order).
  const seenDenied = async () => new Set((await auditRows(orgA, "authz.denied")).map((r) => r.id));
  const newDenied = async (seen: Set<string>) => (await auditRows(orgA, "authz.denied")).filter((r) => !seen.has(r.id));
  /** A sign-in from "now", so the fresh gate lets the owner create. */
  const justSignedIn = (p: Person) => h.signedInAgo(p, 5);

  beforeAll(async () => {
    h = await startHarness({ appRole: "app_runtime_invite", authRole: "auth_runtime_invite", secret: "invitation-test-secret-".padEnd(48, "x") });
    // The harness silences console.info; capture it instead (the dev mail transport prints there).
    vi.mocked(console.info).mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    for (const level of ["warn", "error", "log"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    listRoute = (await import("@/app/api/admin/invitations/route")) as unknown as { GET: Handler; POST: Handler };
    revokeRoute = (await import("@/app/api/admin/invitations/[id]/revoke/route")) as unknown as { POST: Handler };
    resendRoute = (await import("@/app/api/admin/invitations/[id]/resend/route")) as unknown as { POST: Handler };
    acceptRoute = (await import("@/app/api/invitations/accept/route")) as unknown as { POST: Handler };
    meRoute = (await import("@/app/api/me/route")) as unknown as { GET: Handler };
    clientsRoute = (await import("@/app/api/clients/route")) as unknown as { GET: Handler };
    clientRoute = (await import("@/app/api/clients/[id]/route")) as unknown as { GET: Handler };
    assignmentsRoute = (await import("@/app/api/admin/assignments/route")) as unknown as { POST: Handler };

    orgA = await h.seedOrg("invite-A");
    orgB = await h.seedOrg("invite-B");
    orgC = await h.seedOrg("invite-C");
    orgD = await h.seedOrg("invite-D");
    orgE = await h.seedOrg("invite-E");
    orgF = await h.seedOrg("invite-F");
    [ownerA, ownerA2, adminA, assocA, ownerB, assocB, ownerC, ownerD, ownerE, ownerF] = await Promise.all([
      h.makePerson(orgA, "owner-a", "owner"),
      h.makePerson(orgA, "owner-a2", "owner"),
      h.makePerson(orgA, "admin-a", "admin"),
      h.makePerson(orgA, "assoc-a", "associate"),
      h.makePerson(orgB, "owner-b", "owner"),
      h.makePerson(orgB, "assoc-b", "associate"),
      h.makePerson(orgC, "owner-c", "owner"),
      h.makePerson(orgD, "owner-d", "owner"),
      h.makePerson(orgE, "owner-e", "owner"),
      h.makePerson(orgF, "owner-f", "owner"),
    ]);
    const [client] = await h.owner.insert(schema.clients).values({ organizationId: orgF, displayName: "Synthetic Client F" }).returning();
    clientF = client.id;
    const dead = await h.seedUser(orgB, "deactivated-b", "associate");
    await h.owner.update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, dead.userId));
    deactivatedB = { userId: dead.userId, email: dead.email };
  }, 300_000);

  beforeEach(() => {
    printed = [];
  });

  afterAll(async () => {
    await h?.stop();
  });

  // ---------------------------------------------------------------------------------------
  describe("who may call the owner routes", () => {
    it("no session is 401 on every route, and nothing is stored or mailed", async () => {
      const nobody = { label: "nobody", orgId: "none" };
      const id = crypto.randomUUID();
      const email = fresh("nobody");
      const before = (await h.owner.select().from(schema.invitations)).length;
      expect((await h.call(nobody, listRoute.GET, { path: "/api/admin/invitations" })).status).toBe(401);
      expect((await h.call(nobody, listRoute.POST, { method: "POST", path: "/api/admin/invitations", body: { email } })).status).toBe(401);
      expect((await h.call(nobody, revokeRoute.POST, { method: "POST", path: `/api/admin/invitations/${id}/revoke`, params: { id } })).status).toBe(401);
      expect((await h.call(nobody, resendRoute.POST, { method: "POST", path: `/api/admin/invitations/${id}/resend`, params: { id } })).status).toBe(401);
      expect((await h.owner.select().from(schema.invitations)).length).toBe(before);
      expect(mailsTo(email)).toHaveLength(0);
    });

    it("an admin and an associate get 403 on all four routes, each audited with role and reason only, and nothing is created", async () => {
      await justSignedIn(ownerA);
      const real = await invite(ownerA, { email: fresh("target") });
      expect(real.status).toBe(201);
      const id = (real.json.data as { id: string }).id;
      const email = fresh("refused");
      const seen = await seenDenied();
      const before = (await h.owner.select().from(schema.invitations).where(eq(schema.invitations.organizationId, orgA))).length;

      for (const who of [adminA, assocA]) {
        expect((await list(who)).status, `${who.label} list`).toBe(403);
        const created = await invite(who, { email });
        expect(created.status, `${who.label} create`).toBe(403);
        expect(created.json.error?.code).toBe("forbidden");
        expect((await revoke(who, id)).status, `${who.label} revoke`).toBe(403);
        expect((await resend(who, id)).status, `${who.label} resend`).toBe(403);
      }

      const denied = await newDenied(seen);
      expect(denied).toHaveLength(8);
      expect(denied.every((d) => d.resourceType === "invitation" && d.outcome === "denied")).toBe(true);
      expect(denied.map((d) => d.actorUserId).sort()).toEqual([adminA.userId, adminA.userId, adminA.userId, adminA.userId, assocA.userId, assocA.userId, assocA.userId, assocA.userId].sort());
      for (const d of denied) expect(d.metadata).toEqual({ role: expect.stringMatching(/^(admin|associate)$/), reason: "role_not_allowed" });
      expect(JSON.stringify(denied)).not.toContain(email);

      expect((await h.owner.select().from(schema.invitations).where(eq(schema.invitations.organizationId, orgA))).length).toBe(before);
      expect(mailsTo(email)).toHaveLength(0);
      // The refused revoke changed nothing.
      expect((await stored(id)).revokedAt).toBeNull();
    });

    it("a state-changing call from another origin, or with none, is refused before anything happens", async () => {
      await justSignedIn(ownerA);
      const email = fresh("origin");
      expect((await invite(ownerA, { email }, { origin: "https://evil.example" })).status).toBe(403);
      expect((await invite(ownerA, { email }, { origin: null })).status).toBe(403);
      expect(mailsTo(email)).toHaveLength(0);
      expect(await h.owner.select().from(schema.invitations).where(eq(schema.invitations.email, email))).toHaveLength(0);
    });

    it("creating needs a sign-in from the last 5 minutes (403 reauth_required, audited); listing, revoking and resending do not", async () => {
      await justSignedIn(ownerA);
      const first = await invite(ownerA, { email: fresh("fresh-gate") });
      const id = (first.json.data as { id: string }).id;
      await h.signedInAgo(ownerA2, 600);
      const email = fresh("stale");
      const seen = await seenDenied();
      const r = await invite(ownerA2, { email });
      expect(r.status).toBe(403);
      expect(r.json.error?.code).toBe("reauth_required");
      const denied = await newDenied(seen);
      expect(denied).toHaveLength(1);
      expect(denied[0].metadata).toMatchObject({ role: "owner", reason: "sign_in_not_recent" });
      expect(mailsTo(email)).toHaveLength(0);
      expect(await h.owner.select().from(schema.invitations).where(eq(schema.invitations.email, email))).toHaveLength(0);

      expect((await list(ownerA2)).status).toBe(200);
      expect((await resend(ownerA2, id)).status).toBe(200);
      expect((await revoke(ownerA2, id)).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("creating an invitation", () => {
    it("stores only a hash of the token: the raw token is in the mail and nowhere else", async () => {
      await justSignedIn(ownerD);
      const email = fresh("hashed");
      const r = await invite(ownerD, { email });
      expect(r.status).toBe(201);
      expect(r.headers.get("cache-control")).toBe("private, no-store");
      const data = r.json.data as Record<string, unknown>;
      expect(Object.keys(data).sort()).toEqual(["createdAt", "email", "expiresAt", "id", "invitedByUserId", "role", "status"]);
      expect(data).toMatchObject({ email, role: "associate", status: "pending", invitedByUserId: ownerD.userId });

      const token = tokenFor(email);
      expect(token).toMatch(INVITATION_TOKEN_PATTERN);
      const row = await stored(data.id as string);
      expect(row.tokenHash).toBe(hashInvitationToken(token));
      expect(row.organizationId).toBe(orgD);
      expect(row.acceptedAt).toBeNull();
      expect(row.revokedAt).toBeNull();
      // 7 days, give or take the time the request took.
      expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(7 * 86_400_000 - 120_000);
      expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);

      // The raw token is in no column of any row, not in the response, the audit log or any log line.
      const whole = await h.owner.execute(sql`select to_jsonb(i)::text as t from invitations i where i.id = ${row.id}`);
      expect(String((whole.rows[0] as { t: string }).t)).not.toContain(token);
      expect(r.text).not.toContain(token);
      expect(r.text).not.toContain(row.tokenHash);
      const everyAudit = await h.owner.execute(sql`select count(*)::int as n from audit_log where metadata::text like ${"%" + token + "%"} or metadata::text like ${"%" + row.tokenHash + "%"} or resource_id::text like ${"%" + token + "%"}`);
      expect(Number((everyAudit.rows[0] as { n: number }).n)).toBe(0);
      expect(logged.join("\n")).not.toContain(token);

      // The mail is a link and fixed sentences, to the invited address only.
      const mail = mailsTo(email).at(-1)!;
      expect(mail).toContain(`to=${email} subject=You have been invited to create an account`);
      expect(mail).toContain(`${BASE}/accept-invitation?token=${token}`);
      expect(mail).not.toMatch(/Synthetic|owner-a|invite-A|practice name/i);
    });

    it("audits the creation with ids only: no address, no token", async () => {
      await justSignedIn(ownerD);
      const email = fresh("audited");
      const id = ((await invite(ownerD, { email })).json.data as { id: string }).id;
      const rows = await auditFor("invitation.created", id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ organizationId: orgD, actorUserId: ownerD.userId, resourceType: "invitation", outcome: "success", metadata: { role: "associate" } });
      expect(JSON.stringify(rows[0])).not.toContain(email);
      expect(JSON.stringify(rows[0])).not.toContain(tokenFor(email));
    });

    it("lowercases the address, and refuses a bad one, an extra key and any role but associate (nothing is stored or mailed)", async () => {
      await justSignedIn(ownerD);
      const mixed = fresh("MiXeD").replace("example.test", "Example.TEST");
      const ok = await invite(ownerD, { email: `  ${mixed}  `, role: "associate" });
      expect(ok.status).toBe(201);
      expect((ok.json.data as { email: string }).email).toBe(mixed.toLowerCase());

      const bad = fresh("bad");
      const cases: [string, unknown][] = [
        ["role admin", { email: bad, role: "admin" }],
        ["role owner", { email: bad, role: "owner" }],
        ["role with a space", { email: bad, role: "associate " }],
        ["role null", { email: bad, role: null }],
        ["extra key", { email: bad, organizationId: orgB }],
        ["invited_by", { email: bad, invitedBy: ownerB.userId }],
        ["no email", {}],
        ["not an address", { email: "not-an-address" }],
        ["too long", { email: `${"a".repeat(250)}@example.test` }],
        ["email as a number", { email: 42 }],
        ["array body", [bad]],
      ];
      for (const [label, body] of cases) {
        const r = await invite(ownerD, body);
        expect(r.status, label).toBe(400);
        expect(r.json.error?.code, label).toBe("validation_failed");
      }
      expect((await h.call(ownerD, listRoute.POST, { method: "POST", path: "/api/admin/invitations", rawBody: "{not json" })).status).toBe(400);
      expect((await h.call(ownerD, listRoute.POST, { method: "POST", path: "/api/admin/invitations", rawBody: JSON.stringify({ email: bad, pad: "x".repeat(3000) }) })).status).toBe(400);
      expect(await h.owner.select().from(schema.invitations).where(eq(schema.invitations.email, bad))).toHaveLength(0);
      expect(mailsTo(bad)).toHaveLength(0);
    });

    it("a second invitation to the same address replaces the pending one: one row, a new link, the old token no longer matches", async () => {
      await justSignedIn(ownerD);
      const email = fresh("replaced");
      const first = await invite(ownerD, { email });
      const id = (first.json.data as { id: string }).id;
      const firstToken = tokenFor(email);
      const second = await invite(ownerD, { email });
      expect(second.status).toBe(201);
      expect((second.json.data as { id: string }).id).toBe(id);
      const secondToken = tokenFor(email);
      expect(secondToken).not.toBe(firstToken);
      expect(mailsTo(email)).toHaveLength(2);

      const rows = await h.owner.select().from(schema.invitations).where(and(eq(schema.invitations.organizationId, orgD), eq(schema.invitations.email, email)));
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).toBe(hashInvitationToken(secondToken));
      expect(rows[0].tokenHash).not.toBe(hashInvitationToken(firstToken));
      expect(await h.owner.select().from(schema.invitations).where(eq(schema.invitations.tokenHash, hashInvitationToken(firstToken)))).toHaveLength(0);
    });

    it("inviting an address that was revoked starts a fresh invitation (a closed one is not reopened)", async () => {
      await justSignedIn(ownerD);
      const email = fresh("again");
      const id1 = ((await invite(ownerD, { email })).json.data as { id: string }).id;
      expect((await revoke(ownerD, id1)).status).toBe(200);
      const id2 = ((await invite(ownerD, { email })).json.data as { id: string }).id;
      expect(id2).not.toBe(id1);
      expect((await stored(id1)).revokedAt).not.toBeNull();
      expect((await stored(id2)).revokedAt).toBeNull();
    });

    it("two practices may invite the same new address; each has its own pending row and link", async () => {
      await justSignedIn(ownerD);
      await justSignedIn(ownerB);
      const email = fresh("shared");
      const a = await invite(ownerD, { email });
      const tokenA = tokenFor(email);
      const b = await invite(ownerB, { email });
      const tokenB = tokenFor(email);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(tokenA).not.toBe(tokenB);
      expect((await stored((a.json.data as { id: string }).id)).organizationId).toBe(orgD);
      expect((await stored((b.json.data as { id: string }).id)).organizationId).toBe(orgB);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("an address that already has an account (no enumeration)", () => {
    const shape = (r: { status: number; json: Record<string, unknown> }) => ({
      status: r.status,
      keys: Object.keys((r.json.data ?? {}) as object).sort(),
      data: Object.fromEntries(Object.entries((r.json.data ?? {}) as Record<string, unknown>).filter(([k]) => ["role", "status"].includes(k))),
    });

    it("gives the owner the same answer as for a new address (even for a deactivated person in another practice), sends no mail, and shows it in the list", async () => {
      await justSignedIn(ownerE);
      const fresher = await invite(ownerE, { email: fresh("newcomer") });
      const baseline = shape(fresher);
      expect(baseline.status).toBe(201);

      for (const taken of [assocB.email, ownerB.email, deactivatedB.email, assocA.email, ownerA.email.toUpperCase()]) {
        printed = [];
        const r = await invite(ownerE, { email: taken });
        expect(shape(r), taken).toEqual(baseline);
        expect(r.headers.get("cache-control")).toBe("private, no-store");
        expect(mailsTo(taken.toLowerCase()), `no mail to ${taken}`).toHaveLength(0);
        expect(printed, "nothing printed at all").toHaveLength(0);

        // The row is stored and listed exactly like any other, so the list cannot tell either.
        const id = (r.json.data as { id: string }).id;
        const listed = ((await list(ownerE, "?limit=100")).json.data as { id: string; email: string; status: string }[]).find((x) => x.id === id);
        expect(listed, taken).toMatchObject({ email: taken.toLowerCase(), status: "pending" });
      }
    });

    it("audits the refusal in the inviting practice only, with a closed reason: never the address, never which practice has it", async () => {
      await justSignedIn(ownerE);
      // A person nobody else invited in this practice, so the invitation (and its one audit row) is new.
      const email = (await h.seedUser(orgB, "audit-taken", "associate")).email;
      const id = ((await invite(ownerE, { email })).json.data as { id: string }).id;
      const refused = await auditFor("invitation.refused", id);
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({ organizationId: orgE, actorUserId: ownerE.userId, resourceType: "invitation", outcome: "denied", metadata: { reason: "address_in_use", role: "associate" } });
      expect(await auditFor("invitation.created", id)).toHaveLength(0);
      const text = JSON.stringify(refused[0]);
      expect(text).not.toContain(email);
      expect(text).not.toContain(orgB);
      // Practice B sees nothing of it.
      expect((await h.owner.select().from(schema.auditLog).where(and(eq(schema.auditLog.organizationId, orgB), eq(schema.auditLog.resourceId, id)))).length).toBe(0);
      expect(((await list(ownerB, "?limit=100")).json.data as { id: string }[]).some((x) => x.id === id)).toBe(false);
    });

    it("re-sending to an address that has an account by now looks the same and mails nothing", async () => {
      await justSignedIn(ownerE);
      const email = fresh("later-taken");
      const id = ((await invite(ownerE, { email })).json.data as { id: string }).id;
      const normal = await resend(ownerE, id);
      expect(normal.status).toBe(200);
      expect(mailsTo(email)).toHaveLength(2);

      // The address gets an account in practice B in the meantime.
      await h.owner.insert(schema.users).values({ organizationId: orgB, email, displayName: "Synthetic Later", role: "associate", emailVerified: true });
      printed = [];
      const after = await resend(ownerE, id);
      expect(after.status).toBe(200);
      expect(Object.keys(after.json.data as object).sort()).toEqual(Object.keys(normal.json.data as object).sort());
      expect(mailsTo(email)).toHaveLength(0);
      const refused = await auditFor("invitation.refused", id);
      expect(refused).toHaveLength(1);
      expect(refused[0].metadata).toEqual({ reason: "address_in_use", role: "associate" });
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("listing, revoking and re-sending", () => {
    it("lists the practice's own invitations with a derived status, and never a token, hash or another practice's row", async () => {
      await justSignedIn(ownerA);
      await justSignedIn(ownerB);
      const mineEmail = fresh("list-mine");
      const theirsEmail = fresh("list-theirs");
      const mine = ((await invite(ownerA, { email: mineEmail })).json.data as { id: string }).id;
      const theirs = ((await invite(ownerB, { email: theirsEmail })).json.data as { id: string }).id;
      const expiredId = ((await invite(ownerA, { email: fresh("list-expired") })).json.data as { id: string }).id;
      await h.owner.update(schema.invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.invitations.id, expiredId));
      const revokedId = ((await invite(ownerA, { email: fresh("list-revoked") })).json.data as { id: string }).id;
      await revoke(ownerA, revokedId);

      const r = await list(ownerA, "?limit=100");
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("private, no-store");
      const rows = r.json.data as { id: string; email: string; status: string }[];
      const byId = new Map(rows.map((x) => [x.id, x]));
      expect(byId.get(mine)?.status).toBe("pending");
      expect(byId.get(expiredId)?.status).toBe("expired");
      expect(byId.get(revokedId)?.status).toBe("revoked");
      expect(byId.has(theirs)).toBe(false);
      expect(r.text).not.toContain(theirsEmail);
      expect(r.text).not.toMatch(/token|hash/i);
      expect(r.text).not.toContain(hashInvitationToken(tokenFor(mineEmail)));
      for (const row of rows) expect(Object.keys(row).sort()).toEqual(["createdAt", "email", "expiresAt", "id", "invitedByUserId", "role", "status"]);
      expect(r.json.limit).toBe(100);
    });

    it("paginates, and refuses a limit of 0, an offset past the cap and any other query parameter", async () => {
      expect(((await list(ownerA, "?limit=1")).json.data as unknown[]).length).toBe(1);
      for (const q of ["?limit=0", "?limit=101", "?offset=10001", "?offset=-1", "?status=pending", "?organizationId=" + orgB]) {
        const r = await list(ownerA, q);
        expect(r.status, q).toBe(400);
      }
    });

    it("revokes a pending invitation (audited once), repeats as a no-op, and a malformed or unknown id is refused", async () => {
      await justSignedIn(ownerA);
      const email = fresh("revoke");
      const id = ((await invite(ownerA, { email })).json.data as { id: string }).id;
      const r = await revoke(ownerA, id);
      expect(r.status).toBe(200);
      expect(r.json.data).toMatchObject({ id, status: "revoked" });
      expect((await stored(id)).revokedAt).not.toBeNull();
      const again = await revoke(ownerA, id);
      expect(again.status).toBe(200);
      expect(again.json.data).toMatchObject({ id, status: "revoked" });
      const rows = await auditFor("invitation.revoked", id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ organizationId: orgA, actorUserId: ownerA.userId, resourceType: "invitation", metadata: { role: "associate" } });
      expect((await revoke(ownerA, crypto.randomUUID())).status).toBe(404);
      expect((await revoke(ownerA, "not-a-uuid")).status).toBe(400);
    });

    it("an accepted invitation cannot be revoked or re-sent (409), and a revoked one cannot be re-sent", async () => {
      await justSignedIn(ownerA);
      const accepted = ((await invite(ownerA, { email: fresh("done") })).json.data as { id: string }).id;
      await h.owner.update(schema.invitations).set({ acceptedAt: new Date() }).where(eq(schema.invitations.id, accepted));
      expect((await revoke(ownerA, accepted)).status).toBe(409);
      expect((await resend(ownerA, accepted)).status).toBe(409);
      expect((await stored(accepted)).revokedAt).toBeNull();

      const revoked = ((await invite(ownerA, { email: fresh("gone") })).json.data as { id: string }).id;
      await revoke(ownerA, revoked);
      const r = await resend(ownerA, revoked);
      expect(r.status).toBe(409);
      expect(r.json.error?.code).toBe("conflict");
    });

    it("re-sending gives a new link and a fresh period, and the old link no longer matches any row", async () => {
      await justSignedIn(ownerA);
      const email = fresh("resend");
      const id = ((await invite(ownerA, { email })).json.data as { id: string }).id;
      const oldToken = tokenFor(email);
      await h.owner.update(schema.invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.invitations.id, id));
      expect(((await list(ownerA, "?limit=100")).json.data as { id: string; status: string }[]).find((x) => x.id === id)?.status).toBe("expired");

      const r = await resend(ownerA, id);
      expect(r.status).toBe(200);
      expect(r.json.data).toMatchObject({ id, email, status: "pending" });
      const newToken = tokenFor(email);
      expect(newToken).not.toBe(oldToken);
      const row = await stored(id);
      expect(row.tokenHash).toBe(hashInvitationToken(newToken));
      expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 7 * 86_400_000 - 120_000);
      expect(await h.owner.select().from(schema.invitations).where(eq(schema.invitations.tokenHash, hashInvitationToken(oldToken)))).toHaveLength(0);
      const rows = await auditFor("invitation.resent", id);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).not.toContain(newToken);
      expect(mailsTo(email)).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("another practice's invitations (cross-tenant)", () => {
    it("the owner of practice B cannot list, revoke or re-send practice A's invitations: the same 404 as an id that does not exist", async () => {
      await justSignedIn(ownerA);
      await justSignedIn(ownerB);
      const email = fresh("cross");
      const id = ((await invite(ownerA, { email })).json.data as { id: string }).id;
      const tokenBefore = tokenFor(email);
      const before = await stored(id);
      printed = [];

      const listed = await list(ownerB, "?limit=100");
      expect(listed.status).toBe(200);
      expect((listed.json.data as { id: string }[]).some((x) => x.id === id)).toBe(false);
      expect(listed.text).not.toContain(email);

      const foreign = [await revoke(ownerB, id), await resend(ownerB, id)];
      const missing = [await revoke(ownerB, crypto.randomUUID()), await resend(ownerB, crypto.randomUUID())];
      for (const r of [...foreign, ...missing]) {
        expect(r.status).toBe(404);
        expect(r.json.error?.code).toBe("not_found");
      }
      expect(foreign.map((r) => r.text)).toEqual(missing.map((r) => r.text));

      const after = await stored(id);
      expect(after.revokedAt).toBeNull();
      expect(after.tokenHash).toBe(before.tokenHash);
      expect(after.tokenHash).toBe(hashInvitationToken(tokenBefore));
      expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
      expect(printed).toHaveLength(0);
      // Nothing was audited in practice B for it.
      expect((await h.owner.select().from(schema.auditLog).where(eq(schema.auditLog.resourceId, id))).every((a) => a.organizationId === orgA)).toBe(true);
    });

    it("everything every caller received is free of the other practice's invitation addresses", async () => {
      const all = async (orgId: string) => (await h.owner.select().from(schema.invitations).where(eq(schema.invitations.organizationId, orgId))).map((r) => r.email);
      const bothA = await all(orgA);
      const bothB = await all(orgB);
      // An address both practices invited is in both lists on purpose; only the rest must stay apart.
      const mine = bothA.filter((e) => !bothB.includes(e));
      const theirs = bothB.filter((e) => !bothA.includes(e));
      expect(mine.length).toBeGreaterThan(0);
      expect(theirs.length).toBeGreaterThan(0);
      for (const seen of h.seen.filter((s) => s.orgId === orgA)) for (const email of theirs) expect(seen.text, `${seen.caller} saw ${email}`).not.toContain(email);
      for (const seen of h.seen.filter((s) => s.orgId === orgB)) for (const email of mine) expect(seen.text, `${seen.caller} saw ${email}`).not.toContain(email);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("accepting an invitation (public)", () => {
    // Every test uses a client address of its own: the accept limit is per address.
    const runOctet = Math.floor(Math.random() * 256);
    let ipCounter = 0;
    const nextIp = () => `198.51.${runOctet}.${(ipCounter++ % 250) + 1}`;
    const visitor = { label: "visitor", orgId: "none" };
    const minted: string[] = [];

    const accept = (body: unknown, o: { ip?: string; origin?: string | null; rawBody?: string } = {}) =>
      h.call(visitor, acceptRoute.POST, { method: "POST", path: "/api/invitations/accept", body, rawBody: o.rawBody, origin: o.origin, headers: { "x-forwarded-for": o.ip ?? nextIp() } });
    /** The whole answer, for comparing two of them: status, body and every header but the date. */
    const answer = (r: { status: number; text: string; headers: Headers }) => ({ status: r.status, text: r.text, headers: [...r.headers.entries()].filter(([k]) => k !== "date").sort() });
    const mint = async (email: string = fresh("invitee")) => {
      await justSignedIn(ownerF);
      const r = await invite(ownerF, { email });
      expect(r.status).toBe(201);
      const token = tokenFor(email);
      minted.push(token);
      return { id: (r.json.data as { id: string }).id, email, token };
    };
    const usersWith = (email: string) => h.owner.select().from(schema.users).where(eq(schema.users.email, email));
    const body = (token: string, extra: Record<string, unknown> = {}) => ({ token, name: "Synthetic Invitee", password: GOOD_PASSWORD, ...extra });

    it("creates an associate in the inviting practice, verified, with a credential, and NO session: the invitation is spent and every row is audited without the token, address or name", async () => {
      const { id, email, token } = await mint();
      const r = await accept(body(token, { name: "  Synthetic Invitee  " }), { ip: "203.0.113.77" });
      expect(r.status).toBe(201);
      expect(r.json).toEqual({ data: { status: "accepted" } });
      expect(r.headers.get("set-cookie")).toBeNull();
      expect(r.headers.get("cache-control")).toBe("private, no-store");
      expect(r.text).not.toContain(email);

      const [user] = await usersWith(email);
      expect(user).toMatchObject({ organizationId: orgF, role: "associate", emailVerified: true, twoFactorEnabled: false, deletedAt: null, displayName: "Synthetic Invitee" });
      const accounts = await h.owner.select().from(schema.authAccounts).where(eq(schema.authAccounts.userId, user.id));
      expect(accounts).toHaveLength(1);
      expect(accounts[0].providerId).toBe("credential");
      expect(accounts[0].password).toBeTruthy();
      expect(accounts[0].password).not.toContain(GOOD_PASSWORD);
      expect(await h.owner.select().from(schema.authSessions).where(eq(schema.authSessions.userId, user.id))).toHaveLength(0);
      expect((await stored(id)).acceptedAt).not.toBeNull();

      const accepted = await auditFor("invitation.accepted", id);
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({ organizationId: orgF, actorUserId: user.id, resourceType: "invitation", outcome: "success", metadata: { role: "associate", ip: "203.0.113.77" } });
      const created = await auditFor("user.created", user.id);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ organizationId: orgF, actorUserId: ownerF.userId, resourceType: "users", metadata: { method: "invitation", role: "associate" } });
      const text = JSON.stringify([accepted, created]);
      for (const secret of [token, hashInvitationToken(token), email, "Synthetic Invitee", GOOD_PASSWORD]) expect(text).not.toContain(secret);
    });

    it("the new person signs in through real Better Auth with the chosen password, is sent to authenticator setup (a password-only session is refused), and sees NO client until the owner assigns one", async () => {
      const { email, token } = await mint();
      expect((await accept(body(token))).status).toBe(201);
      const [user] = await usersWith(email);

      // The password step works (the hash is the one Better Auth verifies) and the wrong password does not.
      expect((await h.authCall("/sign-in/email", { body: { email, password: GOOD_PASSWORD + "x" } })).status).toBe(401);
      const first = await h.authCall("/sign-in/email", { body: { email, password: GOOD_PASSWORD } });
      expect(first.status).toBe(200);
      const passwordOnly = { label: "invitee-password-only", orgId: orgF, cookie: h.cookieFrom(first) };
      expect((await h.call(passwordOnly, meRoute.GET, { path: "/api/me" })).status).toBe(401);
      expect((await h.call(passwordOnly, clientsRoute.GET, { path: "/api/clients" })).status).toBe(401);

      // Finish the authenticator setup like everyone, then look at the clients.
      const person = await h.enroll({ label: "invitee", userId: user.id, orgId: orgF, email });
      expect((await h.call(person, meRoute.GET, { path: "/api/me" })).json).toEqual({ id: user.id, role: "associate" });
      const none = await h.call(person, clientsRoute.GET, { path: "/api/clients" });
      expect(none.status).toBe(200);
      expect(none.json.data).toEqual([]);
      const direct = await h.call(person, clientRoute.GET, { path: `/api/clients/${clientF}`, params: { id: clientF } });
      expect(direct.status).toBe(404);
      expect(none.text + direct.text).not.toContain("Synthetic Client F");

      // The existing rule: the owner's assignment is what lets an associate see it.
      const assigned = await h.call(ownerF, assignmentsRoute.POST, { method: "POST", path: "/api/admin/assignments", body: { clientId: clientF, userId: user.id } });
      expect(assigned.status).toBe(201);
      expect((await h.call(person, clientRoute.GET, { path: `/api/clients/${clientF}`, params: { id: clientF } })).status).toBe(200);
    });

    it("an unknown, used, revoked, expired, replaced or no-longer-available token all get the SAME answer, and no account is created for any of them", async () => {
      const used = await mint();
      expect((await accept(body(used.token))).status).toBe(201);
      const revoked = await mint();
      await revoke(ownerF, revoked.id);
      const expired = await mint();
      await h.owner.update(schema.invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.invitations.id, expired.id));
      const replaced = await mint();
      await justSignedIn(ownerF);
      await invite(ownerF, { email: replaced.email }); // a second link for the same address kills the first
      const taken = await mint();
      await h.owner.insert(schema.users).values({ organizationId: orgB, email: taken.email, displayName: "Synthetic Earlier", role: "associate", emailVerified: true });
      const unknownToken = (await import("./invitation-token")).newInvitationToken().token;

      const cases: [string, string][] = [["unknown", unknownToken], ["used", used.token], ["revoked", revoked.token], ["expired", expired.token], ["replaced", replaced.token], ["address taken", taken.token]];
      const answers = [];
      for (const [label, token] of cases) {
        const r = await accept(body(token));
        expect(r.status, label).toBe(400);
        expect(r.json.error?.code, label).toBe("invalid_invitation");
        answers.push(answer(r));
      }
      for (const a of answers) expect(a).toEqual(answers[0]);

      expect(await usersWith(revoked.email)).toHaveLength(0);
      expect(await usersWith(expired.email)).toHaveLength(0);
      expect(await usersWith(replaced.email)).toHaveLength(0);
      const stillTaken = await usersWith(taken.email);
      expect(stillTaken).toHaveLength(1);
      expect(stillTaken[0].organizationId).toBe(orgB);
      for (const inv of [revoked, expired, taken]) expect((await stored(inv.id)).acceptedAt).toBeNull();

      // Each KNOWN link that could not be used left one audit row in the inviting practice, with a closed reason.
      const reasonOf = async (id: string) => (await auditFor("invitation.accept_refused", id)).map((a) => a.metadata);
      expect(await reasonOf(used.id)).toEqual([{ reason: "used", ip: expect.any(String) }]);
      expect(await reasonOf(revoked.id)).toEqual([{ reason: "revoked", ip: expect.any(String) }]);
      expect(await reasonOf(expired.id)).toEqual([{ reason: "expired", ip: expect.any(String) }]);
      expect(await reasonOf(taken.id)).toEqual([{ reason: "address_in_use", ip: expect.any(String) }]);
      // The made-up token has no practice: an application log line with the address, never the token.
      expect(logged.some((l) => l.includes("invitation.accept_unknown_token"))).toBe(true);
      expect(logged.join("\n")).not.toContain(unknownToken);
      // Practice B sees none of it.
      expect((await h.owner.select().from(schema.auditLog).where(and(eq(schema.auditLog.organizationId, orgB), eq(schema.auditLog.action, "invitation.accept_refused")))).length).toBe(0);
    });

    it("simultaneous accepts of one link create exactly one user and one credential", async () => {
      const { id, email, token } = await mint();
      const replies = await Promise.all(Array.from({ length: 4 }, () => accept(body(token))));
      expect(replies.map((r) => r.status).sort()).toEqual([201, 400, 400, 400]);
      for (const r of replies.filter((x) => x.status === 400)) expect(r.json.error?.code).toBe("invalid_invitation");
      const users = await usersWith(email);
      expect(users).toHaveLength(1);
      expect(await h.owner.select().from(schema.authAccounts).where(eq(schema.authAccounts.userId, users[0].id))).toHaveLength(1);
      expect(await auditFor("invitation.accepted", id)).toHaveLength(1);
      expect(await auditFor("user.created", users[0].id)).toHaveLength(1);
      // The losers waited for the row lock and then found the invitation used (not "address in use", which
      // is what an unlocked race would have fallen back to).
      const refused = await auditFor("invitation.accept_refused", id);
      expect(refused.map((a) => (a.metadata as { reason: string }).reason)).toEqual(["used", "used", "used"]);
    });

    it("the function takes the invitation's row lock: while another transaction holds it, an accept waits, then finds the state that transaction left", async () => {
      const { id, email, token } = await mint();
      const hash = hashInvitationToken(token);
      let settled = false;
      let pending: Promise<string> | undefined;
      await h.owner.transaction(async (tx) => {
        await tx.execute(sql`select 1 from invitations where id = ${id} for update`);
        pending = h.asRole("auth", "select accept_invitation($1, 'Synthetic Waiter', $2) as r", [hash, "x".repeat(40)]).then((r) => {
          settled = true;
          return r.rows[0].r as string;
        });
        await new Promise((resolve) => setTimeout(resolve, 2500));
        expect(settled, "the accept must wait for the lock").toBe(false);
        // While holding the lock, revoke it: the waiting accept must see that, not the state it started with.
        await tx.execute(sql`update invitations set revoked_at = now() where id = ${id}`);
      });
      expect(await pending).toBe("refused");
      expect(await usersWith(email)).toHaveLength(0);
      expect((await auditFor("invitation.accept_refused", id)).map((a) => (a.metadata as { reason: string }).reason)).toEqual(["revoked"]);
    });

    it("six simultaneous calls of the database function (no password hashing to space them out) still make exactly one user: the row lock makes the rest find it used", async () => {
      const { id, email, token } = await mint();
      const hash = hashInvitationToken(token);
      const results = await Promise.all(Array.from({ length: 6 }, () => h.asRole("auth", "select accept_invitation($1, 'Synthetic Racer', $2) as r", [hash, "x".repeat(40)])));
      expect(results.map((r) => r.rows[0].r).sort()).toEqual(["accepted", "refused", "refused", "refused", "refused", "refused"]);
      const users = await usersWith(email);
      expect(users).toHaveLength(1);
      expect(await h.owner.select().from(schema.authAccounts).where(eq(schema.authAccounts.userId, users[0].id))).toHaveLength(1);
      const refused = await auditFor("invitation.accept_refused", id);
      expect(refused.map((a) => (a.metadata as { reason: string }).reason)).toEqual(Array(5).fill("used"));
      expect(await auditFor("invitation.accepted", id)).toHaveLength(1);
    });

    it("two invitations for one address from two practices at once still make one user", async () => {
      await justSignedIn(ownerB);
      const email = fresh("race");
      const fromF = await mint(email);
      await invite(ownerB, { email });
      const tokenB = tokenFor(email);
      minted.push(tokenB);
      const replies = await Promise.all([accept(body(fromF.token)), accept(body(tokenB))]);
      expect(replies.map((r) => r.status).sort()).toEqual([201, 400]);
      expect(await usersWith(email)).toHaveLength(1);
    });

    it("a weak password, a bad name or a role in the body is a 400 that does not spend the invitation, and the link still works afterwards", async () => {
      const { id, email, token } = await mint();
      for (const [label, payload] of [
        ["11 characters", body(token, { password: "elevenchars" })],
        ["129 characters", body(token, { password: "p".repeat(129) })],
        ["role admin", body(token, { role: "admin" })],
        ["role owner", body(token, { role: "owner" })],
        ["organization", body(token, { organizationId: orgB })],
        ["empty name", body(token, { name: "  " })],
        ["control character in the name", body(token, { name: "A\u0007B" })],
      ] as const) {
        const r = await accept(payload);
        expect(r.status, label).toBe(400);
        expect(r.json.error?.code, label).toBe("validation_failed");
      }
      expect(await usersWith(email)).toHaveLength(0);
      expect((await stored(id)).acceptedAt).toBeNull();
      expect((await accept(body(token))).status).toBe(201);
      // Whatever was sent, the new person is an associate of the inviting practice.
      expect((await usersWith(email))[0]).toMatchObject({ role: "associate", organizationId: orgF });
    });

    it("a request from another origin, or with none, is refused (403) and the invitation is untouched", async () => {
      const { id, email, token } = await mint();
      expect((await accept(body(token), { origin: "https://evil.example" })).status).toBe(403);
      expect((await accept(body(token), { origin: null })).status).toBe(403);
      expect(await usersWith(email)).toHaveLength(0);
      expect((await stored(id)).acceptedAt).toBeNull();
    });

    it("limits requests per client address (every request counts, an IPv6 address by its /64), and another address is unaffected", async () => {
      const a = Math.floor(Math.random() * 65_536).toString(16);
      const b = Math.floor(Math.random() * 65_536).toString(16);
      const first = `2001:db8:${a}:${b}::1`;
      const sameSubnet = `2001:db8:${a}:${b}:aaaa::2`;
      for (let i = 0; i < 10; i++) expect((await accept({}, { ip: first })).status, `request ${i + 1}`).toBe(400);
      const blocked = await accept({}, { ip: sameSubnet });
      expect(blocked.status).toBe(429);
      expect(blocked.json.error?.code).toBe("rate_limited");
      const wait = Number(blocked.headers.get("retry-after"));
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(900);
      // Even a valid link is refused while the address is limited, and stays unspent.
      const { id, token } = await mint();
      expect((await accept(body(token), { ip: first })).status).toBe(429);
      expect((await stored(id)).acceptedAt).toBeNull();
      expect((await accept(body(token), { ip: nextIp() })).status).toBe(201);
    });

    it("the database door: auth_runtime cannot insert a user itself, app_runtime cannot even call accept_invitation, and a bad name or credential is refused", async () => {
      const code = async (run: Promise<unknown>) => {
        try {
          await run;
        } catch (e) {
          return (e as { code?: string }).code;
        }
        return "no error";
      };
      const longHash = "x".repeat(30);
      expect(await code(h.asRole("auth", "insert into users (organization_id, email, display_name, role) values ($1, $2, 'x', 'associate')", [orgF, fresh("direct")]))).toBe("42501");
      expect((await h.asRole("auth", "select accept_invitation($1, 'Synthetic', $2) as r", ["0".repeat(64), longHash])).rows[0].r).toBe("unknown");
      expect((await h.asRole("auth", "select accept_invitation($1, 'Synthetic', $2) as r", ["not-hex", longHash])).rows[0].r).toBe("unknown");
      expect(await code(h.asRole("auth", "select accept_invitation($1, '', $2)", ["0".repeat(64), longHash]))).toBe("22023");
      expect(await code(h.asRole("auth", "select accept_invitation($1, 'Synthetic', 'short')", ["0".repeat(64)]))).toBe("22023");
      expect(await code(h.asRole("app", "select accept_invitation($1, 'Synthetic', $2)", ["0".repeat(64), longHash]))).toBe("42501");
      expect(await code(h.asRole("auth", "select count(*) from invitations"))).toBe("42501");
    });

    it("nothing the invitation flow wrote or logged contains any token it handed out", async () => {
      expect(minted.length).toBeGreaterThan(5);
      const rows = await h.owner.execute(sql`select metadata::text as m, resource_id::text as r from audit_log where organization_id in (${orgA}, ${orgB}, ${orgC}, ${orgD}, ${orgE}, ${orgF})`);
      const everything = JSON.stringify(rows.rows) + logged.join("\n") + h.seen.map((s) => s.text).join("\n");
      for (const token of minted) {
        expect(everything).not.toContain(token);
        expect(everything).not.toContain(hashInvitationToken(token));
      }
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("the per-practice limit on creating and re-sending", () => {
    const seedRows = async (n: number, action: string) => {
      for (let i = 0; i < n; i++) {
        await h.owner.insert(schema.auditLog).values({ organizationId: orgC, actorUserId: ownerC.userId, action, resourceType: "invitation", resourceId: crypto.randomUUID(), metadata: { role: "associate" } });
      }
    };

    it("the 21st creation, re-send or refused attempt in an hour is a 429 with Retry-After and creates nothing; another practice is unaffected", async () => {
      await justSignedIn(ownerC);
      // 17 earlier created, re-sent and refused rows count together toward 20 (refused counts too: scanning is throttled).
      await seedRows(10, "invitation.created");
      await seedRows(4, "invitation.resent");
      await seedRows(3, "invitation.refused");

      const first = fresh("limit-1");
      const r18 = await invite(ownerC, { email: first });
      const r19 = await invite(ownerC, { email: assocB.email }); // refused, counts as the 19th
      const second = fresh("limit-3");
      const r20 = await invite(ownerC, { email: second });
      expect([r18.status, r19.status, r20.status]).toEqual([201, 201, 201]);

      const blockedEmail = fresh("limit-blocked");
      const blocked = await invite(ownerC, { email: blockedEmail });
      expect(blocked.status).toBe(429);
      expect(blocked.json.error?.code).toBe("rate_limited");
      const wait = Number(blocked.headers.get("retry-after"));
      expect(Number.isInteger(wait)).toBe(true);
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(3600);
      expect(mailsTo(blockedEmail)).toHaveLength(0);
      expect(await h.owner.select().from(schema.invitations).where(eq(schema.invitations.email, blockedEmail))).toHaveLength(0);

      // A re-send is refused too, and so is a refused-address attempt.
      const id = ((await list(ownerC, "?limit=1")).json.data as { id: string }[])[0].id;
      expect((await resend(ownerC, id)).status).toBe(429);
      expect((await invite(ownerC, { email: assocB.email })).status).toBe(429);
      // Revoking is not limited.
      expect((await revoke(ownerC, id)).status).toBe(200);

      // Practice A has its own count.
      await justSignedIn(ownerA);
      expect((await invite(ownerA, { email: fresh("limit-other") })).status).toBe(201);
    });
  });
});
