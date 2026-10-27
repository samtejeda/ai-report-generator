import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_WAIT_MS, callGenerateSection, parseRetryAfter } from "./generate-call";
import { GENERATION_ROUTE_MAX_SECONDS } from "./generation-limits";

const REPORT = "11111111-1111-4111-8111-111111111111";
const SECTION = "22222222-2222-4222-8222-222222222222";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });
}

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

  it("POSTs to the documented path with no body, and on success returns nothing from the response", async () => {
    fetchMock.mockResolvedValue(json({ data: { reportStatus: "generated", section: { id: SECTION, version: 1, editType: "ai_generated", text: "SECRET-TEXT" } } }));
    const result = await callGenerateSection(REPORT, SECTION);
    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain("SECRET-TEXT");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/reports/${REPORT}/sections/${SECTION}/generate`);
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("an error returns the status and the code only, never the server's message", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: "inference_failed", message: "LEAKED-DETAIL host=10.0.0.5" } }, { status: 502 }));
    const result = await callGenerateSection(REPORT, SECTION);
    expect(result).toEqual({ ok: false, failure: { status: 502, code: "inference_failed" }, retryAfterSeconds: null });
    expect(JSON.stringify(result)).not.toContain("LEAKED");
  });

  it("reads Retry-After from the header on a 429", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: "rate_limited" } }, { status: 429, headers: { "retry-after": "42" } }));
    expect(await callGenerateSection(REPORT, SECTION)).toEqual({ ok: false, failure: { status: 429, code: "rate_limited" }, retryAfterSeconds: 42 });
  });

  it("a body that is not our error shape gives code null, not a throw", async () => {
    fetchMock.mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await callGenerateSection(REPORT, SECTION)).toEqual({ ok: false, failure: { status: 502, code: null }, retryAfterSeconds: null });
    fetchMock.mockResolvedValue(json({ error: { code: 42 } }, { status: 500 }));
    expect(await callGenerateSection(REPORT, SECTION)).toEqual({ ok: false, failure: { status: 500, code: null }, retryAfterSeconds: null });
  });

  it("a request that never arrived is failure null", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await callGenerateSection(REPORT, SECTION)).toEqual({ ok: false, failure: null, retryAfterSeconds: null });
  });

  it("gives up after the route's own limit plus a margin, and says so as a timeout", async () => {
    vi.useFakeTimers();
    expect(BROWSER_WAIT_MS).toBeGreaterThan(GENERATION_ROUTE_MAX_SECONDS * 1000);
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const pending = callGenerateSection(REPORT, SECTION);
    await vi.advanceTimersByTimeAsync(BROWSER_WAIT_MS - 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await pending).toEqual({ ok: false, failure: { status: 0, code: "timeout" }, retryAfterSeconds: null });
  });

  it("an id that is not shaped like an id sends nothing", async () => {
    for (const [r, s] of [["../x", SECTION], [REPORT, "abc"], [`${REPORT}/..`, SECTION], ["", ""], [REPORT, `${SECTION}?x=1`]]) {
      expect(await callGenerateSection(r, s)).toEqual({ ok: false, failure: { status: 400, code: "validation_failed" }, retryAfterSeconds: null });
    }
    expect(fetchMock).not.toHaveBeenCalled();
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
