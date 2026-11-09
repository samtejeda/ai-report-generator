import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

const envMock = vi.hoisted(() => ({
  value: { INFERENCE_MODE: "real", OLLAMA_BASE_URL: "http://env-host:11434/v1" } as { INFERENCE_MODE: string; OLLAMA_BASE_URL: string },
}));
vi.mock("@/lib/env", () => ({ getEnv: () => envMock.value }));

import { runInference, runPipeline, type PipelineInput } from "./inference";
import { parseMethodologyContent } from "./pipeline/methodology";
import { MODELS } from "./models";

// Synthetic only. The "model" is a scripted fetch; nothing here reaches a network or a database.

const ORG = { organizationId: "11111111-1111-4111-8111-111111111111" };
const TEMPLATE = { id: "22222222-2222-4222-8222-222222222222", slug: "synthetic-template" };
const input: PipelineInput = { templates: [TEMPLATE], sectionKey: "synthetic_section", notes: "SYNTHETIC NOTES" };
const loadMethodology = async () => ({ promptId: "33333333-3333-4333-8333-333333333333", versionNumber: 1, methodology: parseMethodologyContent({ role: "SYNTHETIC ROLE TEXT" })! });

const answers = [
  { template: TEMPLATE.slug, sufficient: true, sensitive_content_detected: false, missing_fields: [] },
  { observations: ["SYNTHETIC OBSERVATION"], test_scores: [], quotes: [], family_context: [] },
  { content: "SYNTHETIC SECTION TEXT", flags: [] },
];

type Call = { url: string; body: { model: string; messages: { role: string; content: string }[]; reasoning_effort?: string } };

function completion(content: string) {
  return {
    id: "c1",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
  };
}

function scriptedFetch(contents: string[]) {
  const calls: Call[] = [];
  const transport = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const content = contents[calls.length - 1];
    return new Response(JSON.stringify(completion(content)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, transport };
}

beforeEach(() => {
  envMock.value = { INFERENCE_MODE: "real", OLLAMA_BASE_URL: "http://env-host:11434/v1" };
});

describe("runPipeline: real mode, through the AI SDK transport", () => {
  it("runs the three passes against one endpoint and returns the section", async () => {
    const { calls, transport } = scriptedFetch(answers.map((a) => JSON.stringify(a)));
    const result = await runPipeline(ORG, input, { fetch: transport, loadMethodology });

    expect(result.outcome).toBe("generated");
    expect(result.section).toEqual({ key: "synthetic_section", content: "SYNTHETIC SECTION TEXT", flags: [] });
    expect(result.passes.map((p) => p.pass)).toEqual(["filter", "extract", "generate"]);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => new URL(c.url).host))).toEqual(new Set(["env-host:11434"]));
  });

  it("uses the model for each role from models.ts, asks for no reasoning, and sends system and user apart", async () => {
    const { calls, transport } = scriptedFetch(answers.map((a) => JSON.stringify(a)));
    await runPipeline(ORG, input, { fetch: transport, loadMethodology });

    expect(calls.map((c) => c.body.model)).toEqual([MODELS.filter, MODELS.worker, MODELS.worker]);
    for (const c of calls) {
      expect(c.body.reasoning_effort).toBe("none");
      expect(c.body.messages.map((m) => m.role)).toEqual(["system", "user"]);
    }
    const generate = calls[2].body.messages;
    expect(generate[0].content).toContain("SYNTHETIC ROLE TEXT");
    expect(generate[1].content).not.toContain("SYNTHETIC ROLE TEXT");
    expect(generate[1].content).toContain("SYNTHETIC OBSERVATION");
  });

  it("uses the practice's endpoint and model overrides passed in, per role", async () => {
    const { calls, transport } = scriptedFetch(answers.map((a) => JSON.stringify(a)));
    await runPipeline(ORG, input, {
      endpoint: "https://tenant-box.example.ts.net/v1",
      models: { worker: "tenant-worker:8b" },
      fetch: transport,
      loadMethodology,
    });
    expect(calls.map((c) => c.body.model)).toEqual([MODELS.filter, "tenant-worker:8b", "tenant-worker:8b"]);
    expect(calls.every((c) => c.url.startsWith("https://tenant-box.example.ts.net/v1/"))).toBe(true);
  });

  it("returns [Please provide] without extract or generate when filter finds the notes insufficient", async () => {
    const { calls, transport } = scriptedFetch([JSON.stringify({ ...answers[0], sufficient: false })]);
    const result = await runPipeline(ORG, input, { fetch: transport, loadMethodology });
    expect(result.section).toEqual({ key: "synthetic_section", content: "[Please provide]", flags: ["insufficient_input"] });
    expect(calls).toHaveLength(1);
  });

  it("retries a malformed answer once through the real transport, then succeeds", async () => {
    const { calls, transport } = scriptedFetch(["not json", ...answers.map((a) => JSON.stringify(a))]);
    const result = await runPipeline(ORG, input, { fetch: transport, loadMethodology });
    expect(result.passes[0].attempts).toBe(2);
    expect(calls).toHaveLength(4);
  });
});

describe("runPipeline: onProceed", () => {
  it("is awaited once between the filter request and the first extract request", async () => {
    const { calls, transport } = scriptedFetch(answers.map((a) => JSON.stringify(a)));
    const seen: number[] = [];
    await runPipeline(ORG, input, {
      fetch: transport,
      loadMethodology,
      onProceed: async () => {
        seen.push(calls.length);
      },
    });
    expect(seen).toEqual([1]);
    expect(calls).toHaveLength(3);
  });

  it("lets the caller's error through as thrown and sends no extract request", async () => {
    const { calls, transport } = scriptedFetch(answers.map((a) => JSON.stringify(a)));
    const refusal = new Error("SYNTHETIC CALLER REFUSAL");
    const error = await runPipeline(ORG, input, {
      fetch: transport,
      loadMethodology,
      onProceed: async () => {
        throw refusal;
      },
    }).catch((e) => e);
    expect(error).toBe(refusal);
    expect(calls).toHaveLength(1);
  });

  it("is not called when the filter finds the notes thin", async () => {
    const { transport } = scriptedFetch([JSON.stringify({ ...answers[0], sufficient: false })]);
    const onProceed = vi.fn(async () => {});
    await runPipeline(ORG, input, { fetch: transport, loadMethodology, onProceed });
    expect(onProceed).not.toHaveBeenCalled();
  });
});

describe("runPipeline: proceedIfInsufficient", () => {
  const thin = JSON.stringify({ ...answers[0], sufficient: false, missing_fields: ["quotes"] });

  it("goes on past thin notes through the real transport, with the approved sentence in the system message", async () => {
    const { calls, transport } = scriptedFetch([thin, JSON.stringify(answers[1]), JSON.stringify({ content: "SYNTHETIC PARTIAL TEXT", flags: [] })]);
    const result = await runPipeline(ORG, input, { fetch: transport, loadMethodology, proceedIfInsufficient: true });
    expect(calls).toHaveLength(3);
    expect(calls[2].body.messages[0].content).toContain("Write only what the extracted fields support.");
    expect(calls[2].body.messages[0].content).not.toContain("Never invent details.");
    expect(result.section).toEqual({ key: "synthetic_section", content: "SYNTHETIC PARTIAL TEXT", flags: ["insufficient_input"] });
  });

  it("stops after the filter without the option, and with the option set false", async () => {
    for (const proceedIfInsufficient of [undefined, false]) {
      const { calls, transport } = scriptedFetch([thin]);
      const result = await runPipeline(ORG, input, { fetch: transport, loadMethodology, proceedIfInsufficient });
      expect(result.outcome).toBe("insufficient_input");
      expect(calls).toHaveLength(1);
    }
  });
});

describe("runPipeline: refusals and failures, with no fallback", () => {
  it("refuses in stub mode (from the environment or the option) before any request or database read", async () => {
    const { calls, transport } = scriptedFetch([]);
    const neverLoaded = vi.fn(loadMethodology);
    envMock.value = { ...envMock.value, INFERENCE_MODE: "stub" };
    await expect(runPipeline(ORG, input, { fetch: transport, loadMethodology: neverLoaded })).rejects.toMatchObject({ name: "PipelineError", code: "invalid_config" });
    envMock.value = { ...envMock.value, INFERENCE_MODE: "real" };
    await expect(runPipeline(ORG, input, { mode: "stub", fetch: transport, loadMethodology: neverLoaded })).rejects.toMatchObject({ code: "invalid_config" });
    expect(calls).toHaveLength(0);
    expect(neverLoaded).not.toHaveBeenCalled();
  });

  it.each(["not a url", "ftp://host/v1", "http://user:pw@host:11434/v1"])("refuses the endpoint %s before any request", async (endpoint) => {
    const { calls, transport } = scriptedFetch([]);
    await expect(runPipeline(ORG, input, { endpoint, fetch: transport, loadMethodology })).rejects.toMatchObject({ code: "invalid_config" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a malformed model override for a role the pipeline uses, before any request", async () => {
    const { calls, transport } = scriptedFetch([]);
    for (const models of [{ filter: "bad model" }, { worker: "" }]) {
      await expect(runPipeline(ORG, input, { models, fetch: transport, loadMethodology })).rejects.toMatchObject({ code: "invalid_config" });
    }
    expect(calls).toHaveLength(0);
  });

  it("reports an unreachable endpoint as a clear error naming the pass, after exactly one request to one host", async () => {
    const hosts: string[] = [];
    const down = (async (url: RequestInfo | URL) => {
      hosts.push(new URL(String(url)).host);
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const error = await runPipeline(ORG, input, { endpoint: "http://down.example:11434/v1", fetch: down, loadMethodology }).catch((e) => e);
    expect(error).toMatchObject({ name: "PipelineError", code: "unreachable", pass: "filter", message: "The inference endpoint could not be reached." });
    expect(hosts).toEqual(["down.example:11434"]);
  });

  it("reports an HTTP error as bad_response without retrying, and leaks neither endpoint nor body", async () => {
    let calls = 0;
    const failing = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "SYNTHETIC LEAKY BODY" } }), { status: 500 });
    }) as typeof fetch;
    const error = (await runPipeline(ORG, input, { endpoint: "http://secret-host.internal:11434/v1", fetch: failing, loadMethodology }).catch((e) => e)) as Error;
    expect(error).toMatchObject({ code: "bad_response" });
    expect(calls).toBe(1);
    expect(error.message).not.toContain("secret-host");
    expect(error.message).not.toContain("LEAKY");
  });
});

describe("the stub path is unchanged", () => {
  it("runInference still refuses real mode, and still sends only the fixed neutral prompt in stub mode", async () => {
    await expect(runInference({ mode: "real" })).rejects.toMatchObject({ code: "not_implemented" });
    const { calls, transport } = scriptedFetch(["ready"]);
    await runInference({ mode: "stub", fetch: transport });
    expect(calls[0].body.messages.map((m) => m.role)).toEqual(["user"]);
    expect(calls[0].body.messages[0].content).toBe("Reply with the single word: ready");
  });
});
