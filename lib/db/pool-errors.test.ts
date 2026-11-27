import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachPoolErrorHandler, safePoolErrorCode } from "./pool-errors";

// Fake secrets and fake client data only. If any of them reaches a log line the test fails.
const SECRET_URL = "postgres://app_login:SECRETPW123@ep-fake-host-123.example.neon.tech/neondb";
const SECRET_QUERY = "select * from clients where display_name = $1";
const FORBIDDEN = ["SECRETPW123", "app_login", "ep-fake-host", "neon.tech", "select", "clients", "display_name", "Synthetic Client", "at Object", "stack"];

function dbError(code: unknown) {
  const error = new Error(`connect failed ${SECRET_URL} while running: ${SECRET_QUERY} ["Synthetic Client"]`) as Error & Record<string, unknown>;
  error.code = code;
  error.cause = new Error(SECRET_URL);
  error.query = SECRET_QUERY;
  error.parameters = ["Synthetic Client"];
  error.stack = `Error: ${SECRET_URL}\n    at Object.<anonymous> (stack frame)`;
  return error;
}

afterEach(() => vi.restoreAllMocks());

describe("why the handler exists", () => {
  it("control: an EventEmitter with no 'error' listener throws, which is what crashes a long-lived process", () => {
    expect(() => new EventEmitter().emit("error", dbError("57P01"))).toThrow();
  });
});

describe("attachPoolErrorHandler", () => {
  it("survives an idle-client error and logs one fixed event with only the SQLSTATE", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = new EventEmitter();
    attachPoolErrorHandler(pool, "app");

    expect(() => pool.emit("error", dbError("57P01"))).not.toThrow();

    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(JSON.parse(line)).toEqual({ event: "db_pool_error", pool: "app", code: "57P01" });
    for (const word of FORBIDDEN) expect(line, word).not.toContain(word);
    // Nothing else was written anywhere (no second argument, no console.log/warn with the error).
    expect(log.mock.calls[0]).toHaveLength(1);
  });

  it.each(["ECONNRESET", "ETIMEDOUT", "EPIPE"])("logs the allow-listed network code %s", (code) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = new EventEmitter();
    attachPoolErrorHandler(pool, "auth");
    pool.emit("error", dbError(code));
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({ event: "db_pool_error", pool: "auth", code });
  });

  it.each([
    ["a code outside the allow-list", "ENOTFOUND"],
    ["a code carrying a host", "getaddrinfo ENOTFOUND ep-fake-host-123.example.neon.tech"],
    ["a code carrying a secret", SECRET_URL],
    ["a lowercase five-character code", "abcde"],
    ["a six-character code", "57P011"],
    ["a number", 57014],
    ["no code", undefined],
  ])("logs 'unknown' for %s", (_label, code) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = new EventEmitter();
    attachPoolErrorHandler(pool, "app");
    expect(() => pool.emit("error", dbError(code))).not.toThrow();
    const line = String(log.mock.calls[0][0]);
    expect(JSON.parse(line)).toEqual({ event: "db_pool_error", pool: "app", code: "unknown" });
    for (const word of FORBIDDEN) expect(line, word).not.toContain(word);
  });

  it("copes with things that are not Error objects, and with a logger that throws", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = new EventEmitter();
    attachPoolErrorHandler(pool, "app");
    for (const value of [undefined, null, "a string with " + SECRET_URL, 42, {}]) expect(() => pool.emit("error", value)).not.toThrow();
    expect(log).toHaveBeenCalledTimes(5);
    for (const call of log.mock.calls) expect(JSON.parse(String(call[0])).code).toBe("unknown");

    log.mockImplementation(() => {
      throw new Error("stderr closed");
    });
    expect(() => pool.emit("error", dbError("57P01"))).not.toThrow();
  });

  it("reads the code from a wrapped cause too", () => {
    expect(safePoolErrorCode({ cause: { code: "08006" } })).toBe("08006");
    expect(safePoolErrorCode({ code: "unknown-shape", cause: { code: "08006" } })).toBe("unknown");
  });
});

describe("both real pools get the handler when they are created", () => {
  class FakePool extends EventEmitter {
    constructor(public options: { connectionString: string }) {
      super();
    }
  }

  async function load() {
    vi.resetModules();
    vi.doMock("@neondatabase/serverless", () => ({ Pool: FakePool }));
    vi.doMock("drizzle-orm/neon-serverless", () => ({ drizzle: (pool: unknown) => ({ pool }) }));
    vi.doMock("@/lib/env", () => ({
      getEnv: () => ({ DATABASE_URL: "postgres://fake:fake@127.0.0.1:1/fake" }),
      getAuthEnv: () => ({ AUTH_DATABASE_URL: "postgres://fake:fake@127.0.0.1:1/fake" }),
    }));
    const app = await import("./index");
    const auth = await import("./auth-db");
    return { app, auth };
  }

  it("getDb() and getAuthDb() each return a pool with exactly one 'error' listener, created once", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app, auth } = await load();
    const appPool = (app.getDb() as unknown as { pool: FakePool }).pool;
    const authPool = (auth.getAuthDb() as unknown as { pool: FakePool }).pool;
    expect(appPool.listenerCount("error")).toBe(1);
    expect(authPool.listenerCount("error")).toBe(1);
    // A second call reuses the pool and adds no second listener.
    expect((app.getDb() as unknown as { pool: FakePool }).pool).toBe(appPool);
    expect(appPool.listenerCount("error")).toBe(1);

    expect(() => appPool.emit("error", dbError("57P01"))).not.toThrow();
    expect(() => authPool.emit("error", dbError("ECONNRESET"))).not.toThrow();
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])))).toEqual([
      { event: "db_pool_error", pool: "app", code: "57P01" },
      { event: "db_pool_error", pool: "auth", code: "ECONNRESET" },
    ]);
  });
});
