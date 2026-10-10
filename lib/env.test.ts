import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

const valid = {
  DATABASE_URL: "postgresql://user:pw@host-pooler.example.com/db",
  DATABASE_URL_UNPOOLED: "postgresql://user:pw@host.example.com/db",
};

describe("parseEnv", () => {
  it("accepts a valid environment and applies defaults", () => {
    const env = parseEnv(valid);
    expect(env.INFERENCE_MODE).toBe("stub");
    expect(env.OLLAMA_BASE_URL).toBe("http://localhost:11434/v1");
  });

  it("names the missing variable", () => {
    expect(() => parseEnv({ DATABASE_URL_UNPOOLED: valid.DATABASE_URL_UNPOOLED })).toThrow(/DATABASE_URL:/);
  });

  it("never echoes a bad value back", () => {
    const secret = "hunter2-not-a-url";
    let message = "";
    try {
      parseEnv({ ...valid, DATABASE_URL: secret });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain(secret);
  });

  it("rejects an unknown inference mode", () => {
    expect(() => parseEnv({ ...valid, INFERENCE_MODE: "cloud" })).toThrow(/INFERENCE_MODE/);
  });
});
