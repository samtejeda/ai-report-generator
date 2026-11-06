import { describe, expect, it, vi } from "vitest";
import { createAcceptHandler, type AcceptDeps, type AcceptResult } from "./invitation-accept";
import { hashInvitationToken, newInvitationToken } from "./invitation-token";

const ORIGIN = "https://app.example.test";
const GOOD = "a long passphrase of mine 42";

function setup(result: AcceptResult = "accepted", over: Partial<AcceptDeps> = {}) {
  const calls: string[] = [];
  const deps: AcceptDeps = {
    allowedOrigin: () => ORIGIN,
    limit: vi.fn(async () => (calls.push("limit"), { allowed: true as const })),
    hashPassword: vi.fn(async (p: string) => (calls.push("hash"), `hash-of-${p.length}-characters-long`)),
    accept: vi.fn(async () => (calls.push("accept"), result)),
    log: vi.fn(),
    ...over,
  };
  return { deps, calls, handler: createAcceptHandler(deps) };
}

const req = (body: unknown, o: { origin?: string | null; ip?: string; raw?: string } = {}) => {
  const headers = new Headers({ "content-type": "application/json" });
  if (o.origin !== null) headers.set("origin", o.origin ?? ORIGIN);
  if (o.ip) headers.set("x-forwarded-for", o.ip);
  return new Request(`${ORIGIN}/api/invitations/accept`, { method: "POST", headers, body: o.raw ?? JSON.stringify(body) });
};
const valid = () => ({ token: newInvitationToken().token, name: "Synthetic Person", password: GOOD });
const answer = async (res: Response) => ({ status: res.status, text: await res.text(), headers: [...res.headers.entries()].filter(([k]) => k !== "date").sort() });

describe("POST /api/invitations/accept (order of checks, with injected dependencies)", () => {
  it("accepts a valid request: 201, and the database gets the token's HASH, never the token, and the password's hash, never the password", async () => {
    const { handler, deps } = setup();
    const body = valid();
    const res = await handler(req(body, { ip: "203.0.113.9" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { status: "accepted" } });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(deps.accept).toHaveBeenCalledWith({ tokenHash: hashInvitationToken(body.token), displayName: "Synthetic Person", passwordHash: `hash-of-${GOOD.length}-characters-long`, ip: "203.0.113.9" });
    const sent = JSON.stringify(vi.mocked(deps.accept).mock.calls);
    expect(sent).not.toContain(body.token);
    expect(sent).not.toContain(GOOD);
  });

  it("the other origin, or none, is refused before anything is counted, hashed or looked up", async () => {
    for (const origin of ["https://evil.example", "http://app.example.test", null]) {
      const { handler, calls } = setup();
      const res = await handler(req(valid(), { origin }));
      expect(res.status, String(origin)).toBe(403);
      expect((await res.json()).error.code).toBe("forbidden_origin");
      expect(calls).toEqual([]);
    }
  });

  it("counts the request by address bucket first (an IPv6 address by its /64), and a refusal is a 429 with Retry-After before the body is even read", async () => {
    const limit = vi.fn(async () => ({ allowed: false as const, retryAfterSeconds: 321 }));
    const { handler, calls } = setup("accepted", { limit });
    const res = await handler(req(valid(), { ip: "2001:db8:0:17::5" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("321");
    expect((await res.json()).error.code).toBe("rate_limited");
    expect(limit).toHaveBeenCalledWith("2001:0db8:0000:0017::/64");
    expect(calls).toEqual([]);

    const none = vi.fn(async () => ({ allowed: true as const }));
    await setup("accepted", { limit: none }).handler(req(valid()));
    expect(none).toHaveBeenCalledWith("no-trusted-ip");
  });

  it.each([
    ["no body", undefined, "{not json"],
    ["a role", { ...valid(), role: "admin" }, undefined],
    ["an organization", { ...valid(), organizationId: "x" }, undefined],
    ["a short token", { ...valid(), token: "abc" }, undefined],
    ["a token with a bad character", { ...valid(), token: "!".repeat(43) }, undefined],
    ["no name", { token: valid().token, password: GOOD }, undefined],
    ["an empty name", { ...valid(), name: "   " }, undefined],
    ["a name that is too long", { ...valid(), name: "x".repeat(201) }, undefined],
    ["a name with a control character", { ...valid(), name: "Syn\u0000thetic" }, undefined],
    ["a short password", { ...valid(), password: "elevenchars" }, undefined],
    ["a password over 128", { ...valid(), password: "p".repeat(129) }, undefined],
    ["numbers", { token: 1, name: 2, password: 3 }, undefined],
    ["an array", [valid()], undefined],
    ["a body over 2 KB", undefined, JSON.stringify({ ...valid(), pad: "x".repeat(3000) })],
  ])("%s is a 400 validation_failed, decided before the password is hashed or the token is looked up", async (_label, body, raw) => {
    const { handler, calls } = setup();
    const res = await handler(req(body, { raw }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("validation_failed");
    expect(calls).toEqual(["limit"]);
  });

  it("a password of exactly 12 and exactly 128 characters is accepted", async () => {
    for (const password of ["p".repeat(12), "p".repeat(128)]) {
      expect((await setup().handler(req({ ...valid(), password }))).status).toBe(201);
    }
  });

  it("every unusable token gets the SAME answer (status, body and headers): unknown, used, revoked, expired, address taken", async () => {
    const outcomes: AcceptResult[] = ["unknown", "refused", "refused", "refused", "refused"];
    const seen = [];
    for (const outcome of outcomes) {
      const { handler, calls } = setup(outcome);
      const res = await handler(req(valid(), { ip: "203.0.113.9" }));
      expect(calls).toEqual(["limit", "hash", "accept"]);
      seen.push(await answer(res));
    }
    expect(seen[0].status).toBe(400);
    expect(JSON.parse(seen[0].text)).toEqual({ error: { code: "invalid_invitation", message: "This invitation link is not valid." } });
    for (const s of seen) expect(s).toEqual(seen[0]);
  });

  it("hashes the password before it looks at the token, for a made-up token too (so timing does not tell them apart)", async () => {
    const { handler, calls } = setup("unknown");
    await handler(req(valid()));
    expect(calls).toEqual(["limit", "hash", "accept"]);
  });

  it("an unknown token is logged with the address only: no token, no name, no password", async () => {
    const { handler, deps } = setup("unknown");
    const body = valid();
    await handler(req(body, { ip: "203.0.113.9" }));
    expect(deps.log).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith("invitation.accept_unknown_token", { ip: "203.0.113.9" });
    expect(JSON.stringify(vi.mocked(deps.log).mock.calls)).not.toMatch(new RegExp(`${body.token}|Synthetic|${GOOD}`));
    const known = setup("refused");
    await known.handler(req(valid()));
    expect(known.deps.log).not.toHaveBeenCalled();
  });

  it("any failure inside becomes a fixed 500 with nothing from the error or the request in it or in the log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const body = valid();
      const { handler } = setup("accepted", { accept: async () => { throw new Error(`boom ${body.token} ${GOOD}`); } });
      const res = await handler(req(body));
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toMatch(/boom|passphrase/);
      expect(JSON.parse(text).error.code).toBe("internal_error");
      const logged = spy.mock.calls.flat().join(" ");
      expect(logged).toBe('{"event":"route_error","resource":"invitation_accept","kind":"Error"}');
      expect(logged).not.toContain(body.token);
    } finally {
      spy.mockRestore();
    }
  });
});
