import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  value: { INFERENCE_MODE: "stub", OLLAMA_BASE_URL: "http://env-host:11434/v1" } as {
    INFERENCE_MODE: string;
    OLLAMA_BASE_URL: string;
  },
}));
vi.mock("@/lib/env", () => ({ getEnv: () => envMock.value }));

import { InferenceError, STUB_PROMPT, runInference } from "./inference";
import { MODELS } from "./models";

type Call = { url: string; body: Record<string, unknown> };

function completion(content: string) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  };
}

function mockTransport(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return respond();
  }) as typeof fetch;
  return { calls, transport };
}

const ok = (content = "ready") => () =>
  new Response(JSON.stringify(completion(content)), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  envMock.value = { INFERENCE_MODE: "stub", OLLAMA_BASE_URL: "http://env-host:11434/v1" };
});

describe("runInference: stub mode", () => {
  it("sends the fixed trivial prompt to the stub model and returns text, model and usage", async () => {
    const { calls, transport } = mockTransport(ok("ready"));
    const result = await runInference({ fetch: transport });

    expect(result.text).toBe("ready");
    expect(result.mode).toBe("stub");
    expect(result.model).toBe(MODELS.stub);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://env-host:11434/v1/chat/completions");
    expect(calls[0].body.model).toBe(MODELS.stub);
    expect(JSON.stringify(calls[0].body.messages)).toContain(STUB_PROMPT);
  });

  it("asks Ollama not to think (reasoning_effort none)", async () => {
    const { calls, transport } = mockTransport(ok());
    await runInference({ fetch: transport });
    expect(calls[0].body.reasoning_effort).toBe("none");
  });

  it("strips inline reasoning if the model emits it anyway", async () => {
    const { transport } = mockTransport(ok("<think>hmm, a greeting</think>\n\nready"));
    expect((await runInference({ fetch: transport })).text).toBe("ready");
  });

  it("surfaces an empty answer as bad_response", async () => {
    const { transport } = mockTransport(ok("<think>only thoughts</think>"));
    await expect(runInference({ fetch: transport })).rejects.toMatchObject({ code: "bad_response" });
  });
});

describe("runInference: mode selection", () => {
  it("reads the mode from INFERENCE_MODE", async () => {
    envMock.value = { ...envMock.value, INFERENCE_MODE: "real" };
    const { calls, transport } = mockTransport(ok());
    await expect(runInference({ fetch: transport })).rejects.toMatchObject({ code: "not_implemented" });
    expect(calls).toHaveLength(0);
  });

  it("lets an explicit option override the env mode", async () => {
    envMock.value = { ...envMock.value, INFERENCE_MODE: "real" };
    const { transport } = mockTransport(ok());
    expect((await runInference({ mode: "stub", fetch: transport })).mode).toBe("stub");
  });

  it("rejects an unknown mode instead of guessing", async () => {
    const { transport } = mockTransport(ok());
    await expect(
      runInference({ mode: "cloud" as never, fetch: transport }),
    ).rejects.toMatchObject({ code: "invalid_config" });
  });
});

describe("runInference: per-organization overrides", () => {
  it("uses the endpoint and model passed in over the defaults", async () => {
    const { calls, transport } = mockTransport(ok());
    const result = await runInference({
      endpoint: "https://tenant-box.example.ts.net:11434/v1/",
      models: { stub: "tenant-model:3b" },
      fetch: transport,
    });
    expect(calls[0].url).toBe("https://tenant-box.example.ts.net:11434/v1/chat/completions");
    expect(calls[0].body.model).toBe("tenant-model:3b");
    expect(result.model).toBe("tenant-model:3b");
  });

  it.each(["not a url", "ftp://host/v1", "http://user:pw@host:11434/v1"])(
    "rejects the invalid endpoint %s without making a request",
    async (endpoint) => {
      const { calls, transport } = mockTransport(ok());
      await expect(runInference({ endpoint, fetch: transport })).rejects.toMatchObject({ code: "invalid_config" });
      expect(calls).toHaveLength(0);
    },
  );

  it("rejects a malformed model override without making a request", async () => {
    const { calls, transport } = mockTransport(ok());
    await expect(
      runInference({ models: { stub: "bad model" }, fetch: transport }),
    ).rejects.toMatchObject({ code: "invalid_config" });
    expect(calls).toHaveLength(0);
  });
});

describe("runInference: failures are clear, with no fallback", () => {
  it("reports an unreachable endpoint and contacts exactly one host, once", async () => {
    const hosts: string[] = [];
    const transport = (async (input: RequestInfo | URL) => {
      hosts.push(new URL(String(input)).host);
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const error = await runInference({ endpoint: "http://down.example:11434/v1", fetch: transport }).catch((e) => e);

    expect(error).toBeInstanceOf(InferenceError);
    expect(error.code).toBe("unreachable");
    expect(error.message).toBe("The inference endpoint could not be reached.");
    expect(hosts).toEqual(["down.example:11434"]);
  });

  it("reports an HTTP error as bad_response, once", async () => {
    const { calls, transport } = mockTransport(
      () => new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 }),
    );
    await expect(runInference({ fetch: transport })).rejects.toMatchObject({ code: "bad_response" });
    expect(calls).toHaveLength(1);
  });

  it("reports a non-JSON body as bad_response", async () => {
    const { transport } = mockTransport(() => new Response("<html>oops</html>", { status: 200 }));
    await expect(runInference({ fetch: transport })).rejects.toMatchObject({ code: "bad_response" });
  });

  it("reports a stalled endpoint as timeout", async () => {
    const transport = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    await expect(runInference({ fetch: transport, timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("never puts the prompt, endpoint, or response body in an error message", async () => {
    const endpoint = "http://secret-host.internal:11434/v1";
    const { transport } = mockTransport(
      () => new Response(JSON.stringify({ error: { message: "leaky body text" } }), { status: 500 }),
    );
    const error = (await runInference({ endpoint, fetch: transport }).catch((e) => e)) as Error;
    expect(error.message).not.toContain("secret-host");
    expect(error.message).not.toContain("leaky body text");
    expect(error.message).not.toContain(STUB_PROMPT);
  });
});
