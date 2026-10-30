import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decideAfterRefusal, readCurrentSection, reconcileDraft, saveSectionCall, type CurrentRead } from "./save-section-call";

const REPORT = "11111111-1111-4111-8111-111111111111";
const SECTION = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

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

const detail = (status: string, sections: unknown[]) => json({ data: { id: REPORT, status, sections } });
const theirs = { id: SECTION, version: 5, text: "their text", editType: "human_edit", editedAt: "2026-10-30T19:14:00.000Z", authorName: "Dana Reyes", extra: "ignored" };

describe("readCurrentSection", () => {
  it("GETs the report and picks out this section, keeping only the fields it needs", async () => {
    fetchMock.mockResolvedValue(detail("generated", [{ id: OTHER, version: 1, text: "x" }, theirs]));
    const r = await readCurrentSection(REPORT, SECTION);
    expect(r).toEqual({
      ok: true,
      status: "generated",
      section: { version: 5, text: "their text", editType: "human_edit", authorName: "Dana Reyes", editedAt: "2026-10-30T19:14:00.000Z" },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/reports/${REPORT}`);
    expect(JSON.stringify(r)).not.toContain("ignored");
  });
  it("a section that is not in the report is section: null", async () => {
    fetchMock.mockResolvedValue(detail("draft", [{ id: OTHER, version: 1, text: "x" }]));
    expect(await readCurrentSection(REPORT, SECTION)).toEqual({ ok: true, status: "draft", section: null });
  });
  it("a section with an odd shape is not trusted", async () => {
    fetchMock.mockResolvedValue(detail("draft", [{ id: SECTION, version: "5", text: "x" }]));
    expect(await readCurrentSection(REPORT, SECTION)).toEqual({ ok: true, status: "draft", section: null });
  });
  it.each([
    ["an error status", () => json({}, { status: 404 })],
    ["no status", () => json({ data: { sections: [] } })],
    ["no sections list", () => json({ data: { status: "draft" } })],
    ["not json", () => new Response("<html>", { status: 200 })],
  ])("%s is 'could not read'", async (_name, make) => {
    fetchMock.mockResolvedValue(make());
    expect(await readCurrentSection(REPORT, SECTION)).toEqual({ ok: false });
  });
  it("a dropped request and an id that is not an id are 'could not read'", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await readCurrentSection(REPORT, SECTION)).toEqual({ ok: false });
    fetchMock.mockClear();
    expect(await readCurrentSection("nope", SECTION)).toEqual({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("gives up after 15 seconds instead of waiting forever", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))));
    const pending = readCurrentSection(REPORT, SECTION);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await pending).toEqual({ ok: false });
  });
});

describe("decideAfterRefusal", () => {
  const read = (status: string, version: number | null): CurrentRead => ({
    ok: true,
    status,
    section: version === null ? null : { version, text: "t", editType: "human_edit", authorName: "A", editedAt: "2026-10-30T19:14:00.000Z" },
  });

  it("a newer version in an open report is a conflict to show", () => {
    const r = decideAfterRefusal(read("generated", 5), 3);
    expect(r.kind).toBe("newer");
    if (r.kind === "newer") expect(r.theirs.version).toBe(5);
  });
  it.each(["draft", "generated", "error"])("%s is open", (status) => {
    expect(decideAfterRefusal(read(status, 4), 3).kind).toBe("newer");
  });
  it.each(["finalized", "generating", "something-new"])("%s is closed, even when a newer version exists (keep-mine could not work)", (status) => {
    expect(decideAfterRefusal(read(status, 9), 3).kind).toBe("closed");
  });
  it("no newer version in an open report is a one-off failure", () => {
    expect(decideAfterRefusal(read("draft", 3), 3).kind).toBe("unchanged");
    expect(decideAfterRefusal(read("draft", 2), 3).kind).toBe("unchanged");
  });
  it("a section that is gone, and a read that failed", () => {
    expect(decideAfterRefusal(read("draft", null), 3).kind).toBe("gone");
    expect(decideAfterRefusal({ ok: false }, 3).kind).toBe("unreadable");
  });
});

describe("reconcileDraft", () => {
  it("an untouched box follows the server (this is how Generate's text and a colleague's save appear)", () => {
    expect(reconcileDraft({ draft: "old", base: { version: 1, text: "old" } }, { version: 2, text: "new" })).toEqual({
      draft: "new",
      base: { version: 2, text: "new" },
      followed: true,
    });
    expect(reconcileDraft({ draft: "", base: { version: 0, text: "" } }, { version: 1, text: "generated" }).draft).toBe("generated");
  });
  it("a box with the person's edits is never replaced and keeps its old base version", () => {
    const r = reconcileDraft({ draft: "my edit", base: { version: 1, text: "old" } }, { version: 2, text: "their text" });
    expect(r).toEqual({ draft: "my edit", base: { version: 1, text: "old" }, followed: false });
  });
  it("following the same values is a no-op (right after the person's own save)", () => {
    const r = reconcileDraft({ draft: "saved", base: { version: 2, text: "saved" } }, { version: 2, text: "saved" });
    expect(r).toEqual({ draft: "saved", base: { version: 2, text: "saved" }, followed: true });
  });
  it("clearing a box is an edit too", () => {
    expect(reconcileDraft({ draft: "", base: { version: 1, text: "old" } }, { version: 2, text: "x" }).draft).toBe("");
  });
});
