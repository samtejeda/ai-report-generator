import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isPublicPath } from "@/lib/auth/public-surface";

// The route must answer with the database unreachable and the environment empty: that is the
// whole point of a liveness check that never wakes Neon.
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/db", () => {
  throw new Error("liveness must not import the database");
});

describe("GET /api/live", () => {
  it("answers 200 with the fixed body and nothing else", async () => {
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("does not reference the database, the environment or any config", () => {
    const src = readFileSync("app/api/live/route.ts", "utf8").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/lib\/db|getDb|tenantDb|getEnv|getAuthEnv|process\.env|lib\/auth/);
  });

  it("is on the public list, exactly (look-alikes are not)", () => {
    expect(isPublicPath("/api/live")).toBe(true);
    expect(isPublicPath("/api/live/")).toBe(true);
    expect(isPublicPath("/api/live/x")).toBe(false);
    expect(isPublicPath("/api/livex")).toBe(false);
  });
});
