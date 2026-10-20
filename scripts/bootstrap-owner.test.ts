import { describe, expect, it } from "vitest";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/auth/config";
import { bootstrapOwner, generateTemporaryPassword } from "./bootstrap-owner.mjs";

describe("temporary password", () => {
  it("is long, random, readable and within the app's password policy", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generateTemporaryPassword();
      expect(p).toMatch(/^([a-hj-km-np-z2-9]{5}-){4}[a-hj-km-np-z2-9]{5}$/); // no 0, o, 1, l, i look-alikes
      expect(p.length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
      expect(p.length).toBeLessThanOrEqual(PASSWORD_MAX_LENGTH);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });
});

describe("input is validated before any database work", () => {
  // A pool that fails the test if it is touched: bad input must never reach the database.
  const untouched = { connect: () => Promise.reject(new Error("the database must not be contacted")) };
  const good = { org: "Synthetic Practice", email: "owner@example.test", name: "Synthetic Owner" };

  it.each([
    ["an empty practice name", { ...good, org: "   " }, "invalid_org"],
    ["a very long practice name", { ...good, org: "x".repeat(201) }, "invalid_org"],
    ["a missing practice name", { ...good, org: undefined }, "invalid_org"],
    ["an address without an @", { ...good, email: "owner.example.test" }, "invalid_email"],
    ["an address with a space", { ...good, email: "own er@example.test" }, "invalid_email"],
    ["an empty address", { ...good, email: "" }, "invalid_email"],
    ["an over-long address", { ...good, email: `${"a".repeat(250)}@example.test` }, "invalid_email"],
    ["an empty name", { ...good, name: "" }, "invalid_name"],
    ["a very long name", { ...good, name: "n".repeat(201) }, "invalid_name"],
    ["a state that is not two letters", { ...good, state: "Rhode Island" }, "invalid_state"],
    ["a state with a digit", { ...good, state: "R1" }, "invalid_state"],
  ])("%s is refused", async (_label, input, status) => {
    for (const apply of [false, true]) expect(await bootstrapOwner(untouched, input, { apply })).toEqual({ status });
  });
});
