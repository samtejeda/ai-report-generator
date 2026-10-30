import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conflictSentence, decideAfterRefusal, readCurrentSection, SAVE_MINE_BUTTON, SEE_THEIRS_BUTTON, type CurrentRead, USE_THEIRS_BUTTON } from "./section-conflict";

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

// REMOVABLE: tests for lib/reports/section-conflict.ts; delete with it.
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

describe("conflictSentence", () => {
  const AT = "2026-10-30T19:14:00.000Z";
  it("names the author and leaves a place for the time", () => {
    expect(conflictSentence({ authorName: "Dana Reyes", editedAt: AT })).toEqual({
      before: "Dana Reyes saved this section at ",
      after: " while you were editing. Your changes are still here.",
    });
  });
  it("an unknown author is 'Someone'", () => {
    expect(conflictSentence({ authorName: null, editedAt: AT }).before).toBe("Someone saved this section at ");
    expect(conflictSentence({ authorName: "   ", editedAt: AT }).before).toBe("Someone saved this section at ");
  });
  it("with no time there is no 'at <time>' and no second part", () => {
    expect(conflictSentence({ authorName: "Dana", editedAt: null })).toEqual({
      before: "Dana saved this section while you were editing. Your changes are still here.",
      after: null,
    });
    expect(conflictSentence({ authorName: null, editedAt: null }).before).toBe("Someone saved this section while you were editing. Your changes are still here.");
  });
  it("reads as one sentence once the time is put between the parts", () => {
    const { before, after } = conflictSentence({ authorName: "Dana", editedAt: AT });
    expect(`${before}3:14 PM${after}`).toBe("Dana saved this section at 3:14 PM while you were editing. Your changes are still here.");
  });
});

describe("the labels are the ones Sam chose", () => {
  it("buttons and toggle", () => {
    expect(SAVE_MINE_BUTTON).toBe("Save mine as the newest version");
    expect(USE_THEIRS_BUTTON).toBe("Use theirs instead");
    expect(SEE_THEIRS_BUTTON).toBe("See their version");
  });
});
