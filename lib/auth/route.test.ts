import { describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/auth/[...all]/route";

// Requests outside the allow-list are answered before Better Auth (and so before any
// environment or database) is touched.
const call = (method: "GET" | "POST", path: string) =>
  (method === "GET" ? GET : POST)(new Request(`http://localhost:3000/api/auth${path}`, { method }));

describe("/api/auth route", () => {
  it.each([
    ["POST", "/sign-up/email"],
    ["GET", "/get-session"],
    ["GET", "/list-sessions"],
    ["POST", "/update-user"],
    ["GET", "/ok"],
    ["GET", "/"],
  ] as const)("answers 404 with a generic body for %s %s", async (method, path) => {
    const res = await call(method, path);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
  });

  it("exports only GET and POST, so every other method is 405", async () => {
    const mod = await import("@/app/api/auth/[...all]/route");
    expect(Object.keys(mod).sort()).toEqual(["GET", "POST"]);
  });
});
