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
    // The two token COUNTS are the only keys allowed to contain "token": they accept whole numbers only (below).
    for (const key of AUDIT_METADATA_KEYS.filter((k) => k !== "input_tokens" && k !== "output_tokens")) expect(key).not.toMatch(/name|note|body|content|text|email|password|token|secret/);
    for (const action of AUDIT_ACTIONS) expect(action).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });
});

describe("generation events (feat/generate-section-stub)", () => {
  const started = { action: "report.generated", resourceType: "report_version" } as const;

  it("accepts a model tag, whole-number counts and a known mode", () => {
    const row = buildAuditRow({ ...started, metadata: { role: "owner", mode: "stub", model: "qwen3:1.7b", input_tokens: 12, output_tokens: 3, latency_ms: 840 } });
    expect(row.metadata).toEqual({ role: "owner", mode: "stub", model: "qwen3:1.7b", input_tokens: 12, output_tokens: 3, latency_ms: 840 });
  });

  it("rejects free text where a tag, count or mode belongs", () => {
    for (const model of ["Jane Doe", "https://box.tailnet.ts.net", "x".repeat(101), "", "a b"]) {
      expect(() => buildAuditRow({ ...started, metadata: { model } }), model).toThrow(/model tag|too long/);
    }
    for (const n of [-1, 1.5, Number.NaN, "12", Number.POSITIVE_INFINITY, 2e9]) {
      expect(() => buildAuditRow({ ...started, metadata: { input_tokens: n as never } }), String(n)).toThrow(/whole number/);
      expect(() => buildAuditRow({ ...started, metadata: { latency_ms: n as never } }), String(n)).toThrow(/whole number/);
    }
    expect(() => buildAuditRow({ ...started, metadata: { mode: "cloud" } })).toThrow(/stub or real/);
  });

  it("a failed generation carries one code from the closed list and nothing else in `reason`", () => {
    for (const reason of ["unreachable", "timeout", "bad_response", "invalid_output", "invalid_config", "not_implemented", "stale", "internal"]) {
      expect(buildAuditRow({ action: "report.generation_failed", resourceType: "report", metadata: { reason } }).metadata.reason).toBe(reason);
    }
    for (const reason of ["connect ECONNREFUSED 100.64.0.1:11434", "Jane Doe wrote", "", "set"]) {
      expect(() => buildAuditRow({ action: "report.generation_failed", resourceType: "report", metadata: { reason } }), reason).toThrow(/generation failure code/);
    }
    expect(() => buildAuditRow({ action: "report.generation_failed", resourceType: "report" })).toThrow(/generation failure code/);
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

describe("invitation audit rows (feat/invitations)", () => {
  const id = "22222222-2222-4222-8222-222222222222";

  it("records the invitation id and a role: never the address, the token or its hash", () => {
    const row = buildAuditRow({ action: "invitation.created", resourceType: "invitation", resourceId: id, metadata: { role: "associate" } });
    expect(row.metadata).toEqual({ role: "associate" });
    for (const key of ["email", "token", "token_hash", "address", "name"]) {
      expect(() => buildAuditRow({ action: "invitation.created", resourceType: "invitation", resourceId: id, metadata: { [key]: "x" } }), key).toThrow(/not allowed/);
    }
  });

  it("an owner's refusal (invitation.refused) has one reason: the address already has an account", () => {
    expect(buildAuditRow({ action: "invitation.refused", resourceType: "invitation", resourceId: id, outcome: "denied", metadata: { reason: "address_in_use" } }).metadata.reason).toBe("address_in_use");
    for (const bad of ["expired", "Jane", "", "address_in_use "]) {
      expect(() => buildAuditRow({ action: "invitation.refused", resourceType: "invitation", resourceId: id, outcome: "denied", metadata: { reason: bad } }), bad).toThrow(/invitation refusal/);
    }
    expect(() => buildAuditRow({ action: "invitation.refused", resourceType: "invitation", resourceId: id, outcome: "denied" })).toThrow(/invitation refusal/);
  });

  it("a link that could not be used (invitation.accept_refused) says why from a closed list", () => {
    for (const reason of ["expired", "revoked", "used", "address_in_use"]) {
      expect(buildAuditRow({ action: "invitation.accept_refused", resourceType: "invitation", resourceId: id, outcome: "denied", metadata: { reason } }).metadata.reason).toBe(reason);
    }
    for (const bad of ["unknown_token", "wrong", "some text"]) {
      expect(() => buildAuditRow({ action: "invitation.accept_refused", resourceType: "invitation", resourceId: id, outcome: "denied", metadata: { reason: bad } }), bad).toThrow(/invitation refusal/);
    }
  });

  it("the invitation actions are on the list", () => {
    for (const action of ["invitation.created", "invitation.resent", "invitation.revoked", "invitation.accepted", "invitation.refused", "invitation.accept_refused"]) {
      expect((AUDIT_ACTIONS as readonly string[]).includes(action), action).toBe(true);
    }
  });
});
