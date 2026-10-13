import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { MODELS, resolveModel } from "./models";

describe("resolveModel", () => {
  it("returns the default for each role", () => {
    expect(resolveModel("stub")).toBe(MODELS.stub);
    expect(resolveModel("worker")).toBe(MODELS.worker);
    expect(resolveModel("heavy")).toBe(MODELS.heavy);
  });

  it("prefers the organization override for that role only", () => {
    const overrides = { worker: "custom-worker:1b" };
    expect(resolveModel("worker", overrides)).toBe("custom-worker:1b");
    expect(resolveModel("filter", overrides)).toBe(MODELS.filter);
  });

  it("rejects a malformed override instead of falling back", () => {
    expect(() => resolveModel("worker", { worker: "bad model; rm" })).toThrow(/Invalid model override/);
    expect(() => resolveModel("worker", { worker: "" })).toThrow(/Invalid model override/);
  });
});

describe("no hardcoded model IDs in feature code", () => {
  const root = path.resolve(import.meta.dirname, "..", "..");
  const scanned = ["lib", "app", "components"];
  const idPattern = /\b(qwen\d*|gemma\d*|llama\d*|mistral|phi\d)[:\-][\w.\-]+/i;

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  }

  it("keeps model IDs in lib/ai/models.ts only (tests excluded)", () => {
    const offenders = scanned
      .flatMap((d) => walk(path.join(root, d)))
      .filter((f) => !f.endsWith(path.join("lib", "ai", "models.ts")) && !/\.test\.tsx?$/.test(f))
      .filter((f) => idPattern.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(root, f));
    expect(offenders).toEqual([]);
  });
});
