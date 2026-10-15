import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

const valid = {
  DATABASE_URL: "postgresql://user:pw@host-pooler.example.com/db",
};

describe("parseEnv", () => {
  it("accepts a valid environment and applies defaults", () => {
    const env = parseEnv(valid);
    expect(env.INFERENCE_MODE).toBe("stub");
    expect(env.OLLAMA_BASE_URL).toBe("http://localhost:11434/v1");
  });

  it("names the missing variable", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL:/);
  });

  it("does not require or expose the owner (unpooled) connection string", () => {
    // Checklist 15 item 5: only drizzle.config.ts reads DATABASE_URL_UNPOOLED.
    const unpooled = "postgresql://owner:ownerpw@host.example.com/db";
    const env = parseEnv({ ...valid, DATABASE_URL_UNPOOLED: unpooled });
    expect(env).not.toHaveProperty("DATABASE_URL_UNPOOLED");
    expect(JSON.stringify(env)).not.toContain("ownerpw");
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
