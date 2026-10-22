import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPORT_WRITE_ROLES } from "@/lib/auth/permissions";
import { generatedTextSchema, MAX_SECTION_TEXT } from "./content";
import { failureStatus, llmMetadataSchema, parseModelConfig } from "./generation";
import { BUSY_RETRY_SECONDS, GENERATION_CALL_TIMEOUT_MS, GENERATION_LEASE_SECONDS, GENERATION_ROUTE_MAX_SECONDS, MAX_CONCURRENT_GENERATIONS, MAX_STARTS_PER_ORGANIZATION, MAX_STARTS_PER_USER } from "./generation-limits";

describe("model_config is outside input", () => {
  it("accepts nothing, an empty object, and a string stub tag; ignores keys it does not read", () => {
    expect(parseModelConfig(undefined)).toEqual({ ok: true, models: {} });
    expect(parseModelConfig(null)).toEqual({ ok: true, models: {} });
    expect(parseModelConfig({})).toEqual({ ok: true, models: {} });
    expect(parseModelConfig({ stub: "qwen3:1.7b" })).toEqual({ ok: true, models: { stub: "qwen3:1.7b" } });
    expect(parseModelConfig({ worker: "qwen3:8b", extra: { a: 1 } })).toEqual({ ok: true, models: {} });
  });

  it("refuses a stub value that is not a short non-empty string, and anything that is not an object", () => {
    for (const bad of [{ stub: 5 }, { stub: null }, { stub: "" }, { stub: "x".repeat(129) }, { stub: ["a"] }, { stub: { a: 1 } }, "text", 7, [], true]) {
      expect(parseModelConfig(bad), JSON.stringify(bad)).toEqual({ ok: false });
    }
  });
});

describe("llm_metadata is closed", () => {
  const good = { mode: "stub", model: "qwen3:1.7b", inputTokens: 12, outputTokens: null, latencyMs: 840, costUsd: 0 };

  it("accepts the documented shape", () => {
    expect(llmMetadataSchema.parse(good)).toEqual(good);
  });

  it("refuses extra keys (a prompt, an output, an endpoint), a non-zero cost, a URL as a model, bad numbers and another mode", () => {
    for (const bad of [
      { ...good, prompt: "Reply with the single word: ready" },
      { ...good, output: "text" },
      { ...good, endpoint: "https://a.b.ts.net" },
      { ...good, costUsd: 0.01 },
      { ...good, model: "https://a.b.ts.net/v1" },
      { ...good, model: "a b" },
      { ...good, inputTokens: -1 },
      { ...good, latencyMs: 1.5 },
      { ...good, mode: "real" },
    ]) {
      expect(llmMetadataSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("model text is checked before it can become section text", () => {
  it("accepts ordinary text and trims it", () => {
    expect(generatedTextSchema.parse("  ready \n")).toBe("ready");
    expect(generatedTextSchema.parse("line one\n\tline two")).toBe("line one\n\tline two");
  });

  it("refuses empty or blank text, control characters, and more than a section may hold", () => {
    for (const bad of ["", "   ", "\n\t", "a\u0000b", "a\u0007b", "a\u007Fb", "x".repeat(MAX_SECTION_TEXT + 1)]) {
      expect(generatedTextSchema.safeParse(bad).success, JSON.stringify(bad.slice(0, 20))).toBe(false);
    }
    expect(generatedTextSchema.safeParse("x".repeat(MAX_SECTION_TEXT)).success).toBe(true);
  });

  it("the text is data: markup and SQL-looking text are stored as given, never interpreted", () => {
    const text = "<script>alert(1)</script>'; drop table reports; --";
    expect(generatedTextSchema.parse(text)).toBe(text);
  });
});

describe("failure to HTTP status", () => {
  it("a timeout is 504, our own failure 500, everything else about the model 502", () => {
    expect(failureStatus("timeout")).toBe(504);
    expect(failureStatus("internal")).toBe(500);
    for (const r of ["unreachable", "bad_response", "invalid_output", "invalid_config", "not_implemented", "stale"] as const) expect(failureStatus(r)).toBe(502);
  });
});

describe("limits are sane and consistent", () => {
  it("the lease outlasts the route's time limit, which outlasts the model call", () => {
    expect(GENERATION_LEASE_SECONDS).toBeGreaterThan(GENERATION_ROUTE_MAX_SECONDS);
    expect(GENERATION_ROUTE_MAX_SECONDS * 1000).toBeGreaterThan(GENERATION_CALL_TIMEOUT_MS);
  });

  it("the documented numbers (API.md) are the ones in force", () => {
    expect([MAX_CONCURRENT_GENERATIONS, MAX_STARTS_PER_USER, MAX_STARTS_PER_ORGANIZATION, GENERATION_LEASE_SECONDS, GENERATION_CALL_TIMEOUT_MS, BUSY_RETRY_SECONDS]).toEqual([2, 10, 30, 120, 30_000, 30]);
    const api = readFileSync("API.md", "utf8");
    expect(api).toContain("2 running per practice; 10 per person and 30 per practice per 10 min");
  });
});

describe("the route", () => {
  const route = readFileSync("app/api/reports/[id]/sections/[sectionId]/generate/route.ts", "utf8");

  it("sets maxDuration as a literal (Next.js reads it at build time) equal to the documented limit", () => {
    expect(route).toMatch(/^export const maxDuration = 60;$/m);
    expect(GENERATION_ROUTE_MAX_SECONDS).toBe(60);
  });

  it("allows exactly the report writers (the literal list the coverage scan reads equals the constant)", () => {
    const match = route.match(/roles: \[([^\]]*)\]/);
    expect(match).not.toBeNull();
    const roles = match![1].split(",").map((r) => r.trim().replace(/"/g, ""));
    expect([...roles].sort()).toEqual([...REPORT_WRITE_ROLES].sort());
    expect(roles).not.toContain("admin");
  });
});

// Inference is reached only through lib/ai/inference.ts, and only by one module (CLAUDE.md, audit 02 item 8).
describe("who reaches inference", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      if (name === "node_modules" || name === ".next" || name.startsWith(".")) return [];
      const full = join(dir, name);
      return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx|mjs)$/.test(name) ? [full] : [];
    });
  }
  const all = ["app", "lib", "components", "scripts"].flatMap((d) => files(d)).filter((f) => !f.startsWith("lib/ai/") && !/\.test\.tsx?$/.test(f));

  it("nothing outside lib/ai imports anything from lib/ai except inference.ts, and only generate-section.ts does that", () => {
    const importers: string[] = [];
    for (const file of all) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/from\s+["']@\/lib\/ai\/([^"']+)["']/g)) {
        expect(m[1], `${file} imports lib/ai/${m[1]}`).toBe("inference");
        importers.push(file);
      }
    }
    expect(importers).toEqual(["lib/reports/generate-section.ts"]);
  });

  it("no module outside lib/ai mentions a model tag or a prompt (the tag lives in lib/ai/models.ts)", () => {
    for (const file of all) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/["'`]qwen3?:|["'`]gemma\d*:|STUB_PROMPT\s*=/);
    }
  });

  it("no module imports a cloud model provider", () => {
    for (const file of all) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from\s+["'](@ai-sdk\/(openai|anthropic|google|mistral|cohere|azure|amazon-bedrock)|openai|@anthropic-ai\/sdk)["']/);
    }
  });
});
