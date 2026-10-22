import { afterEach, describe, expect, it, vi } from "vitest";
import { callAdminApi } from "./api-call";

afterEach(() => vi.unstubAllGlobals());

const stub = (res: Response | Error) => {
  const fn = vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
};

describe("callAdminApi", () => {
  it("success: only the status comes back", async () => {
    stub(Response.json({ data: { secret: "x" } }, { status: 201 }));
    expect(await callAdminApi("/api/admin/assignments", "POST", { a: 1 })).toEqual({ ok: true, status: 201 });
  });
  it("sends JSON only when there is a body, and the method as given", async () => {
    const fn = stub(Response.json({}));
    await callAdminApi("/api/admin/users/1/deactivate", "POST");
    await callAdminApi("/api/admin/users/1", "PATCH", { role: "admin" });
    const [, a] = fn.mock.calls[0] as unknown as [string, RequestInit];
    const [, b] = fn.mock.calls[1] as unknown as [string, RequestInit];
    expect(a).toEqual({ method: "POST" });
    expect(b).toEqual({ method: "PATCH", headers: { "content-type": "application/json" }, body: '{"role":"admin"}' });
  });
  it("failure: status and error code, never the message text", async () => {
    stub(Response.json({ error: { code: "reauth_required", message: "Sign in again to do this." } }, { status: 403 }));
    expect(await callAdminApi("/x", "PUT", {})).toEqual({ ok: false, failure: { status: 403, code: "reauth_required" } });
  });
  it("failure with a body that is not our shape: code is null", async () => {
    stub(new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await callAdminApi("/x", "DELETE")).toEqual({ ok: false, failure: { status: 502, code: null } });
    stub(Response.json({ error: { code: 7 } }, { status: 400 }));
    expect(await callAdminApi("/x", "DELETE")).toEqual({ ok: false, failure: { status: 400, code: null } });
  });
  it("a network error is failure null", async () => {
    stub(new TypeError("failed to fetch"));
    expect(await callAdminApi("/x", "POST")).toEqual({ ok: false, failure: null });
  });
});
