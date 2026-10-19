import { describe, expect, it } from "vitest";
import { parseAuthEnv, parseEnv } from "./env";

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

describe("parseAuthEnv", () => {
  const auth = {
    AUTH_DATABASE_URL: "postgresql://auth_user:pw@host-pooler.example.com/db",
    BETTER_AUTH_SECRET: "x".repeat(32),
    BETTER_AUTH_URL: "http://localhost:3000",
  };

  it("accepts a valid environment and defaults to the console transport outside production", () => {
    const env = parseAuthEnv(auth);
    expect(env.EMAIL_TRANSPORT).toBe("console");
    expect(env.NODE_ENV).toBe("development");
  });

  it("names each missing variable", () => {
    expect(() => parseAuthEnv({})).toThrow(/AUTH_DATABASE_URL:.*BETTER_AUTH_SECRET:.*BETTER_AUTH_URL:/);
  });

  it("rejects a short signing secret without echoing it", () => {
    const short = "too-short-secret";
    let message = "";
    try {
      parseAuthEnv({ ...auth, BETTER_AUTH_SECRET: short });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("BETTER_AUTH_SECRET");
    expect(message).not.toContain(short);
  });

  it("refuses the console email transport in production (reset links must never reach logs)", () => {
    expect(() => parseAuthEnv({ ...auth, NODE_ENV: "production" })).toThrow(/EMAIL_TRANSPORT/);
  });

  it("is independent of the app schema: the app schema neither needs nor exposes auth variables", () => {
    const env = parseEnv({ DATABASE_URL: "postgresql://user:pw@host-pooler.example.com/db", ...auth });
    expect(env).not.toHaveProperty("AUTH_DATABASE_URL");
    expect(env).not.toHaveProperty("BETTER_AUTH_SECRET");
  });
});
