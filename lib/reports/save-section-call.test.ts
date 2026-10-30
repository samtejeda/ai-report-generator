import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveSectionCall } from "./save-section-call";

const REPORT = "11111111-1111-4111-8111-111111111111";
const SECTION = "22222222-2222-4222-8222-222222222222";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("saveSectionCall", () => {
  it("PUTs the text with the version it was loaded from, and returns the new version", async () => {
    fetchMock.mockResolvedValue(json({ data: { versionId: "x", version: 4 } }));
    expect(await saveSectionCall(REPORT, SECTION, "my text", 3)).toEqual({ ok: true, version: 4 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/reports/${REPORT}/sections/${SECTION}`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ text: "my text", baseVersion: 3 });
  });
  it("a success with an unreadable body still reports base + 1, the version the server stores", async () => {
    fetchMock.mockResolvedValue(new Response("not json", { status: 200 }));
    expect(await saveSectionCall(REPORT, SECTION, "t", 3)).toEqual({ ok: true, version: 4 });
  });
  it("409 is 'refused' (stale or closed; the route does not say which)", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: "conflict", message: "LEAKED" } }, { status: 409 }));
    const r = await saveSectionCall(REPORT, SECTION, "t", 3);
    expect(r).toEqual({ ok: false, kind: "refused" });
    expect(JSON.stringify(r)).not.toContain("LEAKED");
  });
  it("400 is 'invalid'; anything else and a dropped request are 'failed'", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: "validation_failed" } }, { status: 400 }));
    expect(await saveSectionCall(REPORT, SECTION, "t", 0)).toEqual({ ok: false, kind: "invalid" });
    fetchMock.mockResolvedValue(json({}, { status: 500 }));
    expect(await saveSectionCall(REPORT, SECTION, "t", 0)).toEqual({ ok: false, kind: "failed" });
    fetchMock.mockResolvedValue(json({}, { status: 403 }));
    expect(await saveSectionCall(REPORT, SECTION, "t", 0)).toEqual({ ok: false, kind: "failed" });
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await saveSectionCall(REPORT, SECTION, "t", 0)).toEqual({ ok: false, kind: "failed" });
  });
  it("builds a path only from something shaped like an id", async () => {
    expect(await saveSectionCall("../x", SECTION, "t", 0)).toEqual({ ok: false, kind: "failed" });
    expect(await saveSectionCall(REPORT, "a/b", "t", 0)).toEqual({ ok: false, kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
