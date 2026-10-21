import { describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "@/lib/db/schema";
import { AUDIT_ACTIONS, AUDIT_METADATA_KEYS, audit, buildAuditRow } from "./audit";

const org = "11111111-1111-4111-8111-111111111111";

describe("buildAuditRow (what may be written)", () => {
  it("builds a row from ids and allow-listed metadata", () => {
    const row = buildAuditRow({
      action: "auth.login_failed",
      resourceType: "users",
      resourceId: org,
      outcome: "failure",
      metadata: { reason: "bad_credentials", ip: "203.0.113.9" },
    });
    expect(row).toEqual({
      action: "auth.login_failed",
      resourceType: "users",
      resourceId: org,
      outcome: "failure",
      metadata: { reason: "bad_credentials", ip: "203.0.113.9" },
    });
  });

  it("defaults outcome to success and metadata to empty", () => {
    const row = buildAuditRow({ action: "auth.logout", resourceType: "users" });
    expect(row.outcome).toBe("success");
    expect(row.metadata).toEqual({});
    expect(row.resourceId).toBeNull();
  });

  it.each(["email", "password", "token", "display_name", "client_name", "note", "body", "ssn"])(
    "rejects the metadata key %s (could carry PHI or a secret)",
    (key) => {
      expect(() => buildAuditRow({ action: "auth.login", resourceType: "users", metadata: { [key]: "x" } })).toThrow(/not allowed/);
    },
  );

  it("rejects non-primitive and oversized values (no pasted bodies or objects)", () => {
    expect(() => buildAuditRow({ action: "auth.login", resourceType: "users", metadata: { reason: { a: 1 } as never } })).toThrow(/string, number or boolean/);
    expect(() => buildAuditRow({ action: "auth.login", resourceType: "users", metadata: { reason: "x".repeat(101) } })).toThrow(/too long/);
  });

  it("rejects unknown actions and malformed resource types", () => {
    expect(() => buildAuditRow({ action: "auth.oops" as never, resourceType: "users" })).toThrow(/unknown audit action/);
    expect(() => buildAuditRow({ action: "auth.login", resourceType: "Users; drop" })).toThrow(/resourceType/);
  });

  it("`fields` accepts only the closed list of client column names", () => {
    const ok = buildAuditRow({ action: "client.updated", resourceType: "client", metadata: { fields: "display_name,grade_level" } });
    expect(ok.metadata.fields).toBe("display_name,grade_level");
    for (const bad of ["Jane Doe", "display_name,Jane", "2015-04-02", "", "display_name,", "email"]) {
      expect(() => buildAuditRow({ action: "client.updated", resourceType: "client", metadata: { fields: bad } }), bad).toThrow(/known field list/);
    }
  });

  it("the allow-list holds no key that names client content", () => {
    for (const key of AUDIT_METADATA_KEYS) expect(key).not.toMatch(/name|note|body|content|text|email|password|token|secret/);
    for (const action of AUDIT_ACTIONS) expect(action).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });
});

describe("audit (write behavior)", () => {
  it("does not block the caller when the database write fails, and logs no payload", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingDb = drizzle.mock({ schema });
    failingDb.transaction = () => Promise.reject(Object.assign(new Error("boom with secret-detail"), { code: "08006" }));
    const ok = await audit({ organizationId: org, actorUserId: org }, { action: "auth.login", resourceType: "users", metadata: { ip: "203.0.113.9" } }, failingDb);
    expect(ok).toBe(false);
    const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("audit_write_failed");
    expect(logged).toContain("08006");
    expect(logged).not.toContain("secret-detail");
    expect(logged).not.toContain("203.0.113.9");
    spy.mockRestore();
  });

  it("still throws on an invalid event (a programming error, not an outage)", async () => {
    await expect(audit({ organizationId: org }, { action: "auth.login", resourceType: "users", metadata: { email: "a@b.c" } as never })).rejects.toThrow(/not allowed/);
  });
});
