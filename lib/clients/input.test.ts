import { describe, expect, it } from "vitest";
import { AUDIT_CLIENT_FIELDS } from "@/lib/audit";
import { auditFieldList, isPlausibleDateOfBirth, parseClientCreate, parseClientPatch } from "./input";

const now = new Date("2026-10-21T12:00:00Z");
const ok = { displayName: "Test Client A" };

describe("parseClientCreate", () => {
  it("accepts the four D6 fields and normalizes optional ones to null", () => {
    expect(parseClientCreate(ok, now)).toEqual({ ok: true, value: { displayName: "Test Client A", dateOfBirth: null, gradeLevel: null, externalId: null } });
    expect(parseClientCreate({ displayName: "  Test Client B ", dateOfBirth: "2016-02-29", gradeLevel: "PreK", externalId: "X-1" }, now)).toEqual({
      ok: true,
      value: { displayName: "Test Client B", dateOfBirth: "2016-02-29", gradeLevel: "PreK", externalId: "X-1" },
    });
  });

  it.each([
    ["no name", {}],
    ["empty name", { displayName: "   " }],
    ["name too long", { displayName: "x".repeat(201) }],
    ["control character in name", { displayName: "a\u0000b" }],
    ["newline in name", { displayName: "a\nb" }],
    ["name not a string", { displayName: 5 }],
    ["not a date", { ...ok, dateOfBirth: "tomorrow" }],
    ["impossible date", { ...ok, dateOfBirth: "2015-02-30" }],
    ["non-leap 29 Feb", { ...ok, dateOfBirth: "2015-02-29" }],
    ["wrong format", { ...ok, dateOfBirth: "2015-2-3" }],
    ["future date", { ...ok, dateOfBirth: "2026-10-22" }],
    ["before 1900", { ...ok, dateOfBirth: "1899-12-31" }],
    ["grade with punctuation", { ...ok, gradeLevel: "3; drop" }],
    ["grade too long", { ...ok, gradeLevel: "1".repeat(21) }],
    ["empty grade", { ...ok, gradeLevel: "" }],
    ["empty external id", { ...ok, externalId: " " }],
    ["external id too long", { ...ok, externalId: "x".repeat(65) }],
    ["organizationId", { ...ok, organizationId: "11111111-1111-4111-8111-111111111111" }],
    ["id", { ...ok, id: "11111111-1111-4111-8111-111111111111" }],
    ["deletedAt", { ...ok, deletedAt: null }],
    ["address (not a D6 field)", { ...ok, address: "1 Main St" }],
    ["array", [ok]],
    ["null", null],
    ["string", "x"],
  ])("refuses %s", (_label, body) => {
    expect(parseClientCreate(body, now)).toEqual({ ok: false });
  });
});

describe("parseClientPatch", () => {
  it("takes any subset, and null clears an optional field", () => {
    expect(parseClientPatch({ gradeLevel: null }, now)).toEqual({ ok: true, value: { gradeLevel: null } });
    expect(parseClientPatch({ displayName: "New Name", externalId: "Z9" }, now)).toEqual({ ok: true, value: { displayName: "New Name", externalId: "Z9" } });
  });
  it.each([
    ["empty object", {}],
    ["null name", { displayName: null }],
    ["unknown key", { nickname: "x" }],
    ["organizationId", { organizationId: "11111111-1111-4111-8111-111111111111" }],
    ["bad date", { dateOfBirth: "2999-01-01" }],
  ])("refuses %s", (_label, body) => {
    expect(parseClientPatch(body, now)).toEqual({ ok: false });
  });
});

describe("isPlausibleDateOfBirth", () => {
  it("includes today and 1900-01-01, excludes tomorrow", () => {
    expect(isPlausibleDateOfBirth("2026-10-21", now)).toBe(true);
    expect(isPlausibleDateOfBirth("1900-01-01", now)).toBe(true);
    expect(isPlausibleDateOfBirth("2026-10-22", now)).toBe(false);
  });
});

describe("auditFieldList", () => {
  it("only produces names from the audit allow-list", () => {
    const all = auditFieldList(["displayName", "dateOfBirth", "gradeLevel", "externalId"]).split(",");
    expect(all.sort()).toEqual([...AUDIT_CLIENT_FIELDS].sort());
  });
});
