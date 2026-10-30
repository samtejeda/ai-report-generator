import { describe, expect, it } from "vitest";
import { formatLocal, formatUtc, UNKNOWN_TIME } from "./format-time";

describe("formatUtc", () => {
  it("prints the instant in UTC with the zone named", () => {
    expect(formatUtc("2026-10-30T19:14:59.123Z")).toBe("2026-10-30 19:14 UTC");
  });
  it("does not depend on the machine's zone", () => {
    expect(formatUtc("2026-01-01T00:00:00+05:00")).toBe("2025-12-31 19:00 UTC");
  });
  it("says so for something that is not a date", () => {
    expect(formatUtc("not a date")).toBe(UNKNOWN_TIME);
    expect(formatUtc("")).toBe(UNKNOWN_TIME);
  });
});

describe("formatLocal", () => {
  it("prints the same instant, in the viewer's zone", () => {
    const text = formatLocal("2026-10-30T19:14:00Z");
    expect(text).toMatch(/2026/);
    expect(text).not.toBe(UNKNOWN_TIME);
  });
  it("says so for something that is not a date", () => {
    expect(formatLocal("nope")).toBe(UNKNOWN_TIME);
  });
});
