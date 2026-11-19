import { describe, expect, it } from "vitest";
import type { GenerateAnswer } from "./generate-call";
import { buildGenerateBody, checkBeforeGenerate, newRun, nextStep, notesReady, withReplaceConfirmed, withThinConfirmed } from "./generate-flow";

const entry = (key: string, position: number) => ({ key, title: `Section ${key}`, position });

describe("one press is one run, and confirmations are never default", () => {
  it("a new run holds no confirmation, and the body then carries neither flag", () => {
    expect(newRun()).toEqual({ replaceEdited: false, confirm: false });
    expect(buildGenerateBody({ realMode: true, notes: "n", baseVersion: 2, run: newRun() })).toEqual({ baseVersion: 2, notes: "n" });
    expect(buildGenerateBody({ realMode: false, notes: "n", baseVersion: 0, run: newRun() })).toEqual({ baseVersion: 0 });
  });

  it("replaceEdited and confirm are separate: each only from its own choice, neither stands for the other", () => {
    const replaced = withReplaceConfirmed(newRun());
    expect(buildGenerateBody({ realMode: true, notes: "n", baseVersion: 1, run: replaced })).toEqual({ baseVersion: 1, notes: "n", replaceEdited: true });
    const thin = withThinConfirmed(newRun());
    expect(buildGenerateBody({ realMode: true, notes: "n", baseVersion: 1, run: thin })).toEqual({ baseVersion: 1, notes: "n", confirm: true });
    const both = withThinConfirmed(replaced);
    expect(buildGenerateBody({ realMode: true, notes: "n", baseVersion: 1, run: both })).toEqual({ baseVersion: 1, notes: "n", replaceEdited: true, confirm: true });
  });

  it("choosing never changes the earlier run (a run is a value), so the next press starts clean", () => {
    const first = newRun();
    withReplaceConfirmed(first);
    withThinConfirmed(first);
    expect(first).toEqual({ replaceEdited: false, confirm: false });
  });

  it("the stub body never carries notes or confirm (its strict body refuses them), but can carry replaceEdited", () => {
    const body = buildGenerateBody({ realMode: false, notes: "SECRET", baseVersion: 1, run: withThinConfirmed(withReplaceConfirmed(newRun())) });
    expect(body).toEqual({ baseVersion: 1, replaceEdited: true });
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });

  it("false is never sent: a flag is either true or absent", () => {
    for (const run of [newRun(), withReplaceConfirmed(newRun()), withThinConfirmed(newRun())]) {
      expect(JSON.stringify(buildGenerateBody({ realMode: true, notes: "n", baseVersion: 0, run }))).not.toContain("false");
    }
  });
});

describe("notesReady", () => {
  it("real mode needs notes that are not blank; stub needs none", () => {
    expect(notesReady(true, "")).toBe(false);
    expect(notesReady(true, "  \n\t ")).toBe(false);
    expect(notesReady(true, "a")).toBe(true);
    expect(notesReady(false, "")).toBe(true);
  });
});

describe("checkBeforeGenerate", () => {
  it("nothing unsaved: go", () => {
    expect(checkBeforeGenerate([], "a")).toEqual({ action: "go" });
  });
  it("unsaved text in the target section blocks, listing everything unsaved in page order, cursor to the target", () => {
    expect(checkBeforeGenerate([entry("c", 3), entry("a", 1)], "c")).toEqual({ action: "blocked", titles: ["Section a", "Section c"], firstKey: "c" });
  });
  it("unsaved text only elsewhere warns, cursor to the first unsaved box in page order", () => {
    expect(checkBeforeGenerate([entry("c", 3), entry("b", 2)], "a")).toEqual({ action: "warn", titles: ["Section b", "Section c"], firstKey: "b" });
  });
  it("carries titles and keys only", () => {
    expect(Object.keys(checkBeforeGenerate([entry("b", 2)], "a")).sort()).toEqual(["action", "firstKey", "titles"]);
  });
});

describe("nextStep: what each answer shows", () => {
  const next = (answer: GenerateAnswer, real = true) => nextStep(answer, real);

  it("generated: done, with the version and the flags", () => {
    expect(next({ kind: "generated", version: 2, flags: ["insufficient_input"] })).toEqual({ step: "done", version: 2, flags: ["insufficient_input"] });
  });
  it("thin notes: the warning, with what is missing, before anything was generated", () => {
    expect(next({ kind: "thin_notes", missing: ["quotes"], sensitive: true })).toEqual({ step: "ask_thin", missing: ["quotes"], sensitive: true });
  });
  it("edited text: the replace question", () => {
    expect(next({ kind: "edited_text" })).toEqual({ step: "ask_replace" });
  });
  it("failures: a fixed sentence, and a refresh only where the server's state may have moved", () => {
    const conflict = next({ kind: "failed", failure: { status: 409, code: "conflict" }, retryAfterSeconds: null });
    expect(conflict).toMatchObject({ step: "error", refresh: true });
    const notSet = next({ kind: "failed", failure: { status: 409, code: "inference_not_configured" }, retryAfterSeconds: null });
    expect(notSet).toMatchObject({ step: "error", refresh: false });
    const limit = next({ kind: "failed", failure: { status: 429, code: "rate_limited" }, retryAfterSeconds: 90 });
    expect(limit).toMatchObject({ step: "error", refresh: false });
    expect((limit as { message: string }).message).toMatch(/about 2 minutes/);
    expect(next({ kind: "failed", failure: { status: 502, code: "inference_failed" }, retryAfterSeconds: null })).toMatchObject({ refresh: true });
    expect(next({ kind: "failed", failure: null, retryAfterSeconds: null })).toMatchObject({ refresh: false });
  });
  it("a failure says the notes are kept in real mode only", () => {
    const fail: GenerateAnswer = { kind: "failed", failure: { status: 502, code: "inference_failed" }, retryAfterSeconds: null };
    expect((nextStep(fail, true) as { message: string }).message).toMatch(/notes are still here/);
    expect((nextStep(fail, false) as { message: string }).message).not.toMatch(/notes/);
  });
});
