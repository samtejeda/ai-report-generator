import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { BASE, ENABLED, startHarness, type Handler, type Person } from "./integration-harness";

// Client create / edit / soft-delete (feat/clients-crud) end to end: the REAL route modules, the
// REAL Better Auth sessions, the REAL app_runtime / auth_runtime roles with row-level security, on
// the scratch database. Nothing is mocked. Synthetic data only: every name below is invented.
//
// Needs the TEST_* variables (see lib/auth/integration-harness.ts); skipped when absent.
vi.setConfig({ testTimeout: 120_000 });

describe.skipIf(!ENABLED)("client writes through the real stack", () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let collection: { GET: Handler; POST: Handler };
  let item: { GET: Handler; PATCH: Handler; DELETE: Handler };

  let orgA: string;
  let orgB: string;
  let ownerA: Person, assocA: Person, assocA2: Person, adminA: Person;
  let ownerB: Person, assocB: Person;

  const KEYS = ["createdAt", "dateOfBirth", "displayName", "externalId", "gradeLevel", "id"];
  const tag = () => crypto.randomUUID().slice(0, 8);

  const post = (who: Person, body: unknown, o: { origin?: string | null; headers?: Record<string, string>; rawBody?: string } = {}) =>
    h.call(who, collection.POST, { method: "POST", path: "/api/clients", body, ...o });
  const patch = (who: Person, id: string, body: unknown, o: { origin?: string | null; rawBody?: string } = {}) =>
    h.call(who, item.PATCH, { method: "PATCH", path: `/api/clients/${id}`, body, params: { id }, ...o });
  const del = (who: Person, id: string, o: { origin?: string | null } = {}) =>
    h.call(who, item.DELETE, { method: "DELETE", path: `/api/clients/${id}`, params: { id }, ...o });
  const get = (who: Person, id: string) => h.call(who, item.GET, { path: `/api/clients/${id}`, params: { id } });
  const list = (who: Person) => h.call(who, collection.GET, { path: "/api/clients?limit=100" });

  const seedClient = async (orgId: string, displayName: string, extra: Partial<typeof schema.clients.$inferInsert> = {}) => {
    const [row] = await h.owner.insert(schema.clients).values({ organizationId: orgId, displayName, ...extra }).returning();
    return row;
  };
  const assign = async (clientId: string, user: Person, by: Person) => {
    const [row] = await h.owner.insert(schema.clientAssignments).values({ organizationId: user.orgId, clientId, userId: user.userId, assignedByUserId: by.userId }).returning();
    return row;
  };
  const clientRow = async (id: string) => (await h.owner.select().from(schema.clients).where(eq(schema.clients.id, id)))[0];
  const clientCount = async (orgId: string) => (await h.owner.select().from(schema.clients).where(eq(schema.clients.organizationId, orgId))).length;
  const auditRows = (orgId: string, action: string) =>
    h.owner.select().from(schema.auditLog).where(and(eq(schema.auditLog.organizationId, orgId), eq(schema.auditLog.action, action)));

  beforeAll(async () => {
    h = await startHarness({ appRole: "app_runtime_clients", authRole: "auth_runtime_clients", secret: "clients-test-secret-".padEnd(48, "x") });
    collection = (await import("@/app/api/clients/route")) as unknown as typeof collection;
    item = (await import("@/app/api/clients/[id]/route")) as unknown as typeof item;
    orgA = await h.seedOrg("clients-A");
    orgB = await h.seedOrg("clients-B");
    [ownerA, assocA, assocA2, adminA, ownerB, assocB] = await Promise.all([
      h.makePerson(orgA, "owner-a", "owner"),
      h.makePerson(orgA, "assoc-a", "associate"),
      h.makePerson(orgA, "assoc-a2", "associate"),
      h.makePerson(orgA, "admin-a", "admin"),
      h.makePerson(orgB, "owner-b", "owner"),
      h.makePerson(orgB, "assoc-b", "associate"),
    ]);
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
  });

  // ---------------------------------------------------------------------------------------
  describe("who may call", () => {
    it("no session is 401 on all three methods, and nothing is created", async () => {
      const nobody = { label: "nobody", orgId: "none" };
      const before = await clientCount(orgA);
      const c = await seedClient(orgA, `Anon Probe ${tag()}`);
      expect((await h.call(nobody, collection.POST, { method: "POST", path: "/api/clients", body: { displayName: "x" } })).status).toBe(401);
      expect((await h.call(nobody, item.PATCH, { method: "PATCH", path: `/api/clients/${c.id}`, body: { gradeLevel: "3" }, params: { id: c.id } })).status).toBe(401);
      expect((await h.call(nobody, item.DELETE, { method: "DELETE", path: `/api/clients/${c.id}`, params: { id: c.id } })).status).toBe(401);
      expect(await clientCount(orgA)).toBe(before + 1);
      expect((await clientRow(c.id)).deletedAt).toBeNull();
      expect((await clientRow(c.id)).gradeLevel).toBeNull();
    });

    it("an admin cannot create, edit or delete, even a granted client: 403, audited, nothing changes", async () => {
      const granted = await seedClient(orgA, `Granted ${tag()}`, { gradeLevel: "2" });
      await assign(granted.id, adminA, ownerA);
      const before = await clientCount(orgA);
      const denied0 = (await auditRows(orgA, "authz.denied")).filter((r) => r.actorUserId === adminA.userId).length;

      const results = [
        await post(adminA, { displayName: "Admin Created" }),
        await patch(adminA, granted.id, { gradeLevel: "9" }),
        await del(adminA, granted.id),
      ];
      for (const r of results) {
        expect(r.status).toBe(403);
        expect(r.json.error?.code).toBe("forbidden");
      }
      expect(await clientCount(orgA)).toBe(before);
      const after = await clientRow(granted.id);
      expect(after.gradeLevel).toBe("2");
      expect(after.deletedAt).toBeNull();
      const denied = (await auditRows(orgA, "authz.denied")).filter((r) => r.actorUserId === adminA.userId);
      expect(denied.length - denied0).toBe(3);
      expect(denied.every((r) => r.outcome === "denied" && r.resourceType === "client")).toBe(true);
    });

    it("an associate cannot delete, even an assigned client", async () => {
      const c = await seedClient(orgA, `Assoc Delete ${tag()}`);
      await assign(c.id, assocA, ownerA);
      const r = await del(assocA, c.id);
      expect(r.status).toBe(403);
      expect((await clientRow(c.id)).deletedAt).toBeNull();
      expect((await get(assocA, c.id)).status).toBe(200);
    });

    it("no CORS headers on the write routes, even to a cross-site Origin", async () => {
      const r = await post(ownerA, { displayName: `Cors ${tag()}` }, { origin: "https://evil.example" });
      expect(r.status).toBe(403);
      for (const name of r.headers.keys()) expect(name.toLowerCase()).not.toMatch(/^access-control-/);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("create", () => {
    it("the owner creates a client: 201, allow-listed fields, stored in the owner's practice, no assignment, audited with ids only", async () => {
      const name = `Owner Made ${tag()}`;
      const r = await post(ownerA, { displayName: name, dateOfBirth: "2016-05-17", gradeLevel: "3", externalId: `EXT-${tag()}` });
      expect(r.status).toBe(201);
      expect(r.headers.get("cache-control")).toBe("private, no-store");
      const data = r.json.data as Record<string, unknown>;
      expect(Object.keys(data).sort()).toEqual(KEYS);
      expect(data.displayName).toBe(name);
      const row = await clientRow(data.id as string);
      expect(row).toMatchObject({ organizationId: orgA, displayName: name, dateOfBirth: "2016-05-17", gradeLevel: "3", deletedAt: null });
      expect(await h.owner.select().from(schema.clientAssignments).where(eq(schema.clientAssignments.clientId, row.id))).toHaveLength(0);

      const rows = (await auditRows(orgA, "client.created")).filter((a) => a.resourceId === row.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorUserId: ownerA.userId, resourceType: "client", outcome: "success", metadata: { role: "owner" } });
      expect(JSON.stringify(rows[0])).not.toContain(name);
    });

    it("optional fields may be left out", async () => {
      const r = await post(ownerA, { displayName: `Bare ${tag()}` });
      expect(r.status).toBe(201);
      expect(r.json.data).toMatchObject({ dateOfBirth: null, gradeLevel: null, externalId: null });
    });

    it("an associate creates a client and is assigned to it at once; nobody else gains access", async () => {
      const name = `Assoc Made ${tag()}`;
      const r = await post(assocA, { displayName: name, gradeLevel: "K" });
      expect(r.status).toBe(201);
      const id = (r.json.data as { id: string }).id;

      const assignments = await h.owner.select().from(schema.clientAssignments).where(eq(schema.clientAssignments.clientId, id));
      expect(assignments).toHaveLength(1);
      expect(assignments[0]).toMatchObject({ organizationId: orgA, userId: assocA.userId, assignedByUserId: assocA.userId, deletedAt: null });

      expect((await get(assocA, id)).status).toBe(200);
      expect(((await list(assocA)).json.data as { id: string }[]).some((c) => c.id === id)).toBe(true);
      expect((await get(assocA2, id)).status).toBe(404);
      expect((await get(adminA, id)).status).toBe(404);
      expect((await get(ownerA, id)).status).toBe(200);

      const created = (await auditRows(orgA, "client.created")).filter((a) => a.resourceId === id);
      expect(created).toHaveLength(1);
      expect(created[0].metadata).toEqual({ role: "associate" });
      const auto = (await auditRows(orgA, "assignment.created")).filter((a) => a.resourceId === assignments[0].id);
      expect(auto).toHaveLength(1);
      expect(auto[0]).toMatchObject({ actorUserId: assocA.userId, metadata: { role: "associate", method: "auto_on_create" } });
      expect(JSON.stringify([...created, ...auto])).not.toContain(name);
    });

    it("an associate of practice B creates into practice B only, is assigned there, and cannot reach practice A's clients", async () => {
      const aClient = await seedClient(orgA, `A Only ${tag()}`);
      const r = await post(assocB, { displayName: `B Assoc ${tag()}` });
      expect(r.status).toBe(201);
      const row = await clientRow((r.json.data as { id: string }).id);
      expect(row.organizationId).toBe(orgB);
      const assignments = await h.owner.select().from(schema.clientAssignments).where(eq(schema.clientAssignments.clientId, row.id));
      expect(assignments.map((a) => [a.organizationId, a.userId])).toEqual([[orgB, assocB.userId]]);
      expect((await get(assocB, aClient.id)).status).toBe(404);
      expect((await patch(assocB, aClient.id, { gradeLevel: "9" })).status).toBe(404);
    });

    it("the practice comes from the session: a body organizationId is a 400, a spoofed header or query is ignored", async () => {
      const before = await clientCount(orgB);
      const body = await post(ownerA, { displayName: `Spoof ${tag()}`, organizationId: orgB });
      expect(body.status).toBe(400);
      const viaHeader = await post(ownerA, { displayName: `Spoof2 ${tag()}` }, { headers: { "x-organization-id": orgB } });
      expect(viaHeader.status).toBe(201);
      expect((await clientRow((viaHeader.json.data as { id: string }).id)).organizationId).toBe(orgA);
      expect(await clientCount(orgB)).toBe(before);
    });

    it("a duplicate external id is a 409 that does not echo it, and leaves one row", async () => {
      const ext = `DUP-${tag()}`;
      expect((await post(ownerA, { displayName: `First ${tag()}`, externalId: ext })).status).toBe(201);
      const r = await post(assocA, { displayName: `Second ${tag()}`, externalId: ext });
      expect(r.status).toBe(409);
      expect(r.json.error?.code).toBe("conflict");
      expect(r.text).not.toContain(ext);
      expect(await h.owner.select().from(schema.clients).where(and(eq(schema.clients.organizationId, orgA), eq(schema.clients.externalId, ext)))).toHaveLength(1);
    });

    it("the same external id in another practice is fine (uniqueness is per practice)", async () => {
      const ext = `PER-${tag()}`;
      expect((await post(ownerA, { displayName: `A ${tag()}`, externalId: ext })).status).toBe(201);
      expect((await post(ownerB, { displayName: `B ${tag()}`, externalId: ext })).status).toBe(201);
    });

    it("a failed create (duplicate external id) leaves no orphan assignment for the associate", async () => {
      const ext = `ORPH-${tag()}`;
      await post(ownerA, { displayName: `Holder ${tag()}`, externalId: ext });
      const before = (await h.owner.select().from(schema.clientAssignments).where(eq(schema.clientAssignments.userId, assocA.userId))).length;
      expect((await post(assocA, { displayName: `Loser ${tag()}`, externalId: ext })).status).toBe(409);
      expect((await h.owner.select().from(schema.clientAssignments).where(eq(schema.clientAssignments.userId, assocA.userId))).length).toBe(before);
    });

    const secret = "SecretNameZ9";
    it.each([
      ["no body", undefined],
      ["not json", "{nope"],
      ["json null", "null"],
      ["array", "[]"],
      ["missing name", { gradeLevel: "3" }],
      ["empty name", { displayName: "  " }],
      ["name too long", { displayName: secret + "x".repeat(300) }],
      ["control character", { displayName: `${secret}\u0000` }],
      ["name not a string", { displayName: 7 }],
      ["impossible date", { displayName: secret, dateOfBirth: "2015-02-30" }],
      ["future date", { displayName: secret, dateOfBirth: "2999-01-01" }],
      ["grade with punctuation", { displayName: secret, gradeLevel: "3; drop table" }],
      ["external id too long", { displayName: secret, externalId: "e".repeat(65) }],
      ["unknown key (address)", { displayName: secret, address: "1 Main St" }],
      ["id", { displayName: secret, id: crypto.randomUUID() }],
      ["deletedAt", { displayName: secret, deletedAt: null }],
      ["createdAt", { displayName: secret, createdAt: "2000-01-01" }],
    ])("rejects %s with a 400 that echoes nothing", async (_label, body) => {
      const before = await clientCount(orgA);
      const r = typeof body === "string" ? await post(ownerA, undefined, { rawBody: body }) : body === undefined ? await post(ownerA, undefined, { rawBody: "" }) : await post(ownerA, body);
      expect(r.status).toBe(400);
      expect(r.json.error?.code).toBe("validation_failed");
      expect(r.text).not.toContain(secret);
      expect(await clientCount(orgA)).toBe(before);
    });

    it("an oversize body is a 400", async () => {
      const r = await post(ownerA, undefined, { rawBody: JSON.stringify({ displayName: "x".repeat(5000) }) });
      expect(r.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("edit", () => {
    it("the owner edits any client in the practice; the audit row names the columns, not the values", async () => {
      const c = await seedClient(orgA, `Before ${tag()}`, { gradeLevel: "1", dateOfBirth: "2018-01-01" });
      await assign(c.id, assocA, ownerA);
      const newName = `After ${tag()}`;
      const r = await patch(ownerA, c.id, { displayName: newName, gradeLevel: "2" });
      expect(r.status).toBe(200);
      expect(Object.keys(r.json.data as object).sort()).toEqual(KEYS);
      expect(r.json.data).toMatchObject({ id: c.id, displayName: newName, gradeLevel: "2", dateOfBirth: "2018-01-01" });
      const row = await clientRow(c.id);
      expect(row).toMatchObject({ displayName: newName, gradeLevel: "2", organizationId: orgA });

      const rows = (await auditRows(orgA, "client.updated")).filter((a) => a.resourceId === c.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual({ role: "owner", fields: "display_name,grade_level" });
      expect(JSON.stringify(rows[0])).not.toContain(newName);
    });

    it("null clears an optional field", async () => {
      const c = await seedClient(orgA, `Clear ${tag()}`, { gradeLevel: "5", externalId: `CLR-${tag()}` });
      const r = await patch(ownerA, c.id, { gradeLevel: null, externalId: null });
      expect(r.status).toBe(200);
      expect(r.json.data).toMatchObject({ gradeLevel: null, externalId: null });
    });

    it("an associate edits a client assigned to them", async () => {
      const c = await seedClient(orgA, `Assigned ${tag()}`);
      await assign(c.id, assocA, ownerA);
      const r = await patch(assocA, c.id, { gradeLevel: "7" });
      expect(r.status).toBe(200);
      expect((await clientRow(c.id)).gradeLevel).toBe("7");
      const rows = (await auditRows(orgA, "client.updated")).filter((a) => a.resourceId === c.id);
      expect(rows[0].metadata).toEqual({ role: "associate", fields: "grade_level" });
    });

    it("an associate gets the identical 404 for an unassigned client, an ended assignment, a deleted client, another practice's client and a made-up id; nothing changes", async () => {
      const unassigned = await seedClient(orgA, `Unassigned ${tag()}`, { gradeLevel: "1" });
      await assign(unassigned.id, assocA2, ownerA); // someone else's
      const ended = await seedClient(orgA, `Ended ${tag()}`, { gradeLevel: "1" });
      const endedRow = await assign(ended.id, assocA, ownerA);
      await h.owner.update(schema.clientAssignments).set({ deletedAt: new Date() }).where(eq(schema.clientAssignments.id, endedRow.id));
      const deleted = await seedClient(orgA, `Deleted ${tag()}`, { gradeLevel: "1", deletedAt: new Date() });
      await assign(deleted.id, assocA, ownerA);
      const foreign = await seedClient(orgB, `Foreign ${tag()}`, { gradeLevel: "1" });

      const answers: string[] = [];
      for (const id of [unassigned.id, ended.id, deleted.id, foreign.id, crypto.randomUUID()]) {
        const r = await patch(assocA, id, { gradeLevel: "12" });
        expect(r.status, id).toBe(404);
        answers.push(r.text);
      }
      expect(new Set(answers).size).toBe(1);
      for (const c of [unassigned, ended, deleted, foreign]) expect((await clientRow(c.id)).gradeLevel).toBe("1");
    });

    it("practice B's owner cannot edit practice A's client (the same 404 as a made-up id), and A's owner cannot edit B's", async () => {
      const a = await seedClient(orgA, `Mine A ${tag()}`, { gradeLevel: "1" });
      const b = await seedClient(orgB, `Mine B ${tag()}`, { gradeLevel: "1" });
      const madeUp = await patch(ownerB, crypto.randomUUID(), { gradeLevel: "9" });
      const cross = await patch(ownerB, a.id, { gradeLevel: "9" });
      expect(cross.status).toBe(404);
      expect(cross.text).toBe(madeUp.text);
      expect((await patch(ownerA, b.id, { gradeLevel: "9" })).status).toBe(404);
      expect((await clientRow(a.id)).gradeLevel).toBe("1");
      expect((await clientRow(b.id)).gradeLevel).toBe("1");
    });

    it("a duplicate external id on edit is a 409 that does not echo it", async () => {
      const ext = `TAKEN-${tag()}`;
      await seedClient(orgA, `Holder ${tag()}`, { externalId: ext });
      const c = await seedClient(orgA, `Other ${tag()}`);
      const r = await patch(ownerA, c.id, { externalId: ext });
      expect(r.status).toBe(409);
      expect(r.text).not.toContain(ext);
      expect((await clientRow(c.id)).externalId).toBeNull();
    });

    it.each([
      ["empty object", {}],
      ["null name", { displayName: null }],
      ["unknown key", { nickname: "x" }],
      ["organizationId", { organizationId: crypto.randomUUID() }],
      ["id", { id: crypto.randomUUID() }],
      ["deletedAt (an edit cannot delete or restore)", { deletedAt: null }],
      ["bad date", { dateOfBirth: "2999-01-01" }],
      ["empty name", { displayName: "" }],
    ])("rejects %s with a 400", async (_label, body) => {
      const c = await seedClient(orgA, `Valid ${tag()}`, { gradeLevel: "1" });
      const r = await patch(ownerA, c.id, body);
      expect(r.status).toBe(400);
      expect(r.json.error?.code).toBe("validation_failed");
      expect((await clientRow(c.id)).gradeLevel).toBe("1");
    });

    it("a malformed id is a 400 and a non-JSON body is a 400", async () => {
      expect((await patch(ownerA, "not-a-uuid", { gradeLevel: "3" })).status).toBe(400);
      const c = await seedClient(orgA, `Json ${tag()}`);
      expect((await patch(ownerA, c.id, undefined, { rawBody: "{nope" })).status).toBe(400);
    });

    it("an edit cannot move a client to another practice or change who may see it", async () => {
      const c = await seedClient(orgA, `Pinned ${tag()}`);
      await patch(ownerA, c.id, { gradeLevel: "4" });
      const row = await clientRow(c.id);
      expect(row.organizationId).toBe(orgA);
      expect(await h.owner.select().from(schema.clientAssignments).where(eq(schema.clientAssignments.clientId, c.id))).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("soft delete", () => {
    it("the owner deletes: the row is kept with a deletion time, everyone loses it, the audit row exists", async () => {
      const c = await seedClient(orgA, `Doomed ${tag()}`, { externalId: `GONE-${tag()}` });
      await assign(c.id, assocA, ownerA);
      await h.owner.insert(schema.clientAssignments).values({ organizationId: orgA, clientId: c.id, userId: adminA.userId, assignedByUserId: ownerA.userId });
      expect((await get(assocA, c.id)).status).toBe(200);

      const r = await del(ownerA, c.id);
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ data: { id: c.id, deleted: true } });
      expect(r.headers.get("cache-control")).toBe("private, no-store");

      const row = await clientRow(c.id);
      expect(row).toBeTruthy();
      expect(row.deletedAt).not.toBeNull();
      for (const who of [ownerA, assocA, adminA]) {
        expect((await get(who, c.id)).status, who.label).toBe(404);
        expect(((await list(who)).json.data as { id: string }[]).some((x) => x.id === c.id), who.label).toBe(false);
      }
      const rows = (await auditRows(orgA, "client.deleted")).filter((a) => a.resourceId === c.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorUserId: ownerA.userId, resourceType: "client", outcome: "success", metadata: { role: "owner" } });
    });

    it("deleting twice, or a made-up id, is the same 404; an edit cannot bring a deleted client back", async () => {
      const c = await seedClient(orgA, `Twice ${tag()}`);
      expect((await del(ownerA, c.id)).status).toBe(200);
      const second = await del(ownerA, c.id);
      const madeUp = await del(ownerA, crypto.randomUUID());
      expect(second.status).toBe(404);
      expect(second.text).toBe(madeUp.text);
      expect((await patch(ownerA, c.id, { gradeLevel: "1" })).status).toBe(404);
      expect((await clientRow(c.id)).deletedAt).not.toBeNull();
      expect((await auditRows(orgA, "client.deleted")).filter((a) => a.resourceId === c.id)).toHaveLength(1);
    });

    it("practice B's owner cannot delete practice A's client", async () => {
      const a = await seedClient(orgA, `Safe ${tag()}`);
      const r = await del(ownerB, a.id);
      expect(r.status).toBe(404);
      expect((await clientRow(a.id)).deletedAt).toBeNull();
      expect((await auditRows(orgA, "client.deleted")).filter((x) => x.resourceId === a.id)).toHaveLength(0);
    });

    it("a malformed id is a 400", async () => {
      expect((await del(ownerA, "nope")).status).toBe(400);
    });

    it("a deleted client's external id can be used again", async () => {
      const ext = `REUSE-${tag()}`;
      const c = await seedClient(orgA, `Old ${tag()}`, { externalId: ext });
      expect((await del(ownerA, c.id)).status).toBe(200);
      expect((await post(ownerA, { displayName: `New ${tag()}`, externalId: ext })).status).toBe(201);
    });

    it("the delete and its audit row are one transaction: if the audit row cannot be written, the client is not deleted", async () => {
      const c = await seedClient(orgA, `Atomic ${tag()}`);
      const fn = `fail_audit_${tag()}`.replace(/-/g, "_");
      await h.owner.execute(sql.raw(`create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'audit refused'; end $$`));
      await h.owner.execute(sql.raw(`create trigger ${fn} before insert on audit_log for each row when (new.action = 'client.deleted' and new.resource_id = '${c.id}') execute function ${fn}()`));
      try {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        const r = await del(ownerA, c.id);
        spy.mockRestore();
        expect(r.status).toBe(500);
        expect(r.json.error?.code).toBe("internal_error");
        expect((await clientRow(c.id)).deletedAt).toBeNull();
      } finally {
        await h.owner.execute(sql.raw(`drop trigger if exists ${fn} on audit_log`));
        await h.owner.execute(sql.raw(`drop function if exists ${fn}()`));
      }
      expect((await del(ownerA, c.id)).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("cross-site requests", () => {
    it.each([
      ["a cross-site origin", "https://evil.example"],
      ["a look-alike origin", `${BASE}.evil.example`],
      ["the string null", "null"],
      ["no origin at all", null],
    ])("create, edit and delete are 403 with %s, even for a valid owner, and change nothing", async (_label, origin) => {
      const c = await seedClient(orgA, `Origin ${tag()}`, { gradeLevel: "1" });
      const before = await clientCount(orgA);
      expect((await post(ownerA, { displayName: `Csrf ${tag()}` }, { origin })).status).toBe(403);
      expect((await patch(ownerA, c.id, { gradeLevel: "9" }, { origin })).status).toBe(403);
      expect((await del(ownerA, c.id, { origin })).status).toBe(403);
      expect(await clientCount(orgA)).toBe(before);
      const row = await clientRow(c.id);
      expect(row.gradeLevel).toBe("1");
      expect(row.deletedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("what leaks", () => {
    it("no audit row written by this suite holds a name, a date or an external id", async () => {
      const rows = await h.owner.select().from(schema.auditLog).where(inArray(schema.auditLog.organizationId, [orgA, orgB]));
      expect(rows.length).toBeGreaterThan(10);
      const text = JSON.stringify(rows);
      for (const needle of ["Owner Made", "Assoc Made", "Before ", "After ", "Doomed", "Atomic", "2016-05-17", "EXT-", "DUP-", "Granted ", "Secret"]) {
        expect(text, needle).not.toContain(needle);
      }
      const clientAudits = rows.filter((r) => r.action.startsWith("client.") && r.action !== "client.listed");
      for (const r of clientAudits) {
        expect(Object.keys(r.metadata as object).every((k) => ["role", "fields"].includes(k)), r.action).toBe(true);
      }
    });

    it("nothing a practice-B caller received contains a practice-A client, and the reverse", async () => {
      const aClients = await h.owner.select().from(schema.clients).where(eq(schema.clients.organizationId, orgA));
      const bClients = await h.owner.select().from(schema.clients).where(eq(schema.clients.organizationId, orgB));
      expect(aClients.length).toBeGreaterThan(5);
      for (const seen of h.seen) {
        if (seen.orgId === orgB) for (const c of aClients) expect(seen.text, `${seen.caller} saw ${c.id}`).not.toContain(c.id);
        if (seen.orgId === orgA) for (const c of bClients) expect(seen.text, `${seen.caller} saw ${c.id}`).not.toContain(c.id);
      }
    });

    it("every row this suite created in practice A is in practice A and live ones are not deleted by accident", async () => {
      const stray = await h.owner.select().from(schema.clients).where(and(eq(schema.clients.organizationId, orgB), isNull(schema.clients.deletedAt)));
      // Practice B only ever got its own fixtures and the two it created itself.
      expect(stray.every((c) => /^(Foreign|Mine B|B )/.test(c.displayName))).toBe(true);
    });
  });
});
