import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Structural rules for the inference code, enforced by reading the source (the same approach as the
 * model-ID scan in models.test.ts). They keep the single-entry-point and no-fallback promises true
 * as the code grows.
 */

const root = path.resolve(import.meta.dirname, "..", "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" || name === ".next" ? [] : walk(full);
    return /\.(ts|tsx|mts)$/.test(name) ? [full] : [];
  });
}

const rel = (f: string) => path.relative(root, f);
// Rules are about code, not about words in comments that explain them.
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const source = (dirs: string[]) =>
  dirs
    .flatMap((d) => walk(path.join(root, d)))
    .filter((f) => !/\.test\.tsx?$/.test(f))
    .map((f) => ({ file: rel(f), text: stripComments(readFileSync(f, "utf8")) }));

const all = source(["lib", "app", "components"]);
const aiFiles = all.filter((f) => f.file.startsWith(path.join("lib", "ai") + path.sep));
const pipelineFiles = aiFiles.filter((f) => f.file.startsWith(path.join("lib", "ai", "pipeline") + path.sep));

describe("one door to the model", () => {
  it("only lib/ai/inference.ts imports the AI SDK, so only it can send a prompt to a model", () => {
    const offenders = all.filter((f) => /from\s+["'](ai|@ai-sdk\/[^"']+)["']/.test(f.text)).map((f) => f.file);
    expect(offenders).toEqual([path.join("lib", "ai", "inference.ts")]);
  });

  it("nothing outside lib/ai uses the pipeline yet (the route is not wired to it in this change)", () => {
    const offenders = all
      .filter((f) => !f.file.startsWith(path.join("lib", "ai") + path.sep))
      .filter((f) => /\brunPipeline\b|\blib\/ai\/pipeline\b|\blib\/ai\/prompt-loader\b/.test(f.text))
      // The integration test imports the loader directly; it is a test, so it is excluded above.
      .map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it("the pipeline modules reach no network, database, SDK or inference.ts: the model is injected", () => {
    const bad = /from\s+["'](ai|@ai-sdk\/[^"']+|@\/lib\/ai\/inference|\.\.?\/(\.\.\/)?inference|@\/lib\/db[^"']*|@neondatabase\/[^"']+)["']|\bfetch\s*\(/;
    expect(pipelineFiles.filter((f) => bad.test(f.text)).map((f) => f.file)).toEqual([]);
  });
});

describe("no fallback and no leaks", () => {
  it("no cloud provider is imported or addressed anywhere in lib/ai", () => {
    const cloud = /@ai-sdk\/(openai(?!-compatible)|anthropic|google|azure|bedrock|vertex|mistral|cohere|groq|xai)\b|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis|openrouter/i;
    expect(aiFiles.filter((f) => cloud.test(f.text)).map((f) => f.file)).toEqual([]);
  });

  it("lib/ai never logs: prompts and model output must not reach a log", () => {
    const logging = /\bconsole\.(log|info|warn|error|debug|trace)\b|\blogger\b|\bSentry\b/;
    expect(aiFiles.filter((f) => logging.test(f.text)).map((f) => f.file)).toEqual([]);
  });

  it("lib/ai does not read process.env directly (configuration goes through getEnv)", () => {
    expect(aiFiles.filter((f) => /process\.env/.test(f.text)).map((f) => f.file)).toEqual([]);
  });
});
