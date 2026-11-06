import { describe, expect, it } from "vitest";
import { addressBucket, NO_TRUSTED_ADDRESS } from "./address-bucket";

describe("addressBucket (what a per-address limit counts under)", () => {
  it("IPv4 is the address itself, and an IPv4-mapped IPv6 address is the IPv4 it carries", () => {
    expect(addressBucket("203.0.113.9")).toBe("203.0.113.9");
    expect(addressBucket("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("IPv6 is reduced to its /64, however it is written", () => {
    const expected = "2001:0db8:0000:0017::/64";
    for (const v of ["2001:db8:0:17::1", "2001:DB8:0:17:ffff:ffff:ffff:ffff", "2001:0db8:0000:0017:0000:0000:0000:0001", "2001:db8:0:17::"]) expect(addressBucket(v), v).toBe(expected);
    expect(addressBucket("::1")).toBe("0000:0000:0000:0000::/64");
    expect(addressBucket("2001:db8:0:18::1")).not.toBe(expected);
  });

  it("no usable address is one shared bucket (fail closed), never an empty or per-request key", () => {
    for (const v of [undefined, null, "", "  ", "unknown", "not-an-ip", "1:2:3", "1::2::3", "1:2:3:4:5:6:7:8:9", "2001:db8::zzzz", "::1.2.3.4"]) {
      expect(addressBucket(v as string | undefined), String(v)).toBe(NO_TRUSTED_ADDRESS);
    }
  });
});
