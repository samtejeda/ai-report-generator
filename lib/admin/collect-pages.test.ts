import { describe, expect, it } from "vitest";
import { collectPages } from "./collect-pages";

const source = (n: number) => {
  const calls: [number, number][] = [];
  const fetchPage = async (offset: number, limit: number) => {
    calls.push([offset, limit]);
    return Array.from({ length: Math.max(0, Math.min(limit, n - offset)) }, (_, i) => offset + i);
  };
  return { fetchPage, calls };
};

describe("collectPages", () => {
  it("reads one short page and stops", async () => {
    const s = source(3);
    expect(await collectPages(s.fetchPage)).toEqual({ items: [0, 1, 2], truncated: false });
    expect(s.calls).toEqual([[0, 100]]);
  });
  it("returns nothing for an empty list", async () => {
    expect(await collectPages(source(0).fetchPage)).toEqual({ items: [], truncated: false });
  });
  it("reads past one page (the 101st row is not hidden)", async () => {
    const s = source(250);
    const r = await collectPages(s.fetchPage);
    expect(r.items).toHaveLength(250);
    expect(r.items[100]).toBe(100);
    expect(r.truncated).toBe(false);
    expect(s.calls).toEqual([[0, 100], [100, 100], [200, 100]]);
  });
  it("exactly the cap is not truncated", async () => {
    const r = await collectPages(source(500).fetchPage);
    expect(r.items).toHaveLength(500);
    expect(r.truncated).toBe(false);
  });
  it("one more than the cap is truncated and cut to the cap", async () => {
    const s = source(501);
    const r = await collectPages(s.fetchPage);
    expect(r.items).toHaveLength(500);
    expect(r.truncated).toBe(true);
    expect(s.calls.at(-1)).toEqual([500, 1]);
  });
  it("never asks the source for more than the page size", async () => {
    const s = source(10_000);
    await collectPages(s.fetchPage, { pageSize: 50, cap: 120 });
    expect(Math.max(...s.calls.map(([, l]) => l))).toBe(50);
  });
});
