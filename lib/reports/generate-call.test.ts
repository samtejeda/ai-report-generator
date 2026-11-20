import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTRACT_FIELDS, SECTION_FLAGS } from "@/lib/ai/pipeline/schemas";
import { BROWSER_WAIT_MS, callGenerateSection, MISSING_CATEGORIES, parseGenerateAnswer, parseRetryAfter, REAL_BROWSER_WAIT_MS, REVIEW_FLAGS } from "./generate-call";
import { GENERATION_ROUTE_MAX_SECONDS, GENERATION_STUB_ROUTE_SECONDS } from "./generation-limits";

const REPORT = "11111111-1111-4111-8111-111111111111";
const SECTION = "22222222-2222-4222-8222-222222222222";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });
}
const failed = (status: number, code: string | null, retryAfterSeconds: number | null = null) => ({ kind: "failed", failure: { status, code }, retryAfterSeconds });

describe("the closed lists", () => {
  it("equal the pipeline's own lists (this file is client code, so it cannot import them)", () => {
    expect([...REVIEW_FLAGS]).toEqual([...SECTION_FLAGS]);
    expect([...MISSING_CATEGORIES]).toEqual([...EXTRACT_FIELDS]);
  });
});

describe("callGenerateSection", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("POSTs the body it is given to the documented path", async () => {
    fetchMock.mockResolvedValue(json({ data: { reportStatus: "generated", section: { id: SECTION, version: 1, editType: "ai_generated", text: "x" } } }));
    await callGenerateSection(REPORT, SECTION, { baseVersion: 3, replaceEdited: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/reports/${REPORT}/sections/${SECTION}/generate`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ baseVersion: 3, replaceEdited: true });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("on success returns the version and flags and never the generated text", async () => {
    fetchMock.mockResolvedValue(json({ data: { outcome: "generated", reportStatus: "generated", section: { id: SECTION, version: 2, editType: "ai_regenerated_section", text: "SECRET-TEXT" }, flags: ["sensitive_content_detected"] } }));
    const result = await callGenerateSection(REPORT, SECTION, { baseVersion: 1, notes: "NOTES-SECRET" }, true);
    expect(result).toEqual({ kind: "generated", version: 2, flags: ["sensitive_content_detected"] });
    expect(JSON.stringify(result)).not.toMatch(/SECRET/);
  });

  it("the stub's answer (no outcome, no flags) is a generation with no flags", async () => {
    fetchMock.mockResolvedValue(json({ data: { reportStatus: "generated", section: { id: SECTION, version: 1, editType: "ai_generated", text: "t" } } }));
    expect(await callGenerateSection(REPORT, SECTION, { baseVersion: 0 })).toEqual({ kind: "generated", version: 1, flags: [] });
  });

  it("an error returns the status and the code only, never the server's message", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: "inference_failed", message: "LEAKED-DETAIL host=10.0.0.5" } }, { status: 502 }));
    const result = await callGenerateSection(REPORT, SECTION, { baseVersion: 0 });
    expect(result).toEqual(failed(502, "inference_failed"));
    expect(JSON.stringify(result)).not.toContain("LEAKED");
  });

  it("reads Retry-After from the header on a 429", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: "rate_limited" } }, { status: 429, headers: { "retry-after": "42" } }));
    expect(await callGenerateSection(REPORT, SECTION, { baseVersion: 0 })).toEqual(failed(429, "rate_limited", 42));
  });

  it("a body that is not our error shape gives code null, not a throw", async () => {
    fetchMock.mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await callGenerateSection(REPORT, SECTION, { baseVersion: 0 })).toEqual(failed(502, null));
    fetchMock.mockResolvedValue(json({ error: { code: 42 } }, { status: 500 }));
    expect(await callGenerateSection(REPORT, SECTION, { baseVersion: 0 })).toEqual(failed(500, null));
  });

  it("a 200 that cannot be read is a generic failure, not a throw", async () => {
    fetchMock.mockResolvedValue(new Response("not json", { status: 200 }));
    expect(await callGenerateSection(REPORT, SECTION, { baseVersion: 0 })).toEqual(failed(0, "unreadable"));
  });

  it("a request that never arrived is failure null", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await callGenerateSection(REPORT, SECTION, { baseVersion: 0 })).toEqual({ kind: "failed", failure: null, retryAfterSeconds: null });
  });

  it("the stub waits the route's own limit plus a margin; real mode waits for the route's 300 s plus a margin", async () => {
    expect(BROWSER_WAIT_MS).toBeGreaterThan(GENERATION_STUB_ROUTE_SECONDS * 1000);
    expect(REAL_BROWSER_WAIT_MS).toBeGreaterThan(GENERATION_ROUTE_MAX_SECONDS * 1000);
    for (const [real, wait] of [[false, BROWSER_WAIT_MS], [true, REAL_BROWSER_WAIT_MS]] as const) {
      vi.useFakeTimers();
      fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
      const pending = callGenerateSection(REPORT, SECTION, { baseVersion: 0 }, real);
      await vi.advanceTimersByTimeAsync(wait - 1);
      let settled = false;
      void pending.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(await pending).toEqual(failed(0, "timeout"));
      vi.useRealTimers();
    }
  });

  it("an id that is not shaped like an id sends nothing", async () => {
    for (const [r, s] of [["../x", SECTION], [REPORT, "abc"], [`${REPORT}/..`, SECTION], ["", ""], [REPORT, `${SECTION}?x=1`]]) {
      expect(await callGenerateSection(r, s, { baseVersion: 0 })).toEqual(failed(400, "validation_failed"));
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("parseGenerateAnswer", () => {
  it("thin notes: only names from the closed list survive, and sensitive is a strict boolean", () => {
    expect(parseGenerateAnswer({ data: { outcome: "needs_confirmation", reason: "thin_notes", reportStatus: "draft", missing: ["quotes", "LEAK", "observations"], sensitive: true } })).toEqual({
      kind: "thin_notes",
      missing: ["observations", "quotes"],
      sensitive: true,
    });
    expect(parseGenerateAnswer({ data: { outcome: "needs_confirmation", reason: "thin_notes", missing: "nope", sensitive: "yes" } })).toEqual({ kind: "thin_notes", missing: [], sensitive: false });
  });

  it("the edited-text question", () => {
    expect(parseGenerateAnswer({ data: { outcome: "needs_confirmation", reason: "edited_text", reportStatus: "generated" } })).toEqual({ kind: "edited_text" });
  });

  it("unknown flags and an unknown reason are dropped or unreadable, never shown", () => {
    expect(parseGenerateAnswer({ data: { outcome: "generated", section: { version: 1 }, flags: ["insufficient_input", "WEIRD"] } })).toEqual({ kind: "generated", version: 1, flags: ["insufficient_input"] });
    expect(parseGenerateAnswer({ data: { outcome: "needs_confirmation", reason: "new_thing" } })).toEqual(failed(0, "unreadable"));
    expect(parseGenerateAnswer(null)).toEqual(failed(0, "unreadable"));
    expect(parseGenerateAnswer({ data: {} })).toEqual(failed(0, "unreadable"));
  });
});

describe("parseRetryAfter", () => {
  it("accepts positive whole seconds only", () => {
    expect(parseRetryAfter("1")).toBe(1);
    expect(parseRetryAfter(" 30 ")).toBe(30);
    expect(parseRetryAfter("600")).toBe(600);
    for (const bad of [null, "", "0", "-5", "1.5", "abc", "Wed, 21 Oct 2026 07:28:00 GMT", "1e3", "9999999"]) expect(parseRetryAfter(bad)).toBeNull();
  });
});
