import { describe, expect, it, vi } from "vitest";
import { createUnsavedStore, NO_UNSAVED } from "./unsaved-store";

const entry = (key: string, position = 1, title = `Section ${key}`) => ({ key, title, position });

describe("unsaved store: what is unsaved", () => {
  it("starts empty with a stable empty snapshot", () => {
    const s = createUnsavedStore();
    expect(s.getSnapshot()).toBe(NO_UNSAVED);
    expect(s.getSnapshot()).toBe(s.getSnapshot());
  });

  it("register adds, the returned function clears, and every change tells subscribers", () => {
    const s = createUnsavedStore();
    const seen = vi.fn();
    s.subscribe(seen);
    const clear = s.register(entry("a"));
    expect(s.getSnapshot().map((e) => e.key)).toEqual(["a"]);
    expect(seen).toHaveBeenCalledTimes(1);
    clear();
    expect(s.getSnapshot()).toBe(NO_UNSAVED);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("the snapshot keeps its identity until something changes (useSyncExternalStore needs that)", () => {
    const s = createUnsavedStore();
    s.register(entry("a"));
    const first = s.getSnapshot();
    s.register(entry("a")); // same entry again: no change
    expect(s.getSnapshot()).toBe(first);
    s.register(entry("b", 2));
    expect(s.getSnapshot()).not.toBe(first);
  });

  it("lists sections in page order, not typing order", () => {
    const s = createUnsavedStore();
    s.register(entry("c", 3));
    s.register(entry("a", 1));
    s.register(entry("b", 2));
    expect(s.getSnapshot().map((e) => e.key)).toEqual(["a", "b", "c"]);
  });

  it("clearing twice, or clearing something that was replaced, is harmless", () => {
    const s = createUnsavedStore();
    const clear = s.register(entry("a"));
    clear();
    clear();
    expect(s.getSnapshot()).toBe(NO_UNSAVED);
  });

  it("registering the same section again with a new title updates it", () => {
    const s = createUnsavedStore();
    s.register(entry("a", 1, "Old"));
    s.register(entry("a", 1, "New"));
    expect(s.getSnapshot().map((e) => e.title)).toEqual(["New"]);
  });

  it("an unsubscribed listener hears nothing more", () => {
    const s = createUnsavedStore();
    const seen = vi.fn();
    const off = s.subscribe(seen);
    off();
    s.register(entry("a"));
    expect(seen).not.toHaveBeenCalled();
  });

  it("holds titles and keys only, never text", () => {
    const s = createUnsavedStore();
    s.register(entry("a"));
    expect(Object.keys(s.getSnapshot()[0]).sort()).toEqual(["key", "position", "title"]);
  });
});

describe("unsaved store: asking before leaving", () => {
  it("nothing unsaved: leaving is fine at once and no dialog is requested", async () => {
    const s = createUnsavedStore();
    expect(await s.askBeforeLeaving()).toBe(true);
    expect(s.getPending()).toBeNull();
  });

  it("something unsaved: opens a request listing the sections, and 'stay' answers false", async () => {
    const s = createUnsavedStore();
    s.register(entry("b", 2));
    s.register(entry("a", 1));
    const answer = s.askBeforeLeaving();
    expect(s.getPending()?.sections.map((e) => e.key)).toEqual(["a", "b"]);
    s.answer(false);
    expect(await answer).toBe(false);
    expect(s.getPending()).toBeNull();
    expect(s.unloadAllowed()).toBe(false);
  });

  it("'leave' answers true and, for a moment, keeps the browser's own box out of the way", async () => {
    let t = 1000;
    const s = createUnsavedStore(() => t);
    s.register(entry("a"));
    const answer = s.askBeforeLeaving();
    s.answer(true);
    expect(await answer).toBe(true);
    expect(s.unloadAllowed()).toBe(true);
    t += 1999;
    expect(s.unloadAllowed()).toBe(true);
    t += 2;
    expect(s.unloadAllowed()).toBe(false);
  });

  it("a second ask while the dialog is open shares the same answer instead of stacking another", async () => {
    const s = createUnsavedStore();
    s.register(entry("a"));
    const first = s.askBeforeLeaving();
    const pending = s.getPending();
    const second = s.askBeforeLeaving();
    expect(s.getPending()).toBe(pending);
    s.answer(false);
    expect(await Promise.all([first, second])).toEqual([false, false]);
  });

  it("after an answer the next ask starts fresh", async () => {
    const s = createUnsavedStore();
    s.register(entry("a"));
    const one = s.askBeforeLeaving();
    s.answer(false);
    await one;
    const two = s.askBeforeLeaving();
    expect(s.getPending()).not.toBeNull();
    s.answer(true);
    expect(await two).toBe(true);
  });

  it("answering with nothing pending does nothing", () => {
    const s = createUnsavedStore();
    expect(() => s.answer(true)).not.toThrow();
    expect(s.unloadAllowed()).toBe(false);
  });

  it("allowUnload (used right before an agreed full page load, e.g. after signing out) has the same grace", () => {
    let t = 0;
    const s = createUnsavedStore(() => t);
    expect(s.unloadAllowed()).toBe(false);
    s.allowUnload();
    expect(s.unloadAllowed()).toBe(true);
    t = 5000;
    expect(s.unloadAllowed()).toBe(false);
  });

  it("the dialog lists the sections that were unsaved when it was asked, even if one is saved while it is open", async () => {
    const s = createUnsavedStore();
    const clear = s.register(entry("a", 1));
    s.register(entry("b", 2));
    const answer = s.askBeforeLeaving();
    clear();
    expect(s.getPending()?.sections.map((e) => e.key)).toEqual(["a", "b"]);
    s.answer(false);
    await answer;
  });

  it("tells subscribers when a request opens and when it is answered", () => {
    const s = createUnsavedStore();
    s.register(entry("a"));
    const seen = vi.fn();
    s.subscribe(seen);
    void s.askBeforeLeaving();
    expect(seen).toHaveBeenCalledTimes(1);
    s.answer(false);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
